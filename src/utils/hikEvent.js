// Pure helpers for interpreting Hikvision access-control event payloads.
// Kept separate from the route so they can be unit-tested without any DB /
// tenant plumbing. The device posts events as JSON (push notification) or as
// multipart/form-data (a JSON part + optional face JPEG); these helpers accept
// the parsed express/multer shapes and normalise both.

// major === 5 is the access-control event category. Minor codes vary by
// firmware:
//   75 = "face authentication passed" on some DS-K1T3xx firmware.
//   38 = "identity verification passed" on V3.5.2 (DS-K1T320MFWX-B) --
//        observed live, carrying employeeNoString + currentVerifyMode:
//        "faceOrFpOrCardOrPw" on every successful scan during on-site
//        testing 2026-08-28.
// Extend ACCEPTED_SUCCESS_MINORS if another client's device reports face
// success under yet another minor -- the webhook route logs the exact
// major/minor of anything it declines, so check the logs first.
export const ACCESS_CONTROL_MAJOR = 5;
export const ACCEPTED_SUCCESS_MINORS = new Set([75, 38]);

const tryParseJson = (value) => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
};

const asNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Pull the AccessControllerEvent out of whatever shape arrived: a push
// notification (wrapped in EventNotificationAlert), an AcsEvent search result,
// or the bare object. Returns { ace, alert } or null.
export const pickAccessEvent = (obj) => {
  if (!obj || typeof obj !== 'object') return null;
  const alert = obj.EventNotificationAlert || obj;
  const ace =
    alert.AccessControllerEvent ||
    obj.AccessControllerEvent ||
    (alert.eventType === 'AccessControllerEvent' ? alert : null);
  if (ace && typeof ace === 'object') return { ace, alert };
  return null;
};

// Scan every candidate (the raw body, each JSON-ish body field, and each
// uploaded file's buffer) for the first AccessControllerEvent. `body` is
// req.body; `files` is req.files (multer array).
export const extractAccessEvent = ({ body, files } = {}) => {
  const candidates = [];
  if (body && typeof body === 'object') {
    candidates.push(body);
    for (const val of Object.values(body)) {
      const parsed = tryParseJson(val);
      if (parsed) candidates.push(parsed);
    }
  }
  if (Array.isArray(files)) {
    for (const f of files) {
      const parsed = tryParseJson(f?.buffer?.toString('utf8'));
      if (parsed) candidates.push(parsed);
    }
  }
  for (const c of candidates) {
    const hit = pickAccessEvent(c);
    if (hit) return hit;
  }
  return null;
};

// Turn a { ace, alert } hit into normalised, decision-ready fields.
//   employeeNo — the mapped person id (employeeNoString, trimmed)
//   isSuccess  — true when this is a successful authentication we should record
//   capturedAt — parsed event Date, or null (caller falls back to now)
export const evaluateAccessEvent = (hit) => {
  if (!hit) return null;
  const { ace, alert = {} } = hit;
  const employeeNo = String(ace.employeeNoString ?? ace.employeeNo ?? '').trim();
  const major = asNumber(ace.majorEventType ?? ace.major);
  const minor = asNumber(ace.subEventType ?? ace.minor);
  const hasCodes = major !== null && minor !== null;
  // Success when the event carries no codes at all (some firmwares omit them on
  // the httpHosts channel but still attach an employee) OR it's an
  // access-control success minor.
  const isSuccess = !hasCodes || (major === ACCESS_CONTROL_MAJOR && ACCEPTED_SUCCESS_MINORS.has(minor));
  const timeRaw = alert.dateTime || ace.time || ace.dateTime || null;
  const parsed = timeRaw ? new Date(timeRaw) : null;
  const capturedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const serialNo = String(alert.serialNo ?? ace.serialNo ?? '').trim();
  return { employeeNo, major, minor, hasCodes, isSuccess, capturedAt, serialNo };
};
