import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import Outlet from '../models/Outlet.js';
import { cloudinary } from '../cloudinary/index.js';
import logger from '../utils/logger.js';
import { getIo } from '../utils/socket.js';
import { euclideanDistance, averageDescriptors } from '../utils/faceMath.js';
import {
    DEFAULT_TZ,
    formatDateKey,
    toDayStartUtcMs,
    computeShiftMetrics,
} from '../utils/attendanceTime.js';
import { getBusinessDate } from '../utils/businessDate.js';
import {
    ATTENDANCE_STATES,
    createManualBatchId,
    inferManualTimesFromShift,
    recordAttendancePunch,
    upsertManualAttendance,
    upsertManualAttendanceBatch,
} from '../services/attendance.service.js';
import { attendanceCaptureAccessError } from '../services/attendanceAccess.service.js';
import { getAttendanceShiftCorrectionContext, correctAttendanceShift } from '../services/attendanceShiftCorrection.service.js';

const getOutletFromCode = async (outletCode) => {
    if (!outletCode) return null;
    return Outlet.findOne({ code: String(outletCode).trim().toUpperCase() }).select('_id code').lean();
};

const normalizePhone = (value = '') => String(value).replace(/\D/g, '');
// GET /api/pos/attendance/employee/:employeeId/records?month=YYYY-MM

// Date/shift helpers (DEFAULT_TZ, formatDateKey, toDayStartUtcMs,
// computeShiftMetrics) now live in ../utils/attendanceTime.js so the Hikvision
// device webhook can reuse the exact same timezone logic.

// Vote-based matcher tuned for face-api.js FaceNet 128-d embeddings.
// face-api's default FaceMatcher accepts at distance 0.6 — we're stricter on
// the average distance, but tolerate 1–2 noisy probes via majority voting.
const FACEID_AVG_DIST_ACCEPT = 0.50;          // mean of per-probe min distances
const FACEID_PROBE_VOTE_DIST = 0.55;          // a probe "votes" if its best distance ≤ this
const FACEID_MIN_VOTE_RATIO = 0.6;            // ≥ 60% of probes must vote
const FACEID_MIN_SCORE_MARGIN = 0.06;         // winner must beat runner-up by this much (avg dist)
const FACEID_SINGLE_CANDIDATE_STRICT = 0.45;  // hard cap when only 1 candidate is enrolled
const FACEID_BAIL_OUT_DIST = 1.0;             // candidates whose best probe > this are clearly not a match
// O(N) centroid pre-filter. A probe whose distance to the candidate's
// precomputed centroid exceeds this can't possibly match — skip the full
// per-descriptor scoring entirely. ~120ms saved per 100 candidates on
// commodity hardware.
const FACEID_CENTROID_BAIL = 0.85;

// ─── Enhanced-attendance liveness gate ──────────────────────────────────────
// When the outlet has `attendanceLiveness` enabled, camera check-ins must
// carry proof that the client-side blink + head-turn challenge passed. This is
// a deterrent layered on the existing client-capture / server-match model — it
// is not cryptographic proof — but it closes the "hold up a photo" bypass for
// the normal camera flow. When the flag is OFF, this is a complete no-op.
const parseLiveness = (raw) => {
    if (!raw || typeof raw !== 'object') return { passed: false, challenge: null };
    return {
        passed: raw.passed === true,
        challenge: typeof raw.challenge === 'string' ? raw.challenge.slice(0, 40) : null,
    };
};

const captureAccessError = (req, employee, camera = false) => attendanceCaptureAccessError({
    tenant: req.tenant,
    employee,
    outletConstraints: [
        req.attendanceDevice?.outletId || req.attendanceDevice?.outletCode,
        req.user?.outletRef || req.user?.outletCode || req.user?.outlet,
        req.body?.outletId || req.body?.outlet,
    ],
    camera,
    livenessPassed: parseLiveness(req.body?.liveness).passed,
});

const sendCaptureAccessError = (res, error) => res.status(error.status).json({
    success: false, code: error.code, message: error.message,
});

const captureResult = (attendance, action) => ({
    action,
    checkInAt: attendance.checkInAt,
    checkOutAt: attendance.checkOutAt,
    businessDate: attendance.businessDate,
    timezone: attendance.timezone,
});

const normalizeDescriptors = (descriptors) => {
    const normalizedDescriptors = Array.isArray(descriptors) ? descriptors : [];
    if (normalizedDescriptors.length === 0) {
        return { error: 'At least one face descriptor is required.', validDescriptors: [] };
    }

    const validDescriptors = normalizedDescriptors
        .map((descriptor) => Array.isArray(descriptor) ? descriptor.map((value) => Number(value)) : null)
        .filter((descriptor) => Array.isArray(descriptor) && descriptor.length === 128 && descriptor.every((value) => Number.isFinite(value)));

    if (validDescriptors.length === 0) {
        return { error: 'Each face descriptor must be a numeric array of length 128.', validDescriptors: [] };
    }

    // 1+ probe accepted — the frontend now sends 6+ rapid samples in a
    // single-pose burst; even 1 valid descriptor (last-resort) is allowed.
    return { error: null, validDescriptors };
};

