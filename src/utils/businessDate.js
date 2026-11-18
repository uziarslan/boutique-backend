const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const normalizeBusinessDayStart = (value) =>
  TIME_RE.test(String(value || '')) ? String(value) : '00:00';

export const getBusinessDate = (instant = new Date(), timezone = 'Asia/Karachi', startTime = '00:00', endTime = startTime) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Karachi',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const [startHour, startMinute] = normalizeBusinessDayStart(startTime).split(':').map(Number);
  const [endHour, endMinute] = normalizeBusinessDayStart(endTime).split(':').map(Number);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  // Equal start/end represents a continuous 24-hour business day. Otherwise,
  // only an overnight window (end earlier than start) crosses a calendar date.
  const belongsToPreviousDate = startMinutes === endMinutes
    ? currentMinutes < startMinutes
    : startMinutes > endMinutes && currentMinutes < endMinutes;
  const calendar = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (belongsToPreviousDate) calendar.setUTCDate(calendar.getUTCDate() - 1);
  return calendar.toISOString().slice(0, 10);
};

export const businessDateRange = (from, to) => {
  const range = {};
  if (from) range.$gte = String(from).slice(0, 10);
  if (to) range.$lte = String(to).slice(0, 10);
  return range;
};
