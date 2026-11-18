export const MAX_EMPLOYEE_IMPORT_ROWS = 500;
export const EMPLOYEE_IMPORT_MODES = ['skip', 'changes_only', 'entire_record'];

// Only template fields can be overwritten. Identity, enrollment, activity,
// audit metadata, and payroll/attendance links stay on the existing employee.
export const EMPLOYEE_IMPORT_FIELDS = {
  name: 'Name',
  phone: 'Phone',
  address: 'Address',
  designation: 'Designation',
  department: 'Department',
  outlet: 'Outlet',
  joiningDate: 'Joining Date',
  salary: 'Monthly Salary',
  salaryDate: 'Salary Day',
  paidOffDutyDays: 'Paid Off-Duty Days',
  bankName: 'Bank Name',
  bankAccount: 'Bank Account',
  shiftStart: 'Shift Start',
  shiftEnd: 'Shift End',
  'salaryCreditLimits.cashAdvanceEnabled': 'Cash Advance Enabled',
  'salaryCreditLimits.chargeToSalaryEnabled': 'Charge to Salary Enabled',
  'salaryCreditLimits.dailyLimitPercent': 'Daily Credit Limit (%)',
  'salaryCreditLimits.rollingSevenDayLimitPercent': 'Rolling 7-Day Limit (%)',
  'salaryCreditLimits.maxOutstandingPercent': 'Maximum Outstanding (%)',
  deviceEmployeeNo: 'Device Employee No.',
};

const fieldValue = (record, path) => path.split('.').reduce((value, key) => value?.[key], record);
const isBlank = (value) => value === null || value === undefined
  || (typeof value === 'string' && value.trim() === '');
const importValue = (row, field) => field.startsWith('salaryCreditLimits.')
  ? row?.[field.split('.')[1]] ?? fieldValue(row, field)
  : row?.[field];

const comparableValue = (value, field) => {
  if (isBlank(value)) return null;
  if (field === 'joiningDate') return new Date(value).toISOString().slice(0, 10);
  if (field === 'outlet') return String(value?._id ?? value);
  return value;
};

export const employeeImportUpdate = (row, duplicateMode) => Object.fromEntries(
  (duplicateMode === 'entire_record' ? Object.keys(EMPLOYEE_IMPORT_FIELDS) : row.changes.map(({ field }) => field))
    .map((field) => [field, fieldValue(row.data, field) ?? null]),
);

const text = (value) => String(value ?? '').trim();

export const normalizeEmployeeImportCnic = (value) => {
  const digits = text(value).replace(/\D/g, '');
  if (digits.length !== 13) return text(value);
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
};

const numberValue = (value) => {
  if (isBlank(value)) return null;
  const normalized = typeof value === 'string'
    ? value.replace(/[,\s]/g, '').replace(/^PKR/i, '').replace(/^Rs\.?/i, '')
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const optionalNumberValue = (value, fallback) => (
  isBlank(value) ? fallback : numberValue(value)
);

const booleanValue = (value, fallback) => {
  if (isBlank(value)) return { value: fallback };
  if (typeof value === 'boolean') return { value };
  const normalized = text(value).toLowerCase();
  if (['yes', 'y', 'true', '1', 'on', 'enabled'].includes(normalized)) return { value: true };
  if (['no', 'n', 'false', '0', 'off', 'disabled'].includes(normalized)) return { value: false };
  return { value: fallback, error: 'Use Yes or No.' };
};

const dateValue = (value) => {
  if (isBlank(value)) return { value: undefined };
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw) {
      return { value: raw };
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: 'Use a valid date in YYYY-MM-DD format.' };
  return { value: parsed.toISOString().slice(0, 10) };
};

const timeValue = (value) => {
  if (isBlank(value)) return { value: '' };
  const raw = text(value);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw)
    ? { value: raw }
    : { value: raw, error: 'Use 24-hour HH:MM format.' };
};

const outletIdentity = (outlet) => ({
  id: String(outlet?._id ?? outlet?.id ?? ''),
  code: text(outlet?.code).toUpperCase(),
  name: text(outlet?.name),
});

export const employeeImportCnicCandidates = (rows = []) => [...new Set(
  rows
    .map((row) => normalizeEmployeeImportCnic(row?.cnic))
    .filter((cnic) => /^\d{5}-\d{7}-\d$/.test(cnic)),
)];