// For each probe descriptor, find the closest enrolled descriptor for this
// candidate. Returns vote-aware metrics so the matcher can tolerate one or
// two bad probes when the rest are clean. Lower avgDist = better match.
const scoreCandidateDescriptors = (probeDescriptors = [], knownDescriptors = []) => {
    if (!Array.isArray(probeDescriptors) || !probeDescriptors.length
        || !Array.isArray(knownDescriptors) || !knownDescriptors.length) {
        return {
            avgDist: Number.POSITIVE_INFINITY,
            minProbeDist: Number.POSITIVE_INFINITY,
            voteRatio: 0,
            sampleCount: 0,
        };
    }

    let votes = 0;
    let minProbeDist = Number.POSITIVE_INFINITY;
    const bestPerProbe = new Array(probeDescriptors.length);

    for (let p = 0; p < probeDescriptors.length; p += 1) {
        const probe = probeDescriptors[p];
        let best = Number.POSITIVE_INFINITY;
        for (const known of knownDescriptors) {
            const dist = euclideanDistance(probe, known);
            if (dist < best) best = dist;
        }
        bestPerProbe[p] = best;
        if (best < minProbeDist) minProbeDist = best;
        if (best <= FACEID_PROBE_VOTE_DIST) votes += 1;
    }

    // Trimmed mean: drop the single worst probe when we have ≥ 4 probes.
    // This makes the average robust against one motion-blur outlier without
    // throwing it out entirely.
    let avgDist;
    if (bestPerProbe.length >= 4) {
        const sorted = [...bestPerProbe].sort((a, b) => a - b);
        const trimmed = sorted.slice(0, sorted.length - 1);
        avgDist = trimmed.reduce((s, d) => s + d, 0) / trimmed.length;
    } else {
        avgDist = bestPerProbe.reduce((s, d) => s + d, 0) / bestPerProbe.length;
    }

    return {
        avgDist,
        minProbeDist,
        voteRatio: votes / probeDescriptors.length,
        sampleCount: probeDescriptors.length,
    };
};

const resolveFaceMatch = async ({ req, outlet, validDescriptors }) => {
    // IMPORTANT: do NOT filter by isActive at query time. We must evaluate the
    // closest enrolled employee across the whole fleet — otherwise, when the
    // real owner of the face is inactive, the algorithm silently rolls forward
    // to the next-closest active employee and reports a wrong identity.
    const filter = {
        isFaceEnrolled: true,
        'faceDescriptors.0': { $exists: true },
    };

    if (outlet) {
        const resolvedOutlet = await getOutletFromCode(outlet);
        if (!resolvedOutlet) {
            return { errorStatus: 404, errorMessage: 'Outlet not found.' };
        }
        filter.outlet = resolvedOutlet._id;
    } else if (req.attendanceDevice?.outletId) {
        // Paired device with an outlet binding — scope candidates to that
        // outlet only. Dramatically narrows the search on a multi-outlet
        // tenant and prevents accidental cross-outlet matches.
        if (mongoose.isValidObjectId(req.attendanceDevice.outletId)) {
            filter.outlet = new mongoose.Types.ObjectId(req.attendanceDevice.outletId);
        }
    } else if (req.user?.outletRef) {
        filter.outlet = req.user.outletRef;
    } else if (req.user?.outletCode) {
        const resolvedOutlet = await getOutletFromCode(req.user.outletCode);
        if (resolvedOutlet) {
            filter.outlet = resolvedOutlet._id;
        }
    }

    const candidates = await Employee.find(filter)
        .select('_id name phone designation department outlet faceDescriptors faceCentroid isActive')
        .populate('outlet', 'code')
        .lean();

    if (candidates.length === 0) {
        return { errorStatus: 404, errorMessage: 'No enrolled employees available for face recognition.' };
    }

    let bestEmployee = null;
    let bestAvg = Number.POSITIVE_INFINITY;
    let bestVoteRatio = 0;
    let secondBestAvg = Number.POSITIVE_INFINITY;
    const centroidBackfills = [];

    const firstProbe = validDescriptors[0];

    for (const candidate of candidates) {
        const knownDescriptors = Array.isArray(candidate.faceDescriptors) ? candidate.faceDescriptors : [];
        if (knownDescriptors.length === 0) continue;

        // O(N) centroid pre-filter. If the candidate has a precomputed
        // centroid, one cheap distance computation tells us whether to even
        // bother with the full per-descriptor scoring. Legacy employees
        // without a centroid get one computed inline and saved back.
        let centroid = Array.isArray(candidate.faceCentroid) && candidate.faceCentroid.length === 128
            ? candidate.faceCentroid
            : null;
        if (!centroid) {
            centroid = averageDescriptors(knownDescriptors);
            if (centroid) centroidBackfills.push({ id: candidate._id, centroid });
        }
        if (centroid) {
            const centroidDist = euclideanDistance(firstProbe, centroid);
            if (centroidDist > FACEID_CENTROID_BAIL) continue;
        }

        // Secondary cheap bail-out (kept for paranoid safety).
        const cheapDist = euclideanDistance(firstProbe, knownDescriptors[0]);
        if (cheapDist > FACEID_BAIL_OUT_DIST) continue;

        const { avgDist, minProbeDist, voteRatio } = scoreCandidateDescriptors(validDescriptors, knownDescriptors);

        if (avgDist < bestAvg) {
            secondBestAvg = bestAvg;
            bestAvg = avgDist;
            bestVoteRatio = voteRatio;
            bestEmployee = candidate;
        } else if (avgDist < secondBestAvg) {
            secondBestAvg = avgDist;
        }
        logger.info(`[FaceMatch] cand=${candidate.name} active=${candidate.isActive} avg=${avgDist.toFixed(4)} min=${minProbeDist.toFixed(4)} votes=${(voteRatio * 100).toFixed(0)}%`);
    }

    // Backfill missing centroids in the background so the next match is
    // even faster. Fire-and-forget — never blocks the response.
    if (centroidBackfills.length > 0) {
        Employee.bulkWrite(
            centroidBackfills.map(({ id, centroid }) => ({
                updateOne: { filter: { _id: id }, update: { $set: { faceCentroid: centroid } } },
            })),
            { ordered: false }
        ).catch((err) => logger.warn(`Centroid backfill failed: ${err.message}`));
    }

    // Convert avg euclidean distance to a 0–1 confidence (face-api.js max
    // meaningful distance is ~2.0; clamp to 0–1).
    const matchScore = Math.max(0, Math.min(1, 1 - bestAvg / 2));

    const onlyOneCandidate = candidates.length === 1;
    const aboveAvg = bestAvg > FACEID_AVG_DIST_ACCEPT;
    const lowVotes = bestVoteRatio < FACEID_MIN_VOTE_RATIO;
    const ambiguousMatch = !onlyOneCandidate && (secondBestAvg - bestAvg) < FACEID_MIN_SCORE_MARGIN;
    const singleStrictFail = onlyOneCandidate && bestAvg > FACEID_SINGLE_CANDIDATE_STRICT;

    logger.info(`[FaceMatch] best=${bestEmployee?.name} avg=${bestAvg.toFixed(4)} second=${secondBestAvg === Number.POSITIVE_INFINITY ? 'N/A' : secondBestAvg.toFixed(4)} votes=${(bestVoteRatio * 100).toFixed(0)}% onlyOne=${onlyOneCandidate}`);

    if (!bestEmployee || aboveAvg || lowVotes || ambiguousMatch || singleStrictFail) {
        logger.info(`[FaceMatch] REJECTED — aboveAvg=${aboveAvg} lowVotes=${lowVotes} ambiguous=${ambiguousMatch} strictSingle=${singleStrictFail}`);
        return {
            errorStatus: 422,
            errorMessage: 'No matching profile found. Please try again.',
            matchScore: Number(matchScore.toFixed(4)),
        };
    }

    // The closest enrolled face IS the inactive employee. Refuse to fall
    // through to any other employee — this is the bug that previously caused
    // the wrong profile to be returned. Treat as "no profile found".
    if (!bestEmployee.isActive) {
        logger.info(`[FaceMatch] REJECTED — best match employee=${bestEmployee.name} (${bestEmployee._id}) is inactive; refusing to fall through to next-closest profile.`);
        return {
            errorStatus: 404,
            errorMessage: 'No matching profile found. Please contact your administrator.',
            matchScore: Number(matchScore.toFixed(4)),
        };
    }

    const accessError = captureAccessError(req, bestEmployee, true);
    if (accessError) {
        return { errorStatus: accessError.status, errorCode: accessError.code, errorMessage: accessError.message };
    }

    logger.info(`[FaceMatch] ACCEPTED — employee=${bestEmployee.name} avg=${bestAvg.toFixed(4)} votes=${(bestVoteRatio * 100).toFixed(0)}% score=${matchScore.toFixed(4)}`);
    return {
        errorStatus: null,
        errorMessage: null,
        employee: bestEmployee,
        matchScore: Number(matchScore.toFixed(4)),
    };
};

