import { describe, expect, it } from 'vitest';
import {
  employeeImportCnicCandidates,
  prepareEmployeeImportRows,
  summarizeEmployeeImport,
} from './employeeImport.service.js';

const outlets = [{ _id: 'outlet-1', code: 'MAIN', name: 'Main Branch' }];
const validRow = (overrides = {}) => ({
  rowNumber: 2,
  name: 'Ayesha Khan',
  cnic: '4210112345671',
  outletCode: 'main',
  salary: '45,000',
  salaryDate: 5,
  ...overrides,
});

describe('employee bulk import preparation', () => {
  it('normalizes a valid row and applies optional defaults', () => {
    const [row] = prepareEmployeeImportRows([validRow()], { outlets });

    expect(row.status).toBe('ready');
    expect(row.data).toMatchObject({
      cnic: '42101-1234567-1',
      outlet: 'outlet-1',
      outletCode: 'MAIN',
      salary: 45000,
      salaryDate: 5,
      salaryCreditLimits: {
        cashAdvanceEnabled: true,
        chargeToSalaryEnabled: true,
        dailyLimitPercent: 10,
        rollingSevenDayLimitPercent: 25,
        maxOutstandingPercent: 60,
      },
    });
    expect(summarizeEmployeeImport([row])).toEqual({ total: 1, ready: 1, duplicate: 0, invalid: 0 });
  });

  it('skips a CNIC that already belongs to any employee', () => {
    const [row] = prepareEmployeeImportRows([validRow()], {
      outlets,
      existingCnics: ['42101-1234567-1'],
    });

    expect(row.status).toBe('duplicate');
    expect(row.duplicate).toBe('existing');
    expect(row.errors).toContain('An employee with this CNIC already exists.');
  });

  it('marks every repeated CNIC in the file until the user removes one row', () => {
    const rows = [validRow(), validRow({ rowNumber: 3, name: 'Another Person' })];
    const duplicatePreview = prepareEmployeeImportRows(rows, { outlets });
    expect(duplicatePreview.every((row) => row.status === 'duplicate')).toBe(true);

    const [afterRemoval] = prepareEmployeeImportRows([rows[1]], { outlets });
    expect(afterRemoval.status).toBe('ready');
  });

  it('rejects invalid required fields and credit-limit relationships', () => {
    const [row] = prepareEmployeeImportRows([validRow({
      name: '',
      outletCode: 'missing',
      salaryDate: 29,
      dailyLimitPercent: 30,
      rollingSevenDayLimitPercent: 20,
    })], { outlets });

    expect(row.status).toBe('invalid');
    expect(row.errors).toEqual(expect.arrayContaining([
      'Name is required.',
      'Outlet Code "MISSING" was not found or is inactive.',
      'Salary Day must be a whole number from 1 to 28.',
      'Daily credit limit cannot exceed the rolling 7-day limit.',
    ]));
  });

  it('keeps repeated malformed CNIC values classified as invalid', () => {
    const rows = prepareEmployeeImportRows([
      validRow({ rowNumber: 2, cnic: 'not-a-cnic' }),
      validRow({ rowNumber: 3, cnic: 'not-a-cnic' }),
    ], { outlets });

    expect(rows.map((row) => row.status)).toEqual(['invalid', 'invalid']);
    expect(rows.every((row) => row.duplicate === null)).toBe(true);
  });

  it('returns only valid normalized CNIC candidates for database lookup', () => {
    expect(employeeImportCnicCandidates([
      validRow(),
      validRow({ cnic: 'bad' }),
      validRow({ cnic: '42101-1234567-1' }),
    ])).toEqual(['42101-1234567-1']);
  });
});
