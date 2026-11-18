// Tiny in-memory TTL cache for hot, per-request lookups (tenant + user) that the
// auth middleware otherwise re-fetches from the (cloud) database on EVERY request.
// Cutting these removes 1–2 network round-trips per API call, which is the single
// biggest latency win when the DB is remote.
//
// Entries are invalidated explicitly on the relevant mutations (user edits,
// tenant feature/subscription changes) and also expire after their TTL as a
// backstop, so a stale entry can never persist longer than the TTL.

const store = new Map(); // key -> { value, expires }
const MAX_ENTRIES = 10_000;

const prune = () => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expires <= now) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
};

export const cacheGet = (key) => {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
};

export const cacheSet = (key, value, ttlMs) => {
  if (store.size >= MAX_ENTRIES) prune();
  // Refresh insertion order so the size bound behaves as a small LRU.
  store.delete(key);
  store.set(key, { value, expires: Date.now() + ttlMs });
};

export const cacheDel = (key) => { store.delete(key); };

// Convenience key builders + TTLs.
export const TENANT_TTL_MS = 60 * 1000;
export const USER_TTL_MS = 30 * 1000;
export const tenantKey = (slug) => `tenant:${slug}`;
export const userKey = (id, tenantSlug = '') => `user:${tenantSlug}:${id}`;