// GET /api/pos/attendance/employees?outlet=OUTLET_CODE
export const listAttendanceEmployees = async (req, res) => {
    const outletCode = req.query.outlet || req.user?.outletCode || null;
    const filter = { isActive: true };

    if (req.user?.outletRef) {
        filter.outlet = req.user.outletRef;
    } else if (req.attendanceDevice?.outletId && mongoose.isValidObjectId(req.attendanceDevice.outletId)) {
        filter.outlet = req.attendanceDevice.outletId;
    } else if (outletCode) {
        const outlet = mongoose.isValidObjectId(outletCode)
            ? await Outlet.findById(outletCode).select('_id code').lean()
            : await getOutletFromCode(outletCode);
        if (!outlet) {
            return res.status(404).json({ success: false, message: 'Outlet not found.' });
        }
        filter.outlet = outlet._id;
    }

    const employees = await Employee.find(filter)
        .select('_id name designation department shiftStart shiftEnd outlet')
        .populate('outlet', 'name code timezone businessDayStart businessDayEnd')
        .sort({ name: 1 })
        .lean();

    res.json({ success: true, data: employees });
};

// GET /api/pos/attendance/employee-by-phone?phone=03XXXXXXXXX&outlet=OUTLET_CODE
export const getAttendanceEmployeeByPhone = async (req, res) => {
    const rawPhone = req.query.phone;

    if (!rawPhone) {
        return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }

    const filter = { isActive: true };

    const phone = String(rawPhone).trim();
    let employee = await Employee.findOne({ ...filter, phone })
        .select('_id name phone designation department outlet')
        .lean();

    if (!employee) {
        const normalizedPhone = normalizePhone(phone);
        if (!normalizedPhone) {
            return res.status(404).json({ success: false, message: 'Employee not found for this phone number.' });
        }

        const candidates = await Employee.find(filter)
            .select('_id name phone designation department outlet')
            .lean();

        employee = candidates.find((item) => normalizePhone(item.phone) === normalizedPhone) || null;
    }

    if (!employee) {
        return res.status(404).json({ success: false, message: 'Employee not found for this phone number.' });
    }

    res.json({ success: true, data: employee });
};

