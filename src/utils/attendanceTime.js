// Shared attendance date/shift helpers.
//
// These were originally private inside controllers/attendance.controller.js.
// They're pure functions (no DB, no I/O) so they're extracted here to be
// reused by the Hikvision device webhook without duplicating the timezone
// logic. Behaviour is identical to the original inline versions.

import { getBusinessDate } from './businessDate.js';

export const DEFAULT_TZ = 'Asia/Karachi';

export const formatDateKey = (date, timeZone = DEFAULT_TZ) => new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
}).format(date);

export const formatTimeParts = (date, timeZone = DEFAULT_TZ) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return { hour, minute };
};

export const parseShiftMinutes = (value) => {
    if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(':').map(Number);
    return (hours * 60) + minutes;
};

const addDaysToDateKey = (dateKey, days) => {
    const value = new Date(`${dateKey}T12:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
};

export const toLocalDateTimeUtcMs = (dateKey, time, timeZone = DEFAULT_TZ) => {
    const minutes = parseShiftMinutes(time);
    if (minutes === null) return NaN;
    return toDayStartUtcMs(dateKey, timeZone) + (minutes * 60 * 1000);
};

// Invert the same reporting-day rule used for device scans. Only the overnight
// portion before closing rolls forward; a morning shift after closing but
// before opening still starts on the selected calendar date.
export const toBusinessDateTimeUtcMs = ({
    dateKey,
    time,
    timeZone = DEFAULT_TZ,
    businessDayStart = '00:00',
    businessDayEnd = businessDayStart,
}) => {
    const instant = toLocalDateTimeUtcMs(dateKey, time, timeZone);
    if (!Number.isFinite(instant)) return NaN;
    const reportingDate = getBusinessDate(new Date(instant), timeZone, businessDayStart, businessDayEnd);
    return reportingDate === dateKey
        ? instant
        : toLocalDateTimeUtcMs(addDaysToDateKey(dateKey, 1), time, timeZone);
};

// Compute the UTC milliseconds for local midnight of `dateKey` in `timeZone`.
// We try possible timezone offsets in 15-minute increments and pick the one
// where the constructed ISO timestamp maps back to the same local date/time
// in the requested timeZone. This avoids adding timezone libraries.
export const toDayStartUtcMs = (dateKey, timeZone = DEFAULT_TZ) => {
    if (!dateKey) return NaN;
    try {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        // Try offsets from -12:00 to +14:00 in 15-minute steps
        for (let offset = -12 * 60; offset <= 14 * 60; offset += 15) {
            const sign = offset >= 0 ? '+' : '-';
            const abs = Math.abs(offset);
            const hh = String(Math.floor(abs / 60)).padStart(2, '0');
            const mm = String(abs % 60).padStart(2, '0');
            const iso = `${dateKey}T00:00:00${sign}${hh}:${mm}`;
            const t = Date.parse(iso);
            if (Number.isNaN(t)) continue;

            const parts = fmt.formatToParts(new Date(t));
            const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
            const formattedDate = `${partMap.year}-${partMap.month}-${partMap.day}`;
            const formattedTime = `${partMap.hour}:${partMap.minute}:${partMap.second}`;
            if (formattedDate === dateKey && formattedTime === '00:00:00') {
                return t;
            }
        }
    } catch (e) {
        // fallback to naive UTC parse
    }
    return Date.parse(`${dateKey}T00:00:00.000Z`);
};

export const computeShiftMetrics = ({
    dateKey,
    capturedAt,
    checkInAt,
    checkOutAt,
    shiftStart,
    shiftEnd,
    timeZone = DEFAULT_TZ,
    businessDayStart = '00:00',
    businessDayEnd = businessDayStart,
    graceMinutes = null,
}) => {
    const shiftStartMinutes = parseShiftMinutes(shiftStart);
    const shiftEndMinutes = parseShiftMinutes(shiftEnd);

    if (shiftStartMinutes === null || shiftEndMinutes === null) {
        return {
            scheduledHours: null,
            lateMinutes: null,
            earlyArrivalMinutes: null,
            overnightShift: null,
            recommendation: 'review',
            recommendationReason: 'Shift timings are missing for this employee.',
        };
    }

    const scheduledStartMs = toBusinessDateTimeUtcMs({
        dateKey,
        time: shiftStart,
        timeZone,
        businessDayStart,
        businessDayEnd,
    });
    let scheduledEndMs = toBusinessDateTimeUtcMs({
        dateKey,
        time: shiftEnd,
        timeZone,
        businessDayStart,
        businessDayEnd,
    });
    const overnightShift = shiftEndMinutes <= shiftStartMinutes;

    if (scheduledEndMs <= scheduledStartMs) {
        scheduledEndMs += 24 * 60 * 60 * 1000;
    }

    const effectiveCheckIn = checkInAt || capturedAt;
    const capturedMs = effectiveCheckIn ? new Date(effectiveCheckIn).getTime() : NaN;
    const checkoutMs = checkOutAt ? new Date(checkOutAt).getTime() : NaN;
    const deltaMinutes = Math.round((capturedMs - scheduledStartMs) / 60000);
    const hasGracePolicy = typeof graceMinutes === 'number' && Number.isFinite(graceMinutes) && graceMinutes >= 0;
    const grace = hasGracePolicy ? graceMinutes : 0;
    // A configured zero means no tolerance, including sub-minute lateness.
    const lateMinutes = Number.isFinite(deltaMinutes)
        ? Math.max(0, hasGracePolicy ? Math.ceil((capturedMs - scheduledStartMs) / 60000) : deltaMinutes)
        : null;
    const earlyArrivalMinutes = Number.isFinite(deltaMinutes) ? Math.max(0, -deltaMinutes) : null;
    const scheduledHours = Number(((scheduledEndMs - scheduledStartMs) / 3600000).toFixed(2));
    const checkoutDelta = Number.isFinite(checkoutMs)
        ? Math.round((checkoutMs - scheduledEndMs) / 60000)
        : null;
    const earlyDepartureMinutes = checkoutDelta === null ? null : Math.max(0,
        hasGracePolicy ? Math.ceil((scheduledEndMs - checkoutMs) / 60000) : -checkoutDelta);
    const overtimeMinutes = checkoutDelta === null ? null : Math.max(0, checkoutDelta);
    const workedMinutes = Number.isFinite(capturedMs) && Number.isFinite(checkoutMs) && checkoutMs >= capturedMs
        ? Math.round((checkoutMs - capturedMs) / 60000)
        : null;

    let recommendation = 'approve';
    let recommendationReason = 'On time based on scheduled shift.';
    const reviewTolerance = hasGracePolicy ? grace : 15;
    const isLate = lateMinutes !== null && lateMinutes > grace;
    const isEarlyDeparture = earlyDepartureMinutes !== null && earlyDepartureMinutes > grace;
    const arrivalWithinGrace = lateMinutes > 0 && !isLate;
    const departureWithinGrace = earlyDepartureMinutes > 0 && !isEarlyDeparture;
    if (arrivalWithinGrace || departureWithinGrace) {
        recommendationReason = 'Within the terminal grace period.';
    }

    if (lateMinutes > Math.max(60, reviewTolerance)) {
        recommendation = 'not_recommended';
        recommendationReason = `Employee checked in ${lateMinutes} minutes late.`;
    } else if (lateMinutes > reviewTolerance) {
        recommendation = 'review';
        recommendationReason = `Employee checked in ${lateMinutes} minutes late. Review before approval.`;
    }

    if (earlyDepartureMinutes > Math.max(60, reviewTolerance)) {
        recommendation = 'not_recommended';
        recommendationReason = `Employee checked out ${earlyDepartureMinutes} minutes before shift end.`;
    } else if (earlyDepartureMinutes > reviewTolerance && recommendation !== 'not_recommended') {
        recommendation = 'review';
        recommendationReason = `Employee checked out ${earlyDepartureMinutes} minutes before shift end. Review before approval.`;
    } else if (!Number.isFinite(checkoutMs) && recommendation === 'approve') {
        recommendation = 'review';
        recommendationReason = 'Checkout is missing for this attendance day.';
    }

    return {
        scheduledHours,
        lateMinutes,
        earlyArrivalMinutes,
        earlyDepartureMinutes,
        isLate,
        isEarlyDeparture,
        arrivalWithinGrace,
        departureWithinGrace,
        overtimeMinutes,
        workedMinutes,
        workedHours: workedMinutes === null ? null : Number((workedMinutes / 60).toFixed(2)),
        missingCheckIn: !Number.isFinite(capturedMs),
        missingCheckout: !Number.isFinite(checkoutMs),
        overnightShift,
        recommendation,
        recommendationReason,
    };
};
