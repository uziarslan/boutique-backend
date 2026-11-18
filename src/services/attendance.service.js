import crypto from 'crypto';
import Attendance from '../models/Attendance.js';
import { getBusinessDate } from '../utils/businessDate.js';
import {
  DEFAULT_TZ,
  parseShiftMinutes,
  toBusinessDateTimeUtcMs,
} from '../utils/attendanceTime.js';

export const ATTENDANCE_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
export const ATTENDANCE_STATES = new Set(['present', 'absent', 'leave', 'off', 'incomplete']);

const outletClock = (employee) => ({
  outletId: employee?.outlet?._id || employee?.outlet || null,
  timezone: employee?.outlet?.timezone || DEFAULT_TZ,
  businessDayStart: employee?.outlet?.businessDayStart || '00:00',
  businessDayEnd: employee?.outlet?.businessDayEnd
    || employee?.outlet?.businessDayStart
    || '00:00',
});

const punchPayload = ({ capturedAt, recognitionMethod, deviceSerialNo, deviceLabel }) => ({
  capturedAt,
  recognitionMethod,
  deviceSerialNo: deviceSerialNo || null,
  deviceLabel: deviceLabel || null,
});

const validTimestamp = (value) => {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
};

const manualTimeLocked = (record, field) => Boolean(record?.manualOverride && (
  record[field === 'checkInAt' ? 'manualCheckInLocked' : 'manualCheckOutLocked']
    ?? Boolean(record[field])
));

const effectivePunchBounds = (record) => {
  const timestamps = (Array.isArray(record.punches) ? record.punches : [])
    .map((punch) => validTimestamp(punch?.capturedAt))
    .filter((timestamp) => timestamp !== null);

  // Preserve effective times from legacy records that predate the punch log.
  for (const value of [record.checkInAt || (!record.manualOverride ? record.capturedAt : null), record.checkOutAt]) {
    const timestamp = validTimestamp(value);
    if (timestamp !== null) timestamps.push(timestamp);
  }

  if (!timestamps.length) return { checkInAt: null, checkOutAt: null };
  const first = manualTimeLocked(record, 'checkInAt')
    ? validTimestamp(record.checkInAt)
    : Math.min(...timestamps);
  const last = manualTimeLocked(record, 'checkOutAt')
    ? validTimestamp(record.checkOutAt)
    : Math.max(...timestamps);
  return {
    checkInAt: new Date(first),
    checkOutAt: last !== null && last > first ? new Date(last) : null,
  };
};