// POST /api/pos/attendance
export const createAttendance = async (req, res) => {
    const { employeeId, selfieImage } = req.body;

    if (!employeeId) {
        return res.status(400).json({ success: false, message: 'employeeId is required.' });
    }

    if (!selfieImage || typeof selfieImage !== 'string' || !selfieImage.startsWith('data:image/')) {
        return res.status(400).json({ success: false, message: 'A valid selfie image is required.' });
    }

    const employee = await Employee.findById(employeeId)
        .select('_id name isActive outlet shiftStart shiftEnd')
        .populate('outlet', 'code timezone businessDayStart businessDayEnd')
        .lean();
    if (!employee || !employee.isActive) {
        return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    const accessError = captureAccessError(req, employee);
    if (accessError) return sendCaptureAccessError(res, accessError);

    const upload = await cloudinary.uploader.upload(selfieImage, {
        folder: 'Attandances',
        resource_type: 'image',
    });

    const { record: attendance, duplicate, action } = await recordAttendancePunch({
        employee,
        capturedAt: new Date(),
        selfieUrl: upload.secure_url,
        selfiePublicId: upload.public_id,
        status: 'pending',
        recognitionMethod: 'manual',
    });

    if (duplicate) {
        cloudinary.uploader.destroy(upload.public_id).catch(() => {});
        return res.status(409).json({ success: false, message: 'Attendance was already captured moments ago.' });
    }
    emitAttendanceUpdate(attendance, employee.name);

    logger.info(`Attendance marked for ${employee.name} (${employee._id})`);

    res.status(201).json({
        success: true,
        data: {
            ...captureResult(attendance, action),
            id: attendance._id,
            employeeId: employee._id,
            selfieUrl: attendance.selfieUrl,
            capturedAt: attendance.capturedAt,
        },
    });
};

// POST /api/pos/attendance/face-identify
export const identifyAttendanceByFace = async (req, res) => {
    const { descriptors, outlet } = req.body;
    const { error, validDescriptors } = normalizeDescriptors(descriptors);
    if (error) {
        return res.status(400).json({ success: false, message: error });
    }

    const liveness = parseLiveness(req.body?.liveness);

    const match = await resolveFaceMatch({ req, outlet, validDescriptors });
    if (match.errorStatus) {
        return res.status(match.errorStatus).json({
            success: false,
            message: match.errorMessage,
            code: match.errorCode,
            data: match.matchScore !== undefined ? { matchScore: match.matchScore } : undefined,
        });
    }


    const bestEmployee = match.employee;
    const bestScore = match.matchScore;

    // fetch employee with shift and outlet timezone
    const empFull = await Employee.findById(bestEmployee._id)
        .select('_id name isActive outlet shiftStart shiftEnd')
        .populate('outlet', 'code timezone businessDayStart businessDayEnd')
        .lean();
    const accessError = captureAccessError(req, empFull, true);
    if (accessError) return sendCaptureAccessError(res, accessError);

    const { record: attendance, duplicate, action } = await recordAttendancePunch({
        employee: empFull,
        capturedAt: new Date(),
        status: 'approved',
        recognitionMethod: 'faceid',
        matchScore: Number(bestScore.toFixed(4)),
        livenessPassed: liveness.passed ? true : null,
        livenessChallenge: liveness.challenge,
    });
    if (duplicate) {
        return res.status(409).json({ success: false, message: 'Attendance was already captured moments ago.' });
    }
    emitAttendanceUpdate(attendance, empFull.name);

    logger.info(`Face attendance auto-marked for ${empFull.name} (${empFull._id}) score=${bestScore.toFixed(4)}`);

    res.status(201).json({
        success: true,
        data: {
            ...captureResult(attendance, action),
            id: attendance._id,
            employeeId: bestEmployee._id,
            employeeName: bestEmployee.name,
            capturedAt: attendance.capturedAt,
            status: attendance.status,
            matchScore: attendance.matchScore,
        },
    });
};

// POST /api/pos/attendance/face-match
export const matchEmployeeByFace = async (req, res) => {
    const { descriptors, outlet } = req.body;
    const { error, validDescriptors } = normalizeDescriptors(descriptors);
    if (error) {
        return res.status(400).json({ success: false, message: error });
    }


    const match = await resolveFaceMatch({ req, outlet, validDescriptors });
    if (match.errorStatus) {
        return res.status(match.errorStatus).json({
            success: false,
            message: match.errorMessage,
            code: match.errorCode,
            data: match.matchScore !== undefined ? { matchScore: match.matchScore } : undefined,
        });
    }

    res.json({
        success: true,
        data: {
            employeeId: match.employee._id,
            employeeName: match.employee.name,
            phone: match.employee.phone || '',
            designation: match.employee.designation || '',
            department: match.employee.department || '',
            matchScore: match.matchScore,
        },
    });
};

// POST /api/pos/attendance/face-complete
export const completeAttendanceByFaceMatch = async (req, res) => {
    const { employeeId, matchScore = null } = req.body;

    if (!employeeId) {
        return res.status(400).json({ success: false, message: 'employeeId is required.' });
    }

    const liveness = parseLiveness(req.body?.liveness);

    const employee = await Employee.findById(employeeId)
        .select('_id name isActive outlet shiftStart shiftEnd')
        .populate('outlet', 'code timezone businessDayStart businessDayEnd')
        .lean();
    if (!employee || !employee.isActive) {
        return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    const accessError = captureAccessError(req, employee, true);
    if (accessError) return sendCaptureAccessError(res, accessError);

    const { record: attendance, duplicate, action } = await recordAttendancePunch({
        employee,
        capturedAt: new Date(),
        status: 'approved',
        recognitionMethod: 'faceid',
        matchScore: Number.isFinite(Number(matchScore)) ? Number(matchScore) : null,
        livenessPassed: liveness.passed ? true : null,
        livenessChallenge: liveness.challenge,
    });
    if (duplicate) {
        return res.status(409).json({ success: false, message: 'Attendance was already captured moments ago.' });
    }
    emitAttendanceUpdate(attendance, employee.name);

    logger.info(`Face attendance completed manually for ${employee.name} (${employee._id})`);

    try {
        const io = getIo();
        if (io) {
            // Emit an attendance created event for real-time updates
            io.emit('attendance:created', {
                id: attendance._id,
                employeeId: employee._id,
                employeeName: employee.name,
                capturedAt: attendance.capturedAt,
                businessDate: attendance.businessDate,
                status: attendance.status,
                matchScore: attendance.matchScore,
                outlet: attendance.outlet || null,
            });
        }
    } catch (e) {
        logger.warn('Failed to emit attendance:created event', e);
    }

    res.status(201).json({
        success: true,
        data: {
            ...captureResult(attendance, action),
            id: attendance._id,
            employeeId: employee._id,
            employeeName: employee.name,
            capturedAt: attendance.capturedAt,
            status: attendance.status,
            matchScore: attendance.matchScore,
        },
    });
};

// POST /api/pos/attendance/records/mark-approved
export const markAttendanceRecordsApproved = async (req, res) => {
    const { records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ success: false, message: 'records array is required.' });
    }

    let modifiedCount = 0;

    for (const item of records) {
        const attendanceIds = Array.isArray(item?.attendanceIds) ? item.attendanceIds.filter(Boolean) : [];

        if (attendanceIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Each record must include attendanceIds.' });
        }

        const result = await Attendance.updateMany(
            {
                _id: { $in: attendanceIds },
            },
            {
                $set: {
                    status: 'approved',
                    approvedAt: new Date(),
                },
            }
        );

        modifiedCount += result.modifiedCount || 0;
    }

    res.json({ success: true, data: { modifiedCount } });
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MANUAL_CONFLICT_MODES = new Set(['fill_missing', 'override', 'skip']);

const validateManualEntry = (entry, index = null) => {
    const prefix = index === null ? '' : `Entry ${index + 1}: `;
    if (!entry?.employeeId || !mongoose.isValidObjectId(entry.employeeId)) return `${prefix}valid employeeId is required.`;
    if (!DATE_RE.test(String(entry.businessDate || ''))) return `${prefix}businessDate must be YYYY-MM-DD.`;
    if (!ATTENDANCE_STATES.has(entry.attendanceState || 'present')) return `${prefix}attendanceState is invalid.`;
    if (entry.checkInTime && !TIME_RE.test(entry.checkInTime)) return `${prefix}checkInTime must be HH:mm.`;
    if (entry.checkOutTime && !TIME_RE.test(entry.checkOutTime)) return `${prefix}checkOutTime must be HH:mm.`;
    return null;
};

const loadManualEmployees = async (ids) => Employee.find({ _id: { $in: ids } })
    .select('_id name isActive outlet shiftStart shiftEnd')
    .populate('outlet', 'name code timezone businessDayStart businessDayEnd')
    .lean();

const employeeWithinUserOutlet = (req, employee) => {
    if (!req.user?.outletRef) return true;
    const employeeOutletId = employee?.outlet?._id || employee?.outlet;
    return String(employeeOutletId || '') === String(req.user.outletRef);
};

const emitAttendanceUpdate = (record, employeeName) => {
    try {
        const io = getIo();
        if (io) {
            io.emit('attendance:updated', {
                id: record._id,
                employeeId: record.employee,
                employeeName,
                businessDate: record.businessDate,
                attendanceState: record.attendanceState,
                checkInAt: record.checkInAt,
                checkOutAt: record.checkOutAt,
            });
        }
    } catch (error) {
        logger.warn(`Failed to emit attendance:updated: ${error.message}`);
    }
};

// PUT /api/pos/attendance/manual
export const upsertManualAttendanceRecord = async (req, res) => {
    const validationError = validateManualEntry(req.body);
    if (validationError) return res.status(400).json({ success: false, message: validationError });

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ success: false, message: 'A reason is required for manual attendance.' });
    const conflictMode = req.body.conflictMode || 'override';
    if (!MANUAL_CONFLICT_MODES.has(conflictMode)) {
        return res.status(400).json({ success: false, message: 'Invalid conflict mode.' });
    }

    const [employee] = await loadManualEmployees([req.body.employeeId]);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    if (!employeeWithinUserOutlet(req, employee)) {
        return res.status(403).json({ success: false, message: 'You can only manage attendance for your assigned outlet.' });
    }
    const shiftTimes = req.body.useShiftTimes ? inferManualTimesFromShift(employee) : {};
    const requestedState = req.body.attendanceState || 'present';
    const checkInTime = req.body.checkInTime || shiftTimes.checkInTime || null;
    const checkOutTime = req.body.checkOutTime || shiftTimes.checkOutTime || null;
    if (checkOutTime && !checkInTime) {
        return res.status(400).json({ success: false, message: 'Check-in time is required when a check-out time is provided.' });
    }

    const before = await Attendance.findOne({
        employee: employee._id,
        outlet: employee.outlet?._id || employee.outlet || null,
        businessDate: req.body.businessDate,
    }).lean();
    const result = await upsertManualAttendance({
        employee,
        businessDate: req.body.businessDate,
        attendanceState: requestedState,
        checkInTime,
        checkOutTime,
        reason,
        notes: String(req.body.notes || '').trim().slice(0, 1000) || null,
        userId: req.user?.id,
        conflictMode,
    });
    req.auditBefore = before;
    req.auditAfter = result.record.toObject();
    req.auditRecordId = result.record._id;
    emitAttendanceUpdate(result.record, employee.name);
    return res.status(result.outcome === 'created' ? 201 : 200).json({ success: true, data: result });
};

