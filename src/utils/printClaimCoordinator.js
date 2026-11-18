const EMPTY_PROBE_INTERVAL_MS = 10_000;
const MAX_STATION_STATES = 2_000;
const STALE_STATE_MS = 10 * 60_000;

const stationStates = new Map();

const stationKey = (stationId) => String(stationId || '');

const pruneStationStates = (now) => {
  if (stationStates.size <= MAX_STATION_STATES) return;
  for (const [key, state] of stationStates) {
    if (state.waiters.size === 0 && now - state.lastTouchedAt > STALE_STATE_MS) {
      stationStates.delete(key);
    }
    if (stationStates.size <= MAX_STATION_STATES) return;
  }
};

const getState = (stationId, now = Date.now()) => {
  const key = stationKey(stationId);
  let state = stationStates.get(key);
  if (!state) {
    state = {
      version: 0,
      emptyUntil: 0,
      lastTouchedAt: now,
      waiters: new Set(),
    };
    stationStates.set(key, state);
    pruneStationStates(now);
  }
  state.lastTouchedAt = now;
  return state;
};

export const getPrintStationSignalVersion = (stationId) => (
  getState(stationId).version
);

export const canProbePrintStation = (stationId, now = Date.now()) => (
  getState(stationId, now).emptyUntil <= now
);

export const millisecondsUntilPrintProbe = (stationId, now = Date.now()) => (
  Math.max(0, getState(stationId, now).emptyUntil - now)
);

export const markPrintStationEmpty = (
  stationId,
  observedVersion,
  ttlMs = EMPTY_PROBE_INTERVAL_MS,
  now = Date.now(),
) => {
  const state = getState(stationId, now);
  if (state.version !== observedVersion) return false;
  state.emptyUntil = now + Math.max(0, ttlMs);
  return true;
};

export const notifyPrintStation = (stationId) => {
  const state = getState(stationId);
  state.version += 1;
  state.emptyUntil = 0;
  for (const resolve of state.waiters) resolve(true);
  state.waiters.clear();
};

export const schedulePrintStationNotification = (stationId, delayMs) => {
  const timer = setTimeout(
    () => notifyPrintStation(stationId),
    Math.max(0, Number(delayMs) || 0),
  );
  timer.unref?.();
};

export const waitForPrintStationSignal = (stationId, observedVersion, timeoutMs) => {
  const state = getState(stationId);
  if (state.version !== observedVersion) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (wasSignalled) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.waiters.delete(finish);
      resolve(wasSignalled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    state.waiters.add(finish);

    // Close the small race between the version check and registering the waiter.
    if (state.version !== observedVersion) finish(true);
  });
};

export const resetPrintClaimCoordinatorForTests = () => {
  for (const state of stationStates.values()) {
    for (const resolve of state.waiters) resolve(false);
  }
  stationStates.clear();
};