export const recordAttendancePunch = async ({
  employee,
  capturedAt = new Date(),
  recognitionMethod,
  deviceSerialNo = null,
  deviceLabel = null,
  graceMinutes = null,
  graceTerminalId = null,
  selfieUrl = null,
  selfiePublicId = null,
  matchScore = null,
  livenessPassed = null,
  livenessChallenge = null,
  status = 'approved',
}) => {
  const instant = new Date(capturedAt);
  const clock = outletClock(employee);
  const businessDate = getBusinessDate(
    instant,
    clock.timezone,
    clock.businessDayStart,
    clock.businessDayEnd,
  );
  // Attendance is keyed by the outlet's reporting day, not the calendar date.
  // For an overnight outlet, a post-midnight punch therefore finds and updates
  // the record created before midnight instead of starting a second day.
  const key = { employee: employee._id, outlet: clock.outletId, businessDate };
  let record = await Attendance.findOne(key);

  if (record) {
    const punches = Array.isArray(record.punches) ? record.punches : [];
    const existingPunchTimes = punches
      .map((punch) => validTimestamp(punch?.capturedAt))
      .filter((timestamp) => timestamp !== null);
    // A manual check-in is not a repeated scan: the first later terminal/face
    // scan must be able to fill checkout even within the duplicate window.
    // Keep automatic legacy times and actual punches in the duplicate check.
    const automaticCheckIn = manualTimeLocked(record, 'checkInAt')
      ? null
      : record.checkInAt || (!record.manualOverride ? record.capturedAt : null);
    for (const value of [automaticCheckIn, record.checkOutAt]) {
      const timestamp = validTimestamp(value);
      if (timestamp !== null) existingPunchTimes.push(timestamp);
    }
    if (existingPunchTimes.some((timestamp) => (
      Math.abs(instant.getTime() - timestamp) < ATTENDANCE_DUPLICATE_WINDOW_MS
    ))) {
      return { record, duplicate: true, businessDate };
    }

    const previousCheckIn = validTimestamp(record.checkInAt);
    const previousCheckOut = validTimestamp(record.checkOutAt);
    // Materialize legacy locks before filling a blank field; a checkout from
    // today's scan must remain automatic when later scans arrive.
    record.manualCheckInLocked = manualTimeLocked(record, 'checkInAt');
    record.manualCheckOutLocked = manualTimeLocked(record, 'checkOutAt');
    // A manual/face check-in can acquire its policy from the first terminal
    // scan. Later scans/settings changes must not rewrite that day's policy.
    if (record.graceMinutes == null && recognitionMethod === 'device' && graceMinutes != null) {
      record.graceMinutes = graceMinutes;
      record.graceTerminalId = graceTerminalId;
    }
    record.punches = punches;
    record.punches.push(punchPayload({ capturedAt: instant, recognitionMethod, deviceSerialNo, deviceLabel }));
    if (!record.manualOverride || !['absent', 'leave', 'off'].includes(record.attendanceState)) {
      const bounds = effectivePunchBounds(record);
      record.checkInAt = bounds.checkInAt;
      record.capturedAt = bounds.checkInAt;
      record.checkOutAt = bounds.checkOutAt;
      record.attendanceState = record.checkOutAt ? 'present' : 'incomplete';
    }
    if (record.recognitionMethod !== recognitionMethod) record.recognitionMethod = 'mixed';
    if (status === 'approved') {
      record.status = 'approved';
      record.approvedAt = new Date();
    }
    await record.save();
    const action = validTimestamp(record.checkOutAt) !== previousCheckOut ? 'check-out'
      : validTimestamp(record.checkInAt) !== previousCheckIn ? 'check-in'
        : 'scan-recorded';
    return { record, duplicate: false, businessDate, action };
  }

  try {
    record = await Attendance.create({
      ...key,
      capturedAt: instant,
      checkInAt: instant,
      checkOutAt: null,
      graceMinutes: recognitionMethod === 'device' ? graceMinutes : null,
      graceTerminalId: recognitionMethod === 'device' ? graceTerminalId : null,
      attendanceState: 'incomplete',
      punches: [punchPayload({ capturedAt: instant, recognitionMethod, deviceSerialNo, deviceLabel })],
      selfieUrl,
      selfiePublicId,
      status,
      approvedAt: status === 'approved' ? new Date() : null,
      recognitionMethod,
      matchScore,
      autoApproved: status === 'approved',
      deviceSerialNo,
      deviceLabel,
      livenessPassed,
      livenessChallenge,
      shiftStart: employee.shiftStart || null,
      shiftEnd: employee.shiftEnd || null,
      timezone: clock.timezone,
      businessDayStart: clock.businessDayStart,
      businessDayEnd: clock.businessDayEnd,
    });
    return { record, duplicate: false, businessDate, action: 'check-in' };
  } catch (error) {
    // Two terminals can submit the same employee almost simultaneously. The
    // partial unique index selects the winner; retry once as the second punch.
    if (error?.code === 11000) {
      return recordAttendancePunch({
        employee,
        capturedAt: instant,
        recognitionMethod,
        deviceSerialNo,
        deviceLabel,
        graceMinutes,
        graceTerminalId,
        selfieUrl,
        selfiePublicId,
        matchScore,
        livenessPassed,
        livenessChallenge,
        status,
      });
    }
    throw error;
  }
};

const manualInstant = ({ businessDate, time, clock }) => {
  if (!time) return null;
  const ms = toBusinessDateTimeUtcMs({
    dateKey: businessDate,
    time,
    timeZone: clock.timezone,
    businessDayStart: clock.businessDayStart,
    businessDayEnd: clock.businessDayEnd,
  });
  return Number.isFinite(ms) ? new Date(ms) : null;
};