// POST /api/pos/attendance/manual/bulk
export const bulkUpsertManualAttendance = async (req, res) => {
    const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!entries.length || entries.length > 1000) {
        return res.status(400).json({ success: false, message: 'Bulk attendance requires between 1 and 1,000 entries.' });
    }
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ success: false, message: 'A reason is required for bulk attendance.' });
    const conflictMode = req.body.conflictMode || 'fill_missing';
    if (!MANUAL_CONFLICT_MODES.has(conflictMode)) {
        return res.status(400).json({ success: false, message: 'Invalid conflict mode.' });
    }
    const duplicateKeys = new Set();
    for (let index = 0; index < entries.length; index += 1) {
        const error = validateManualEntry(entries[index], index);
        if (error) return res.status(400).json({ success: false, message: error });
        const key = `${entries[index].employeeId}:${entries[index].businessDate}`;
        if (duplicateKeys.has(key)) {
            return res.status(400).json({ success: false, message: `Entry ${index + 1}: employee/date is duplicated.` });
        }
        duplicateKeys.add(key);
    }

    const employeeIds = [...new Set(entries.map((entry) => String(entry.employeeId)))];
    const employees = await loadManualEmployees(employeeIds);
    const employeeMap = new Map(employees.map((employee) => [String(employee._id), employee]));
    const missingId = employeeIds.find((id) => !employeeMap.has(id));
    if (missingId) return res.status(404).json({ success: false, message: `Employee ${missingId} was not found.` });
    if (employees.some((employee) => !employeeWithinUserOutlet(req, employee))) {
        return res.status(403).json({ success: false, message: 'One or more employees are outside your assigned outlet.' });
    }

    // Resolve and validate every effective time before writing anything. This
    // prevents a late invalid row from leaving an otherwise valid request only
    // partially applied.
    const batchId = createManualBatchId();
    const preparedEntries = [];
    for (const entry of entries) {
        const employee = employeeMap.get(String(entry.employeeId));
        const shiftTimes = entry.useShiftTimes || req.body.useShiftTimes
            ? inferManualTimesFromShift(employee)
            : {};
        const requestedState = entry.attendanceState || 'present';
        const checkInTime = entry.checkInTime || shiftTimes.checkInTime || null;
        const checkOutTime = entry.checkOutTime || shiftTimes.checkOutTime || null;
        if (checkOutTime && !checkInTime) {
            return res.status(400).json({
                success: false,
                message: `${employee.name} needs a check-in before the check-out time on ${entry.businessDate}.`,
            });
        }
        preparedEntries.push({
            employee,
            businessDate: entry.businessDate,
            attendanceState: requestedState,
            checkInTime,
            checkOutTime,
            reason,
            notes: String(entry.notes || req.body.notes || '').trim().slice(0, 1000) || null,
            userId: req.user?.id,
            conflictMode,
            batchId,
        });
    }

    const results = await upsertManualAttendanceBatch(preparedEntries);
    const summary = { created: 0, updated: 0, skipped: 0, total: entries.length, batchId };
    const changed = [];
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const employee = preparedEntries[index].employee;
        summary[result.outcome] += 1;
        if (result.outcome !== 'skipped') {
            changed.push(result.record._id);
            emitAttendanceUpdate(result.record, employee.name);
        }
    }
    req.auditAfter = { ...summary, reason, conflictMode, recordIds: changed };
    return res.status(201).json({ success: true, data: summary });
};

