import crypto from 'crypto';
import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import Employee from '../models/Employee.js';
import AuditLog from '../models/AuditLog.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { getBusinessDate } from '../utils/businessDate.js';
import { DEFAULT_TZ } from '../utils/attendanceTime.js';
import { isFeatureEnabledForOutlet } from './outletFeatures.service.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const id = (value) => String(value?._id ?? value ?? '');
const fail = (message, statusCode = 422) => { throw Object.assign(new Error(message), { statusCode }); };

const validateTarget = ({ employeeId, businessDate, actor }) => {
  if (actor?.role !== 'owner') fail('Only an owner can correct the saved attendance shift.', 403);
  if (!mongoose.isValidObjectId(employeeId)) fail('A valid employee is required.');
  const date = new Date(`${businessDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '') || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== businessDate) fail('A valid business date is required.');
};

const recordDay = (record, employee) => {
  const outlet = record.outlet || employee.outlet;
  return record.businessDate || getBusinessDate(record.checkInAt || record.capturedAt,
    record.timezone || outlet?.timezone || DEFAULT_TZ,
    record.businessDayStart || outlet?.businessDayStart || '00:00',
    record.businessDayEnd || outlet?.businessDayEnd || record.businessDayStart || outlet?.businessDayStart || '00:00');
};

// Include legacy records without businessDate, using the same local-day rules
// as the report. All rows grouped into the selected employee/day are corrected.
const loadDay = async ({ employeeId, businessDate, actor, tenant }, session = null) => {
  validateTarget({ employeeId, businessDate, actor });
  const employee = await Employee.findById(employeeId)
    .select('_id name phone designation department shiftStart shiftEnd outlet isActive')
    .populate('outlet', 'name code timezone businessDayStart businessDayEnd').session(session).lean();
  if (!employee) fail('Employee not found.', 404);
  if (actor.outletRef && id(actor.outletRef) !== id(employee.outlet)) {
    fail('You can only correct attendance for your assigned outlet.', 403);
  }
  const midnight = Date.parse(`${businessDate}T00:00:00.000Z`);
  const candidates = await Attendance.find({ employee: employeeId, $or: [
    { businessDate },
    { businessDate: null, capturedAt: { $gte: new Date(midnight - 86400000), $lt: new Date(midnight + 172800000) } },
  ] }).populate('outlet', 'name code timezone businessDayStart businessDayEnd').sort({ _id: 1 }).session(session).lean();
  const records = candidates.filter((record) => recordDay(record, employee) === businessDate);
  if (!records.length) fail('No attendance record exists for this day.', 404);
  for (const record of records) {
    const outletId = id(record.outlet || employee.outlet);
    if (actor.outletRef && id(actor.outletRef) !== outletId) fail('You can only correct attendance for your assigned outlet.', 403);
    if (!isFeatureEnabledForOutlet(tenant, 'attendance', outletId)) fail('Attendance is not enabled for this outlet.', 403);
  }
  const version = crypto.createHash('sha256').update(JSON.stringify({
    employeeShift: [employee.shiftStart || '', employee.shiftEnd || ''],
    records: records.map((record) => [id(record), record.updatedAt, record.shiftStart, record.shiftEnd]),
  })).digest('hex');
  return { employee, records, version };
};

export const getAttendanceShiftCorrectionContext = async (target) => {
  const { employee, records, version } = await loadDay(target);
  return {
    employeeId: employee._id, employeeName: employee.name, businessDate: target.businessDate, version,
    currentShift: { shiftStart: employee.shiftStart || '', shiftEnd: employee.shiftEnd || '' },
    savedShifts: [...new Map(records.map((record) => {
      const shift = { shiftStart: record.shiftStart || employee.shiftStart || '', shiftEnd: record.shiftEnd || employee.shiftEnd || '' };
      return [`${shift.shiftStart}/${shift.shiftEnd}`, shift];
    })).values()],
    timezone: records[0].timezone || records[0].outlet?.timezone || employee.outlet?.timezone || DEFAULT_TZ,
  };
};

export const correctAttendanceShift = async (target) => {
  const { source, shiftStart, shiftEnd, reason: rawReason, version, actor, businessDate, ip } = target;
  validateTarget(target);
  if (!['employee', 'custom'].includes(source)) fail('Choose the current employee shift or enter a shift for this day.');
  const reason = String(rawReason || '').trim();
  if (reason.length < 5 || reason.length > 500) fail('Enter a correction reason of 5 to 500 characters.');
  if (!/^[a-f0-9]{64}$/.test(version || '')) fail('Reload the shift correction before saving.', 409);
  if (source === 'custom' && (!TIME_RE.test(shiftStart || '') || !TIME_RE.test(shiftEnd || ''))) {
    fail('Enter valid shift start and end times in HH:mm format.');
  }
  const session = await getTenantConnection().startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const { employee, records, version: currentVersion } = await loadDay(target, session);
      if (version !== currentVersion) fail('Attendance or the employee shift changed. Reload the correction and review the latest times.', 409);
      const newStart = source === 'employee' ? employee.shiftStart : shiftStart;
      const newEnd = source === 'employee' ? employee.shiftEnd : shiftEnd;
      if (!TIME_RE.test(newStart || '') || !TIME_RE.test(newEnd || '')) fail('The employee has no valid current shift. Enter the times for this day manually.');
      if (records.every((record) => record.shiftStart === newStart && record.shiftEnd === newEnd)) {
        fail('This day already uses those shift times.');
      }
      const correctedAt = new Date();
      const updated = [];
      for (const record of records) {
        const correction = {
          previousStart: record.shiftStart || employee.shiftStart || null,
          previousEnd: record.shiftEnd || employee.shiftEnd || null,
          shiftStart: newStart, shiftEnd: newEnd, source, reason, correctedBy: actor.id, correctedAt,
        };
        const update = await Attendance.updateOne({
          _id: record._id, updatedAt: record.updatedAt ?? { $exists: false },
        }, {
          $set: { shiftStart: newStart, shiftEnd: newEnd },
          $push: { shiftCorrections: correction },
        }, { session, runValidators: true });
        if (update.matchedCount !== 1) fail('Attendance changed during correction. Reload and try again.', 409);
        updated.push({ ...record, shiftStart: newStart, shiftEnd: newEnd,
          shiftCorrections: [...(record.shiftCorrections || []), correction] });
      }
      await AuditLog.create([{
        user: actor.id, actorName: actor.name, actorRole: actor.role, action: 'ATTENDANCE_SHIFT_CORRECTED',
        module: 'Attendance', recordId: records[0]._id, ip,
        before: records.map((record) => ({ id: record._id, shiftStart: record.shiftStart, shiftEnd: record.shiftEnd,
          checkInAt: record.checkInAt, checkOutAt: record.checkOutAt })),
        after: { employeeId: employee._id, businessDate, shiftStart: newStart, shiftEnd: newEnd, source, reason,
          attendanceIds: updated.map((record) => record._id), correctedAt },
      }], { session });
      result = { employee, records: updated };
    });
    return result;
  } finally {
    await session.endSession();
  }
};
