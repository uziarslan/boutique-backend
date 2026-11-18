const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const MANUAL_ATTENDANCE_STATES = new Set(['on_time', 'late', 'off', 'absent']);

const badRequest = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
};

const shiftPeriod = (period, offset = 1) => {
    const [year, month] = String(period || '').split('-').map(Number);
    const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const shiftDurationHours = (shiftStart, shiftEnd) => {
    const parseMinutes = (value) => {
        const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours > 23 || minutes > 59) return null;
        return (hours * 60) + minutes;
    };

    const startMinutes = parseMinutes(shiftStart);
    const endMinutes = parseMinutes(shiftEnd);
    if (startMinutes === null || endMinutes === null) return null;
    let durationMinutes = endMinutes - startMinutes;
    if (durationMinutes <= 0) durationMinutes += 24 * 60;
    return durationMinutes / 60;
};

const calculateOffDutySalary = ({
    period,
    periodDays,
    normalizedBaseSalary,
    submittedGross,
    rawAttendanceCalculation,
    employee,
}) => {
    const paidOffDutyLimit = Number(employee?.paidOffDutyDays
        ?? rawAttendanceCalculation.paidOffDutyLimit
        ?? rawAttendanceCalculation.paidOffDutyDays
        ?? 4);
    const paidOffDutyDays = Number(rawAttendanceCalculation.paidOffDutyDays ?? paidOffDutyLimit);
    const workedDays = Number(rawAttendanceCalculation.workedDays ?? rawAttendanceCalculation.payableDays);
    const devicePresentDays = Number(rawAttendanceCalculation.devicePresentDays || 0);
    // Older clients did not send overtimeEnabled, so preserve their explicit
    // overtime values. New clients must opt in before overtime is applied.
    const overtimeRequested = Number(rawAttendanceCalculation.overtimeMinutes || 0);
    const overtimeEnabled = rawAttendanceCalculation.overtimeEnabled === undefined
        ? overtimeRequested > 0
        : rawAttendanceCalculation.overtimeEnabled === true;
    const overtimeMinutes = overtimeEnabled ? overtimeRequested : 0;

    if (!Number.isInteger(paidOffDutyLimit) || paidOffDutyLimit < 0 || paidOffDutyLimit > 15
        || paidOffDutyLimit >= periodDays) {
        badRequest(`Paid off-duty maximum must be a whole number between 0 and ${Math.min(15, periodDays - 1)}.`);
    }
    if (!Number.isInteger(paidOffDutyDays) || paidOffDutyDays < 0 || paidOffDutyDays > paidOffDutyLimit
        || paidOffDutyDays >= periodDays) {
        badRequest(`Selected paid off-duty days must be a whole number between 0 and the employee maximum of ${paidOffDutyLimit}.`);
    }
    if (!Number.isInteger(workedDays) || workedDays < 0 || workedDays > periodDays) {
        badRequest(`Worked attendance days must be between 0 and ${periodDays}.`);
    }
    if (!Number.isInteger(devicePresentDays) || devicePresentDays < 0 || devicePresentDays > periodDays) {
        badRequest(`Device attendance days must be between 0 and ${periodDays}.`);
    }
    if (!Number.isInteger(overtimeMinutes) || overtimeMinutes < 0 || overtimeMinutes > periodDays * 24 * 60) {
        badRequest('Overtime minutes must be a non-negative whole number within the selected period.');
    }

    // Use the entitlement, not the days actually taken off, so working an
    // entitled off day earns holiday-work pay above the monthly requirement.
    const workingDays = periodDays - paidOffDutyLimit;
    const dailyRateRaw = normalizedBaseSalary / workingDays;
    const regularPaidDays = Math.min(workedDays, workingDays);
    const holidayWorkedDays = Math.max(0, workedDays - workingDays);
    const unpaidDays = Math.max(0, workingDays - workedDays);
    const baseEarned = workedDays >= workingDays
        ? normalizedBaseSalary
        : round2(dailyRateRaw * regularPaidDays);
    const holidayWorkPay = round2(dailyRateRaw * holidayWorkedDays);
    const shiftHoursRaw = shiftDurationHours(employee?.shiftStart, employee?.shiftEnd);

    if (overtimeMinutes > 0 && !shiftHoursRaw) {
        badRequest('Set valid shift start and end times for this employee before paying overtime.');
    }

    const hourlyRateRaw = shiftHoursRaw ? dailyRateRaw / shiftHoursRaw : 0;
    const overtimePay = round2((overtimeMinutes / 60) * hourlyRateRaw);
    if (rawAttendanceCalculation.prepaidDates != null
        && !Array.isArray(rawAttendanceCalculation.prepaidDates)) {
        badRequest('Prepaid salary dates must be a list.');
    }
    const prepaidDates = Array.isArray(rawAttendanceCalculation.prepaidDates)
        ? rawAttendanceCalculation.prepaidDates.map((date) => String(date || ''))
        : [];
    const prepaidPeriod = shiftPeriod(period, 1);
    const [prepaidYear, prepaidMonth] = prepaidPeriod.split('-').map(Number);
    const prepaidPeriodDays = new Date(Date.UTC(prepaidYear, prepaidMonth, 0)).getUTCDate();
    const seenPrepaidDates = new Set();
    for (const date of prepaidDates) {
        const match = /^(\d{4}-\d{2})-(\d{2})$/.exec(date);
        const day = Number(match?.[2]);
        if (match?.[1] !== prepaidPeriod
            || !Number.isInteger(day) || day < 1 || day > prepaidPeriodDays) {
            badRequest(`Prepaid salary date "${date}" must be within ${prepaidPeriod}.`);
        }
        if (seenPrepaidDates.has(date)) badRequest(`Prepaid salary date "${date}" is duplicated.`);
        seenPrepaidDates.add(date);
    }
    const prepaidWorkingDays = prepaidPeriodDays - paidOffDutyLimit;
    const prepaidDailyRateRaw = normalizedBaseSalary / prepaidWorkingDays;
    const prepaidPay = round2(prepaidDailyRateRaw * prepaidDates.length);
    const gross = round2(baseEarned + holidayWorkPay + prepaidPay + overtimePay);

    if (!Number.isFinite(submittedGross) || Math.abs(round2(submittedGross) - gross) > 0.01) {
        badRequest('Salary amount does not match the attendance, paid-ahead, off-duty, and overtime calculation. Please review and try again.');
    }

    return {
        gross,
        attendanceCalculation: {
            calculationVersion: 2,
            baseSalary: normalizedBaseSalary,
            periodDays,
            paidOffDutyDays,
            paidOffDutyLimit,
            workingDays,
            devicePresentDays,
            payableDays: workedDays,
            workedDays,
            regularPaidDays,
            holidayWorkedDays,
            unpaidDays,
            dailyRate: round2(dailyRateRaw),
            baseEarned,
            attendanceDeduction: round2(normalizedBaseSalary - baseEarned),
            holidayWorkPay,
            prepaidPeriod,
            prepaidDates,
            prepaidDays: prepaidDates.length,
            prepaidDailyRate: round2(prepaidDailyRateRaw),
            prepaidPay,
            shiftHours: shiftHoursRaw ? round2(shiftHoursRaw) : 0,
            hourlyRate: round2(hourlyRateRaw),
            overtimeEnabled,
            overtimeMinutes,
            overtimePay,
            manualOverrides: rawAttendanceCalculation.manualOverrides.map((override) => ({
                date: override.date,
                present: override.present,
                ...(override.state ? { state: override.state } : {}),
            })),
        },
    };
};