const attendanceRowsFromRecords = (records) => {
    const grouped = new Map();

    for (const record of records) {
        if (!record.employee) continue;
        const outlet = record.outlet || record.employee.outlet || null;
        const timeZone = record.timezone || outlet?.timezone || DEFAULT_TZ;
        const businessDayStart = record.businessDayStart || outlet?.businessDayStart || '00:00';
        const businessDayEnd = record.businessDayEnd || outlet?.businessDayEnd || businessDayStart;
        const dayKey = record.businessDate || getBusinessDate(
            record.checkInAt || record.capturedAt,
            timeZone,
            businessDayStart,
            businessDayEnd,
        );
        const groupKey = `${record.employee._id}:${dayKey}`;
        // capturedAt is a legacy fallback for device/face records. A manual
        // Present row is allowed to have no recorded times, so do not turn its
        // bookkeeping timestamp into a fake check-in when the sheet reloads.
        const recordCheckIn = record.checkInAt || (!record.manualOverride
            && (!record.attendanceState || ['present', 'incomplete'].includes(record.attendanceState))
            ? record.capturedAt
            : null);
        const recordCheckOut = record.checkOutAt || null;
        const punchCount = Array.isArray(record.punches) && record.punches.length
            ? record.punches.length
            : (recordCheckIn ? 1 : 0);
        const existing = grouped.get(groupKey);

        if (!existing) {
            grouped.set(groupKey, {
                id: groupKey,
                date: dayKey,
                employeeId: record.employee._id,
                employeeName: record.employee.name,
                employeeActive: record.employee.isActive !== false,
                phone: record.employee.phone || '',
                designation: record.employee.designation || '',
                department: record.employee.department || '',
                outletName: outlet?.name || '',
                outletCode: outlet?.code || '',
                shiftStart: record.shiftStart || record.employee.shiftStart || '',
                shiftEnd: record.shiftEnd || record.employee.shiftEnd || '',
                timezone: timeZone,
                businessDayStart,
                businessDayEnd,
                graceMinutes: record.graceMinutes ?? null,
                graceTerminalId: record.graceTerminalId || null,
                selfieUrl: record.selfieUrl,
                attendanceIds: [record._id],
                firstCapturedAt: recordCheckIn,
                checkInAt: recordCheckIn,
                lastCapturedAt: recordCheckOut || recordCheckIn,
                checkOutAt: recordCheckOut,
                captureCount: punchCount,
                status: record.status || 'pending',
                approvedAt: record.approvedAt || null,
                attendanceState: record.attendanceState || 'present',
                recognitionMethod: record.recognitionMethod || 'manual',
                manualOverride: record.manualOverride === true,
                manualReason: record.manualReason || '',
                manualNotes: record.manualNotes || '',
                manualUpdatedAt: record.manualUpdatedAt || null,
                shiftCorrection: record.shiftCorrections?.at(-1) || null,
            });
            continue;
        }

        existing.captureCount += punchCount;
        const latestCorrection = record.shiftCorrections?.at(-1);
        if (latestCorrection && (!existing.shiftCorrection || new Date(latestCorrection.correctedAt) > new Date(existing.shiftCorrection.correctedAt))) {
            existing.shiftCorrection = latestCorrection;
        }
        if (existing.graceMinutes == null && record.graceMinutes != null) {
            existing.graceMinutes = record.graceMinutes;
            existing.graceTerminalId = record.graceTerminalId || null;
        }
        existing.attendanceIds.push(record._id);
        if (record.status === 'approved') {
            existing.status = 'approved';
            existing.approvedAt = record.approvedAt || existing.approvedAt;
        }
        if (record.recognitionMethod && record.recognitionMethod !== existing.recognitionMethod) {
            existing.recognitionMethod = 'mixed';
        }
        if (record.manualOverride) {
            existing.manualOverride = true;
            existing.manualReason = record.manualReason || existing.manualReason;
            existing.manualNotes = record.manualNotes || existing.manualNotes;
            existing.attendanceState = record.attendanceState || existing.attendanceState;
        }
        if (recordCheckIn && (!existing.checkInAt || new Date(recordCheckIn) < new Date(existing.checkInAt))) {
            existing.firstCapturedAt = recordCheckIn;
            existing.checkInAt = recordCheckIn;
            existing.selfieUrl = record.selfieUrl || existing.selfieUrl;
        }
        const latest = recordCheckOut || recordCheckIn;
        if (latest && (!existing.lastCapturedAt || new Date(latest) > new Date(existing.lastCapturedAt))) {
            existing.lastCapturedAt = latest;
            existing.checkOutAt = recordCheckOut || (existing.captureCount > 1 ? latest : existing.checkOutAt);
        }
    }

    return Array.from(grouped.values()).map((entry) => {
        const metrics = computeShiftMetrics({
            dateKey: entry.date,
            capturedAt: entry.checkInAt,
            checkInAt: entry.checkInAt,
            checkOutAt: entry.checkOutAt,
            shiftStart: entry.shiftStart,
            shiftEnd: entry.shiftEnd,
            timeZone: entry.timezone,
            businessDayStart: entry.businessDayStart,
            businessDayEnd: entry.businessDayEnd,
            graceMinutes: entry.graceMinutes,
        });
        if (entry.attendanceState === 'absent') {
            metrics.recommendation = 'not_recommended';
            metrics.recommendationReason = 'Employee was marked absent.';
        } else if (['leave', 'off'].includes(entry.attendanceState)) {
            metrics.recommendation = 'approve';
            metrics.recommendationReason = entry.attendanceState === 'leave'
                ? 'Employee was marked on leave.'
                : 'Employee was marked off duty.';
        }
        return { ...entry, ...metrics };
    });
};

