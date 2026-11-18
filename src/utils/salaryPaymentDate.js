import { endOfLocalDayUtc, localDateStr } from './timezone.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const validDateOnly = (value) => {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const invalidPaymentDate = () => {
  const error = new Error('Enter a valid payment date.');
  error.statusCode = 400;
  return error;
};

// A salary date selected in the UI represents a whole outlet calendar day.
// Keep the stored date compatible with existing records, but calculate a
// timezone-aware end-of-day cutoff for advance recovery.
export const salaryPaymentDateContext = (rawPaymentDate, timezone, now = new Date()) => {
  const raw = rawPaymentDate === undefined || rawPaymentDate === null
    ? ''
    : String(rawPaymentDate).trim();

  let paymentDate;
  let calendarDate;

  if (!raw) {
    paymentDate = new Date(now);
    calendarDate = localDateStr(paymentDate, timezone);
  } else if (DATE_ONLY_PATTERN.test(raw)) {
    if (!validDateOnly(raw)) throw invalidPaymentDate();
    paymentDate = new Date(raw);
    calendarDate = raw;
  } else {
    paymentDate = new Date(raw);
    if (Number.isNaN(paymentDate.getTime())) throw invalidPaymentDate();
    calendarDate = localDateStr(paymentDate, timezone);
  }

  if (Number.isNaN(paymentDate.getTime())) throw invalidPaymentDate();

  return {
    paymentDate,
    advanceCutoff: endOfLocalDayUtc(calendarDate, timezone),
  };
};