export const prepareEmployeeImportRows = (
  rows,
  { outlets = [], existingCnics = [], existingEmployees = [], duplicateMode = 'skip' } = {},
) => {
  const outletByCode = new Map(
    outlets.map(outletIdentity).filter((outlet) => outlet.id && outlet.code).map((outlet) => [outlet.code, outlet]),
  );
  const employeeByCnic = new Map(existingEmployees.map((employee) => [normalizeEmployeeImportCnic(employee.cnic), employee]));
  const existing = new Set([...existingCnics, ...employeeByCnic.keys()].map(normalizeEmployeeImportCnic));
  const cnicCounts = new Map();

  for (const row of rows || []) {
    const cnic = normalizeEmployeeImportCnic(row?.cnic);
    if (cnic) cnicCounts.set(cnic, (cnicCounts.get(cnic) || 0) + 1);
  }

  return (rows || []).map((rawRow, index) => {
    const matchedEmployee = employeeByCnic.get(normalizeEmployeeImportCnic(rawRow?.cnic));
    const row = { ...rawRow };
    if (matchedEmployee && duplicateMode === 'changes_only') {
      // Merge BEFORE validation so omitted values retain the stored values,
      // including individual nested credit settings. Zero and No are changes.
      for (const field of Object.keys(EMPLOYEE_IMPORT_FIELDS)) {
        const inputField = field === 'outlet' ? 'outletCode' : field.split('.').at(-1);
        const supplied = field === 'outlet' ? row.outletCode : importValue(rawRow, field);
        row[inputField] = isBlank(supplied)
          ? field === 'outlet'
            ? outlets.map(outletIdentity).find((outlet) => outlet.id === String(matchedEmployee.outlet?._id ?? matchedEmployee.outlet))?.code
            : fieldValue(matchedEmployee, field)
          : supplied;
      }
    }
    const rowNumber = Number(row?.rowNumber) || index + 2;
    const errors = [];
    const name = text(row?.name);
    const cnic = normalizeEmployeeImportCnic(row?.cnic);
    const outletCode = text(row?.outletCode).toUpperCase();
    const outlet = outletByCode.get(outletCode);
    const salary = numberValue(row?.salary);
    const salaryDate = numberValue(row?.salaryDate);
    const paidOffDutyDays = optionalNumberValue(row?.paidOffDutyDays, 4);
    const joiningDate = dateValue(row?.joiningDate);
    const shiftStart = timeValue(row?.shiftStart);
    const shiftEnd = timeValue(row?.shiftEnd);
    const dailyLimitPercent = optionalNumberValue(
      row?.dailyLimitPercent ?? row?.salaryCreditLimits?.dailyLimitPercent,
      10,
    );
    const rollingSevenDayLimitPercent = optionalNumberValue(
      row?.rollingSevenDayLimitPercent ?? row?.salaryCreditLimits?.rollingSevenDayLimitPercent,
      25,
    );
    const maxOutstandingPercent = optionalNumberValue(
      row?.maxOutstandingPercent ?? row?.salaryCreditLimits?.maxOutstandingPercent,
      60,
    );
    const cashAdvanceEnabled = booleanValue(
      row?.cashAdvanceEnabled ?? row?.salaryCreditLimits?.cashAdvanceEnabled,
      true,
    );
    const chargeToSalaryEnabled = booleanValue(
      row?.chargeToSalaryEnabled ?? row?.salaryCreditLimits?.chargeToSalaryEnabled,
      true,
    );

    if (!name) errors.push('Name is required.');
    if (!/^\d{5}-\d{7}-\d$/.test(cnic)) errors.push('CNIC must use XXXXX-XXXXXXX-X (or 13 digits).');
    if (!outletCode) errors.push('Outlet Code is required.');
    else if (!outlet) errors.push(`Outlet Code "${outletCode}" was not found or is inactive.`);
    if (salary === null || salary < 0) errors.push('Monthly Salary must be zero or greater.');
    if (salaryDate === null || !Number.isInteger(salaryDate) || salaryDate < 1 || salaryDate > 28) {
      errors.push('Salary Day must be a whole number from 1 to 28.');
    }
    if (paidOffDutyDays === null || !Number.isInteger(paidOffDutyDays)
      || paidOffDutyDays < 0 || paidOffDutyDays > 15) {
      errors.push('Paid Off-Duty Days must be a whole number from 0 to 15.');
    }
    if (joiningDate.error) errors.push(joiningDate.error);
    if (shiftStart.error) errors.push(`Shift Start: ${shiftStart.error}`);
    if (shiftEnd.error) errors.push(`Shift End: ${shiftEnd.error}`);

    const creditValues = [dailyLimitPercent, rollingSevenDayLimitPercent, maxOutstandingPercent];
    if (creditValues.some((value) => value === null || value < 0 || value > 60)) {
      errors.push('Credit limit percentages must be between 0 and 60.');
    } else {
      if (dailyLimitPercent > rollingSevenDayLimitPercent) {
        errors.push('Daily credit limit cannot exceed the rolling 7-day limit.');
      }
      if (rollingSevenDayLimitPercent > maxOutstandingPercent) {
        errors.push('Rolling 7-day limit cannot exceed maximum outstanding.');
      }
    }
    if (cashAdvanceEnabled.error) errors.push(`Cash Advance Enabled: ${cashAdvanceEnabled.error}`);
    if (chargeToSalaryEnabled.error) errors.push(`Charge to Salary Enabled: ${chargeToSalaryEnabled.error}`);
    if (text(row?.deviceEmployeeNo).length > 64) errors.push('Device Employee No. cannot exceed 64 characters.');

    let duplicate = null;
    if (/^\d{5}-\d{7}-\d$/.test(cnic) && (cnicCounts.get(cnic) || 0) > 1) {
      duplicate = 'file';
      errors.push('This CNIC appears more than once in the uploaded file.');
    } else if (/^\d{5}-\d{7}-\d$/.test(cnic) && existing.has(cnic)) {
      duplicate = 'existing';
      if (duplicateMode === 'skip' || !matchedEmployee) {
        errors.push('An employee with this CNIC already exists.');
      }
    }

    const data = {
        name,
        cnic,
        phone: text(row?.phone),
        address: text(row?.address),
        designation: text(row?.designation),
        department: text(row?.department),
        outlet: outlet?.id || '',
        outletCode,
        outletName: outlet?.name || '',
        joiningDate: joiningDate.value,
        salary,
        salaryDate,
        paidOffDutyDays,
        bankName: text(row?.bankName),
        bankAccount: text(row?.bankAccount),
        shiftStart: shiftStart.value,
        shiftEnd: shiftEnd.value,
        salaryCreditLimits: {
          cashAdvanceEnabled: cashAdvanceEnabled.value,
          chargeToSalaryEnabled: chargeToSalaryEnabled.value,
          dailyLimitPercent,
          rollingSevenDayLimitPercent,
          maxOutstandingPercent,
        },
        deviceEmployeeNo: text(row?.deviceEmployeeNo) || null,
    };
    const canUpdate = duplicate === 'existing' && matchedEmployee && duplicateMode !== 'skip';
    const changes = canUpdate ? Object.entries(EMPLOYEE_IMPORT_FIELDS).flatMap(([field, label]) => {
      // Blank cells never set a key in changes-only mode, even if the stored
      // document lacks a schema default that normalization would otherwise add.
      const supplied = field === 'outlet' ? rawRow?.outletCode : importValue(rawRow, field);
      if (duplicateMode === 'changes_only' && isBlank(supplied)) return [];
      const previous = comparableValue(fieldValue(matchedEmployee, field), field);
      const next = comparableValue(fieldValue(data, field), field);
      return previous === next ? [] : [{ field, label, previous, next }];
    }) : [];
    const blockedDuplicate = duplicate === 'file' || (duplicate === 'existing' && !canUpdate);

    return {
      rowNumber,
      status: blockedDuplicate ? 'duplicate' : errors.length ? 'invalid'
        : canUpdate ? changes.length ? 'update' : 'unchanged' : 'ready',
      duplicate,
      errors,
      changes,
      existingEmployeeId: matchedEmployee?._id,
      existingUpdatedAt: matchedEmployee?.updatedAt,
      data,
    };
  });
};

export const summarizeEmployeeImport = (rows = []) => ({
  total: rows.length,
  ready: rows.filter((row) => row.status === 'ready').length,
  duplicate: rows.filter((row) => row.status === 'duplicate').length,
  invalid: rows.filter((row) => row.status === 'invalid').length,
  update: rows.filter((row) => row.status === 'update').length,
  unchanged: rows.filter((row) => row.status === 'unchanged').length,
});