// Owner-only, day-specific shift correction; terminal scans remain untouched.
export const getShiftCorrectionContext = async (req, res) => {
    const data = await getAttendanceShiftCorrectionContext({
        employeeId: req.params.employeeId, businessDate: req.query.businessDate, actor: req.user, tenant: req.tenant,
    });
    return res.json({ success: true, data });
};

export const postShiftCorrection = async (req, res) => {
    const { employee, records } = await correctAttendanceShift({
        employeeId: req.params.employeeId, businessDate: req.body.businessDate,
        source: req.body.source, shiftStart: req.body.shiftStart, shiftEnd: req.body.shiftEnd,
        reason: req.body.reason, version: req.body.version, actor: req.user, tenant: req.tenant, ip: req.ip,
    });
    const record = attendanceRowsFromRecords(records.map((row) => ({ ...row, employee })))[0];
    for (const row of records) emitAttendanceUpdate(row, employee.name);
    return res.json({ success: true, data: { record } });
};

// GET /api/pos/attendance/manual/sheet?outlet=OUTLET_ID&month=YYYY-MM
// Loads the employee roster and the complete month in one request for the
// spreadsheet-style manual attendance workspace.
export const getManualAttendanceSheet = async (req, res) => {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, message: 'month must be YYYY-MM.' });
    }

    const requestedOutlet = req.user?.outletRef || req.query.outlet;
    if (!requestedOutlet) {
        return res.status(400).json({ success: false, message: 'Select an outlet to load attendance.' });
    }

    const outlet = mongoose.isValidObjectId(requestedOutlet)
        ? await Outlet.findById(requestedOutlet)
            .select('_id name code timezone businessDayStart businessDayEnd')
            .lean()
        : await Outlet.findOne({ code: String(requestedOutlet).trim().toUpperCase() })
            .select('_id name code timezone businessDayStart businessDayEnd')
            .lean();
    if (!outlet) {
        return res.status(404).json({ success: false, message: 'Outlet not found.' });
    }
    if (req.user?.outletRef && String(outlet._id) !== String(req.user.outletRef)) {
        return res.status(403).json({ success: false, message: 'You can only manage attendance for your assigned outlet.' });
    }

    const employees = await Employee.find({ outlet: outlet._id })
        .select('_id name designation department shiftStart shiftEnd outlet isActive joiningDate')
        .sort({ isActive: -1, name: 1 })
        .lean();
    const employeeIds = employees.map((employee) => employee._id);
    if (!employeeIds.length) {
        return res.json({ success: true, data: { outlet, employees: [], records: [] } });
    }

    const [year, monthNumber] = month.split('-').map(Number);
    const startMs = Date.UTC(year, monthNumber - 1, 1);
    const endMs = Date.UTC(year, monthNumber, 1);
    const records = await Attendance.find({
        employee: { $in: employeeIds },
        outlet: outlet._id,
        $or: [
            { businessDate: { $regex: `^${month}-` } },
            {
                businessDate: { $in: [null] },
                capturedAt: {
                    $gte: new Date(startMs - (24 * 60 * 60 * 1000)),
                    $lt: new Date(endMs + (24 * 60 * 60 * 1000)),
                },
            },
            {
                businessDate: { $exists: false },
                capturedAt: {
                    $gte: new Date(startMs - (24 * 60 * 60 * 1000)),
                    $lt: new Date(endMs + (24 * 60 * 60 * 1000)),
                },
            },
        ],
    })
        .populate({
            path: 'employee',
            select: 'name designation department shiftStart shiftEnd outlet isActive',
            populate: { path: 'outlet', select: 'name code timezone businessDayStart businessDayEnd' },
        })
        .populate('outlet', 'name code timezone businessDayStart businessDayEnd')
        .sort({ capturedAt: 1 })
        .lean();

    const rows = attendanceRowsFromRecords(records)
        .filter((entry) => entry.date.startsWith(`${month}-`))
        .map((entry) => ({
            employeeId: entry.employeeId,
            businessDate: entry.date,
            attendanceState: entry.attendanceState,
            checkInAt: entry.checkInAt,
            checkOutAt: entry.checkOutAt,
            manualOverride: entry.manualOverride,
            manualReason: entry.manualReason,
            recognitionMethod: entry.recognitionMethod,
        }));

    return res.json({ success: true, data: { outlet, employees, records: rows } });
};