export const upsertManualAttendance = async ({
  employee,
  businessDate,
  attendanceState = 'present',
  checkInTime = null,
  checkOutTime = null,
  reason,
  notes = null,
  userId,
  conflictMode = 'override',
  batchId = null,
}) => {
  const clock = outletClock(employee);
  const key = { employee: employee._id, outlet: clock.outletId, businessDate };
  const existing = await Attendance.findOne(key);

  if (existing && conflictMode === 'skip') {
    return { record: existing, outcome: 'skipped' };
  }
  if (existing && conflictMode === 'fill_missing'
    && (['absent', 'leave', 'off'].includes(existing.attendanceState)
      || (existing.checkInAt && existing.checkOutAt))) {
    return { record: existing, outcome: 'skipped' };
  }

  let checkInAt = manualInstant({ businessDate, time: checkInTime, clock });
  let checkOutAt = manualInstant({ businessDate, time: checkOutTime, clock });
  if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
    checkOutAt = new Date(checkOutAt.getTime() + 24 * 60 * 60 * 1000);
  }

  if (existing && conflictMode === 'fill_missing') {
    checkInAt = existing.checkInAt || checkInAt;
    checkOutAt = existing.checkOutAt || checkOutAt;
  }

  const stateWithoutTimes = ['absent', 'leave', 'off'].includes(attendanceState);
  if (stateWithoutTimes) {
    checkInAt = null;
    checkOutAt = null;
  } else if (attendanceState === 'incomplete') {
    checkOutAt = null;
  }
  const effectiveState = attendanceState === 'present' && checkInAt && !checkOutAt
    ? 'incomplete'
    : attendanceState;
  const capturedAt = checkInAt || existing?.capturedAt || new Date(`${businessDate}T12:00:00.000Z`);
  const keepExisting = existing && conflictMode === 'fill_missing';
  const now = new Date();

  const update = {
    $set: {
      capturedAt,
      checkInAt,
      checkOutAt,
      attendanceState: effectiveState,
      status: 'approved',
      approvedAt: now,
      recognitionMethod: existing?.punches?.some((p) => p.recognitionMethod !== 'manual') ? 'mixed' : 'manual',
      shiftStart: existing?.shiftStart || employee.shiftStart || null,
      shiftEnd: existing?.shiftEnd || employee.shiftEnd || null,
      timezone: existing?.timezone || clock.timezone,
      businessDayStart: existing?.businessDayStart || clock.businessDayStart,
      businessDayEnd: existing?.businessDayEnd || clock.businessDayEnd,
      manualOverride: true,
      manualCheckInLocked: Boolean(checkInAt) && (keepExisting && existing.checkInAt
        ? manualTimeLocked(existing, 'checkInAt') : true),
      manualCheckOutLocked: Boolean(checkOutAt) && (keepExisting && existing.checkOutAt
        ? manualTimeLocked(existing, 'checkOutAt') : true),
      manualReason: reason,
      manualNotes: notes || null,
      manualUpdatedBy: userId || null,
      manualUpdatedAt: now,
      manualBatchId: batchId || null,
    },
    $setOnInsert: {
      employee: employee._id,
      outlet: clock.outletId,
      businessDate,
      punches: [],
    },
  };

  const record = await Attendance.findOneAndUpdate(key, update, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
  });
  return { record, outcome: existing ? 'updated' : 'created' };
};

export const createManualBatchId = () => crypto.randomUUID();

export const MANUAL_ATTENDANCE_BULK_CONCURRENCY = 25;

// Manual attendance imports can contain hundreds of independent employee/day
// rows. Running each upsert serially makes the request exceed Heroku's 30-second
// router limit, even though the writes eventually finish. Keep a conservative
// amount of work in flight so large batches finish promptly without flooding
// the MongoDB connection pool.
export const upsertManualAttendanceBatch = async (
  entries,
  { concurrency = MANUAL_ATTENDANCE_BULK_CONCURRENCY } = {},
) => {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const limit = Math.max(1, Math.min(Number(concurrency) || 1, entries.length));
  const results = new Array(entries.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await upsertManualAttendance(entries[index]);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
};

export const inferManualTimesFromShift = (employee) => ({
  checkInTime: parseShiftMinutes(employee?.shiftStart) === null ? null : employee.shiftStart,
  checkOutTime: parseShiftMinutes(employee?.shiftEnd) === null ? null : employee.shiftEnd,
});
