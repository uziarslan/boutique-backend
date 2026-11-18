import mongoose from 'mongoose';
import Outlet from '../models/Outlet.js';

// Centralised timezone handling so business-day / month boundaries and time
// bucketing follow the OUTLET's selected clock, never the server's. All stored
// timestamps stay in UTC (correct); this module only governs how we *interpret*
// and *bucket* them for a given outlet.
//
// No external tz library — offsets are derived from Intl.DateTimeFormat.

export const DEFAULT_TZ = 'Asia/Karachi';

// Offset (minutes) of `tz` from UTC at a given instant. East-of-UTC is positive
// (e.g. Asia/Karachi → +300).
const tzOffsetMinutes = (tz, date) => {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
    // 'en-US' renders 24:00 as 24 at midnight on some engines — normalise.
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0; // unknown tz → treat as UTC
  }
};

// 'YYYY-MM-DD' calendar day for an instant, as seen in `tz`.
export const localDateStr = (date, tz) => {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    return dtf.format(date); // en-CA → YYYY-MM-DD
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

// 'YYYY-MM' month for an instant, as seen in `tz`.
export const localMonth = (date, tz) => localDateStr(date, tz).slice(0, 7);

// The UTC instant of local midnight (start of day) for a 'YYYY-MM-DD' in `tz`.
export const startOfLocalDayUtc = (dateStr, tz) => {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const guess = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
  // local-midnight-in-tz = UTC-midnight - offset. Refine once for DST edges.
  let off = tzOffsetMinutes(tz, new Date(guess));
  let utc = guess - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(utc));
  if (off2 !== off) utc = guess - off2 * 60000;
  return new Date(utc);
};

// End-of-day (23:59:59.999) UTC instant for a local 'YYYY-MM-DD' in `tz`.
export const endOfLocalDayUtc = (dateStr, tz) => {
  const start = startOfLocalDayUtc(dateStr, tz);
  // Add ~24h then take that day's start to be DST-safe, minus 1ms.
  const nextGuess = new Date(start.getTime() + 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000);
  const nextStart = startOfLocalDayUtc(localDateStr(nextGuess, tz), tz);
  return new Date(nextStart.getTime() - 1);
};

// Build a Mongo createdAt range filter ({$gte,$lte}) from local 'YYYY-MM-DD'
// from/to strings interpreted in `tz`. When neither is given, defaults to the
// local TODAY in `tz`.
export const localDateRange = (from, to, tz) => {
  if (!from && !to) {
    const today = localDateStr(new Date(), tz);
    return { $gte: startOfLocalDayUtc(today, tz), $lte: endOfLocalDayUtc(today, tz) };
  }
  const range = {};
  if (from) range.$gte = startOfLocalDayUtc(from, tz);
  if (to) range.$lte = endOfLocalDayUtc(to, tz);
  return range;
};

// Resolve the timezone to use:
//  - a specific outlet's tz (by _id or code), else
//  - the tenant default = the oldest active outlet's tz, else
//  - DEFAULT_TZ.
export const resolveOutletClock = async (outletIdOrCode) => {
  let outlet = null;
  if (outletIdOrCode) {
    outlet = mongoose.Types.ObjectId.isValid(outletIdOrCode)
      ? await Outlet.findById(outletIdOrCode).select('timezone businessDayStart businessDayEnd').lean()
      : await Outlet.findOne({ code: String(outletIdOrCode).toUpperCase() })
        .select('timezone businessDayStart businessDayEnd')
        .lean();
  }
  if (!outlet) {
    outlet = await Outlet.findOne({ isActive: true })
      .sort({ createdAt: 1 })
      .select('timezone businessDayStart businessDayEnd')
      .lean();
  }
  return {
    outletId: outlet?._id || null,
    timezone: outlet?.timezone || DEFAULT_TZ,
    businessDayStart: outlet?.businessDayStart || '00:00',
    businessDayEnd: outlet?.businessDayEnd || outlet?.businessDayStart || '00:00',
  };
};

export const resolveTimezone = async (outletIdOrCode) => {
  const clock = await resolveOutletClock(outletIdOrCode);
  return clock.timezone;
};