export const calculateAttendanceAdjustedSalary = ({
    period,
    grossAmount,
    rawAttendanceCalculation,
    employee,
}) => {
    if (rawAttendanceCalculation == null) {
        const gross = Number(grossAmount);
        if (!Number.isFinite(gross) || gross < 0) {
            badRequest('Gross salary must be a non-negative amount.');
        }
        return { gross: round2(gross), attendanceCalculation: undefined };
    }

    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        badRequest('A valid salary period is required for attendance calculation.');
    }

    const [year, month] = period.split('-').map(Number);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        badRequest('A valid salary period is required for attendance calculation.');
    }
    const periodDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const baseSalary = Number(rawAttendanceCalculation.baseSalary);
    const payableDays = Number(rawAttendanceCalculation.payableDays);
    const devicePresentDays = Number(rawAttendanceCalculation.devicePresentDays || 0);
    if (rawAttendanceCalculation.manualOverrides != null
        && !Array.isArray(rawAttendanceCalculation.manualOverrides)) {
        badRequest('Manual attendance overrides must be a list.');
    }
    const manualOverrides = Array.isArray(rawAttendanceCalculation.manualOverrides)
        ? rawAttendanceCalculation.manualOverrides
        : [];

    if (!Number.isFinite(baseSalary) || baseSalary < 0) {
        badRequest('Attendance base salary must be a non-negative amount.');
    }
    if (!Number.isInteger(payableDays) || payableDays < 0 || payableDays > periodDays) {
        badRequest(`Payable attendance days must be between 0 and ${periodDays}.`);
    }
    if (!Number.isInteger(devicePresentDays) || devicePresentDays < 0 || devicePresentDays > periodDays) {
        badRequest(`Device attendance days must be between 0 and ${periodDays}.`);
    }
    if (manualOverrides.length > periodDays) {
        badRequest('Too many manual attendance overrides for the selected period.');
    }

    const seenOverrideDates = new Set();
    for (const override of manualOverrides) {
        const date = String(override?.date || '');
        const day = Number(date.slice(-2));
        if (!date.startsWith(`${period}-`) || !Number.isInteger(day) || day < 1 || day > periodDays) {
            badRequest(`Manual attendance override "${date}" is outside ${period}.`);
        }
        if (typeof override.present !== 'boolean') {
            badRequest(`Manual attendance override "${date}" must specify present or absent.`);
        }
        if (override.state != null && !MANUAL_ATTENDANCE_STATES.has(override.state)) {
            badRequest(`Manual attendance override "${date}" has an invalid payroll state.`);
        }
        if (override.state != null) {
            const expectedPresent = override.state === 'on_time' || override.state === 'late';
            if (override.present !== expectedPresent) {
                badRequest(`Manual attendance override "${date}" does not match its payroll state.`);
            }
        }
        if (seenOverrideDates.has(date)) {
            badRequest(`Manual attendance override "${date}" is duplicated.`);
        }
        seenOverrideDates.add(date);
    }

    const normalizedBaseSalary = round2(baseSalary);
    const submittedGross = Number(grossAmount);

    if (Number(rawAttendanceCalculation.calculationVersion) === 2) {
        return calculateOffDutySalary({
            period,
            periodDays,
            normalizedBaseSalary,
            submittedGross,
            rawAttendanceCalculation: { ...rawAttendanceCalculation, manualOverrides },
            employee,
        });
    }

    const gross = round2((normalizedBaseSalary / periodDays) * payableDays);
    if (!Number.isFinite(submittedGross) || Math.abs(round2(submittedGross) - gross) > 0.01) {
        badRequest('Salary amount does not match the attendance calculation. Please review the calendar and try again.');
    }

    return {
        gross,
        attendanceCalculation: {
            baseSalary: normalizedBaseSalary,
            periodDays,
            devicePresentDays,
            payableDays,
            unpaidDays: periodDays - payableDays,
            attendanceDeduction: round2(normalizedBaseSalary - gross),
            manualOverrides: manualOverrides.map((override) => ({
                date: override.date,
                present: override.present,
                ...(override.state ? { state: override.state } : {}),
            })),
        },
    };
};
