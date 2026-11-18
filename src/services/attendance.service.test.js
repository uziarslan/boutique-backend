import { beforeEach, describe, expect, it, vi } from 'vitest';

const { attendanceModel, records } = vi.hoisted(() => {
  const storedRecords = new Map();
  const model = {
    findOne: vi.fn(async ({ employee, outlet, businessDate }) => (
      storedRecords.get(`${employee}:${outlet}:${businessDate}`) || null
    )),
    create: vi.fn(async (payload) => {
      const record = {
        ...payload,
        save: vi.fn(async function save() { return this; }),
      };
      storedRecords.set(`${payload.employee}:${payload.outlet}:${payload.businessDate}`, record);
      return record;
    }),
    findOneAndUpdate: vi.fn(),
  };
  return { attendanceModel: model, records: storedRecords };
});

vi.mock('../models/Attendance.js', () => ({ default: attendanceModel }));

import { recordAttendancePunch, upsertManualAttendanceBatch } from './attendance.service.js';

const employee = {
  _id: 'employee-1',
  shiftStart: '18:00',
  shiftEnd: '03:00',
  outlet: {
    _id: 'outlet-1',
    timezone: 'Asia/Karachi',
    businessDayStart: '09:00',
    businessDayEnd: '04:00',
  },
};

describe('recordAttendancePunch business dates', () => {
  beforeEach(() => {
    records.clear();
    attendanceModel.findOne.mockReset();
    attendanceModel.findOne.mockImplementation(async ({ employee: employeeId, outlet, businessDate }) => (
      records.get(`${employeeId}:${outlet}:${businessDate}`) || null
    ));
    attendanceModel.create.mockReset();
    attendanceModel.create.mockImplementation(async (payload) => {
      const record = {
        ...payload,
        save: vi.fn(async function save() { return this; }),
      };
      records.set(`${payload.employee}:${payload.outlet}:${payload.businessDate}`, record);
      return record;
    });
    attendanceModel.findOneAndUpdate.mockReset();
  });

  it('updates the opening-date record when an overnight shift checks out after midnight', async () => {
    const checkInAt = new Date('2026-09-01T13:00:00.000Z'); // Sep 1, 18:00 PKT
    const checkOutAt = new Date('2026-09-01T22:00:00.000Z'); // Sep 2, 03:00 PKT

    const checkIn = await recordAttendancePunch({
      employee,
      capturedAt: checkInAt,
      recognitionMethod: 'device',
    });
    const checkOut = await recordAttendancePunch({
      employee,
      capturedAt: checkOutAt,
      recognitionMethod: 'device',
    });

    expect(checkIn.businessDate).toBe('2026-09-01');
    expect(checkOut.businessDate).toBe('2026-09-01');
    expect(checkOut.record).toBe(checkIn.record);
    expect(checkOut.record.checkInAt).toEqual(checkInAt);
    expect(checkOut.record.checkOutAt).toEqual(checkOutAt);
    expect(checkOut.record.attendanceState).toBe('present');
    expect(checkOut.record.punches).toHaveLength(2);
    expect(attendanceModel.create).toHaveBeenCalledTimes(1);
    expect(records.has('employee-1:outlet-1:2026-09-02')).toBe(false);
  });

  it('uses the earliest and latest device events when punches arrive out of order', async () => {
    const punches = [
      new Date('2026-09-01T16:00:00.000Z'), // Sep 1, 21:00 PKT
      new Date('2026-09-01T22:00:00.000Z'), // Sep 2, 03:00 PKT
      new Date('2026-09-01T13:00:00.000Z'), // Sep 1, 18:00 PKT (uploaded late)
      new Date('2026-09-01T18:00:00.000Z'), // Sep 1, 23:00 PKT (uploaded last)
    ];

    for (const capturedAt of punches) {
      await recordAttendancePunch({ employee, capturedAt, recognitionMethod: 'device' });
    }

    const record = records.get('employee-1:outlet-1:2026-09-01');
    expect(record.checkInAt).toEqual(new Date('2026-09-01T13:00:00.000Z'));
    expect(record.checkOutAt).toEqual(new Date('2026-09-01T22:00:00.000Z'));
    expect(record.punches).toHaveLength(4);
    expect(record.attendanceState).toBe('present');
    expect(attendanceModel.create).toHaveBeenCalledTimes(1);
  });

  it('keeps manual effective times authoritative while retaining device punches', async () => {
    const manualCheckIn = new Date('2026-09-01T13:15:00.000Z');
    const manualRecord = {
      employee: employee._id,
      outlet: employee.outlet._id,
      businessDate: '2026-09-01',
      capturedAt: manualCheckIn,
      checkInAt: manualCheckIn,
      checkOutAt: null,
      attendanceState: 'incomplete',
      punches: [],
      manualOverride: true,
      recognitionMethod: 'manual',
      status: 'approved',
      save: vi.fn(async function save() { return this; }),
    };
    records.set('employee-1:outlet-1:2026-09-01', manualRecord);

    const devicePunch = new Date('2026-09-01T22:00:00.000Z');
    const result = await recordAttendancePunch({
      employee,
      capturedAt: devicePunch,
      recognitionMethod: 'device',
    });

    expect(result.record.checkInAt).toEqual(manualCheckIn);
    expect(result.record.checkOutAt).toBeNull();
    expect(result.record.attendanceState).toBe('incomplete');
    expect(result.record.punches).toEqual([
      expect.objectContaining({ capturedAt: devicePunch, recognitionMethod: 'device' }),
    ]);
    expect(result.record.recognitionMethod).toBe('mixed');
    expect(attendanceModel.create).not.toHaveBeenCalled();
  });
});

describe('upsertManualAttendanceBatch', () => {
  beforeEach(() => {
    attendanceModel.findOne.mockReset();
    attendanceModel.findOneAndUpdate.mockReset();
  });

  it('preserves result order while processing independent rows concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    attendanceModel.findOne.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return null;
    });
    attendanceModel.findOneAndUpdate.mockImplementation(async (key) => ({
      _id: key.businessDate,
      ...key,
    }));

    const entries = Array.from({ length: 8 }, (_, index) => ({
      employee,
      businessDate: `2026-08-${String(index + 1).padStart(2, '0')}`,
      attendanceState: 'present',
      checkInTime: '18:00',
      checkOutTime: '03:00',
      reason: 'Historical attendance backfill',
      userId: 'user-1',
      conflictMode: 'override',
      batchId: 'batch-1',
    }));

    const results = await upsertManualAttendanceBatch(entries, { concurrency: 3 });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(entries.length);
    expect(results.map(({ outcome }) => outcome)).toEqual(Array(8).fill('created'));
    expect(results.map(({ record }) => record.businessDate)).toEqual(
      entries.map(({ businessDate }) => businessDate),
    );
  });
});