// GET /api/pos/attendance/records?date=YYYY-MM-DD (or from=YYYY-MM-DD&to=YYYY-MM-DD)
export const listAttendanceRecords = async (req, res) => {
    const hasRange = req.query.from !== undefined || req.query.to !== undefined;
    const from = hasRange ? req.query.from : (req.query.date || formatDateKey(new Date()));
    const to = hasRange ? req.query.to : from;
    const validDate = (value) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    if (!validDate(from) || !validDate(to)) {
        return res.status(400).json({ success: false, message: 'Provide a valid business date or both from and to dates in YYYY-MM-DD format.' });
    }
    if (from > to) {
        return res.status(400).json({ success: false, message: 'The end date must be on or after the start date.' });
    }
    // Legacy records lack a business date. Include timezone/overnight margins,
    // then filter their derived business dates after grouping below.
    const queryStart = new Date(Date.parse(`${from}T00:00:00.000Z`) - (24 * 60 * 60 * 1000));
    const queryEnd = new Date(Date.parse(`${to}T00:00:00.000Z`) + (48 * 60 * 60 * 1000));

    const attendanceFilter = {
        $or: [
            { businessDate: hasRange ? { $gte: from, $lte: to } : from },
            { businessDate: null, capturedAt: { $gte: queryStart, $lt: queryEnd } },
            { businessDate: { $exists: false }, capturedAt: { $gte: queryStart, $lt: queryEnd } },
        ],
    };

    const outletParam = req.user?.outletRef || req.query.outlet;
    if (outletParam) {
        if (mongoose.isValidObjectId(outletParam)) {
            attendanceFilter.outlet = new mongoose.Types.ObjectId(outletParam);
        }
    }

    const records = await Attendance.find(attendanceFilter)
        .populate({ path: 'employee', select: 'name phone designation department shiftStart shiftEnd outlet isActive', populate: { path: 'outlet', select: 'name code timezone businessDayStart businessDayEnd' } })
        .populate('outlet', 'name code timezone businessDayStart businessDayEnd')
        .sort({ capturedAt: -1 })
        .lean();

    const data = attendanceRowsFromRecords(records)
        .filter((entry) => entry.date >= from && entry.date <= to)
        .sort((a, b) => new Date(b.firstCapturedAt || 0) - new Date(a.firstCapturedAt || 0));

    res.json({ success: true, data });
};

// GET /api/pos/attendance/employee/:employeeId/records?month=YYYY-MM
export const listAttendanceByEmployee = async (req, res) => {
    const employeeId = req.params.employeeId;
    const month = req.query.month; // e.g. '2026-04'

    if (!employeeId) {
        return res.status(400).json({ success: false, message: 'employeeId is required.' });
    }
    const reportEmployee = await Employee.findById(employeeId)
        .select('_id name phone designation department shiftStart shiftEnd outlet isActive')
        .populate('outlet', 'name code timezone businessDayStart businessDayEnd')
        .lean();
    if (!reportEmployee) {
        return res.status(404).json({ success: false, message: 'Employee not found.' });
    }
    if (req.user?.outletRef) {
        if (String(reportEmployee.outlet?._id || reportEmployee.outlet || '') !== String(req.user.outletRef)) {
            return res.status(403).json({ success: false, message: 'You can only view attendance for your assigned outlet.' });
        }
    }

    let startMs, endMs;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
        startMs = Date.parse(`${month}-01T00:00:00.000Z`);
        const parts = month.split('-').map(Number);
        const year = parts[0];
        const mon = parts[1];
        const nextMonth = new Date(Date.UTC(year, mon, 1));
        endMs = nextMonth.getTime();
    } else {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        startMs = start.getTime();
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        endMs = next.getTime();
    }
    const effectiveMonth = month && /^\d{4}-\d{2}$/.test(month)
        ? month
        : new Date(startMs).toISOString().slice(0, 7);

    const records = await Attendance.find({
        employee: employeeId,
        $or: [
            { businessDate: { $regex: `^${effectiveMonth}-` } },
            {
                businessDate: { $in: [null] },
                capturedAt: {
                    $gte: new Date(startMs - (24 * 60 * 60 * 1000)),
                    $lt: new Date(endMs + (24 * 60 * 60 * 1000)),
                },
            },
            {
                businessDate: { $exists: false },
                capturedAt: {
                    $gte: new Date(startMs - (24 * 60 * 60 * 1000)),
                    $lt: new Date(endMs + (24 * 60 * 60 * 1000)),
                },
            },
        ],
    })
        .populate({ path: 'employee', select: 'name phone designation department shiftStart shiftEnd outlet isActive', populate: { path: 'outlet', select: 'name code timezone businessDayStart businessDayEnd' } })
        .populate('outlet', 'name code timezone businessDayStart businessDayEnd')
        .sort({ capturedAt: -1 })
        .lean();

    const data = attendanceRowsFromRecords(records)
        .filter((entry) => entry.date.startsWith(`${effectiveMonth}-`))
        .sort((a, b) => new Date(b.firstCapturedAt || 0) - new Date(a.firstCapturedAt || 0));

    res.json({
        success: true,
        data,
        meta: {
            employee: {
                id: reportEmployee._id,
                name: reportEmployee.name,
                phone: reportEmployee.phone || '',
                designation: reportEmployee.designation || '',
                department: reportEmployee.department || '',
                shiftStart: reportEmployee.shiftStart || '',
                shiftEnd: reportEmployee.shiftEnd || '',
                outletName: reportEmployee.outlet?.name || '',
                outletCode: reportEmployee.outlet?.code || '',
                active: reportEmployee.isActive !== false,
            },
        },
    });
};
