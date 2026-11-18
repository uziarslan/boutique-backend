import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { tenantSchemas } from './defineModel.js';

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const connectionOptions = (maxPoolSize) => ({
  maxPoolSize,
  minPoolSize: 0,
  maxIdleTimeMS: positiveInt(process.env.MONGO_MAX_IDLE_TIME_MS, 60_000),
  waitQueueTimeoutMS: positiveInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS, 10_000),
});

// ─── URI utilities ───────────────────────────────────────────────────────────
//
// We treat the configured MONGO_URI as a *base*. The path component (the DB
// name in a typical URI like mongodb://host:27017/foo) is stripped and used
// only as a fallback. Each tenant gets a DB at `${base}/${slug}`. The
// platform/registry DB lives at `${base}/${PLATFORM_DB_NAME}`.

const stripDbName = (uri) => {
  // mongodb://[user:pass@]host[:port][/dbname][?opts]
  // Find the path segment that follows the authority — strip only that segment,
  // preserve the query string.
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) return uri;
  const [, authority, , query = ''] = match;
  return `${authority}${query}`;
};

export const buildUri = (slug) => {
  const base = stripDbName(process.env.MONGO_URI);
  const [pre, query = ''] = base.split('?');
  return `${pre}/${slug}${query ? `?${query}` : ''}`;
};

// ─── Slug sanitization ───────────────────────────────────────────────────────

export const sanitizeSlug = (raw) =>
  String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

// ─── Platform connection ─────────────────────────────────────────────────────

let platformConn = null;

export const connectPlatform = async () => {
  if (platformConn) return platformConn;
  const dbName = process.env.PLATFORM_DB_NAME || 'platform';
  const uri = buildUri(dbName);
  platformConn = await mongoose.createConnection(
    uri,
    connectionOptions(positiveInt(process.env.MONGO_PLATFORM_MAX_POOL_SIZE, 10)),
  ).asPromise();
  platformConn.on('error', (err) =>
    logger.error(`Platform DB error: ${err.message}`)
  );
  logger.info(`Platform DB connected: ${dbName}`);
  return platformConn;
};

export const getPlatformConnection = () => {
  if (!platformConn) throw new Error('Platform DB not connected yet.');
  return platformConn;
};

// ─── Tenant connection registry ──────────────────────────────────────────────

const tenantConnections = new Map();
const pending = new Map();

const registerSchemas = (conn) => {
  for (const [name, schema] of tenantSchemas.entries()) {
    if (!conn.models[name]) conn.model(name, schema);
  }
};

// Best-effort: drop the legacy { product, outlet } unique index on stockitems.
// The Store/Kitchen model needs a { product, outlet, area } unique index so a
// store row and a kitchen row for the same product can coexist. A tenant DB
// seeded/restored from data that predates that migration carries the old
// `product_1_outlet_1` unique index, which makes every store→kitchen issue fail
// with E11000. Mongoose autoIndex only ADDS the new index, never drops the old
// one — so we drop it here, once, when the connection is first opened. Runs once
// per tenant per process (connections are cached) and never blocks connection.
const dropLegacyStockIndexes = async (conn, slug) => {
  try {
    const col = conn.collection('stockitems');
    const names = (await col.indexes()).map((i) => i.name);
    if (names.includes('product_1_outlet_1')) {
      await col.dropIndex('product_1_outlet_1');
      logger.info(`[${slug}] dropped legacy stockitems index product_1_outlet_1`);
    }
  } catch (err) {
    // Collection may not exist yet on a brand-new tenant — that's fine.
    logger.warn(`[${slug}] legacy stock index cleanup skipped: ${err.message}`);
  }
};

// Multiple delivery orders may travel in one rider run. Older tenant databases
// have a partial unique { rider, active } index that rejects the second active
// order even though { saleTransaction, active } must remain unique.
const dropLegacySingleAssignmentIndex = async (conn, slug) => {
  try {
    const col = conn.collection('deliveryassignments');
    const indexes = await col.indexes();
    const legacy = indexes.find((index) => index.unique === true
      && index.key?.rider === 1
      && index.key?.active === 1
      && Object.keys(index.key).length === 2);
    if (legacy) {
      await col.dropIndex(legacy.name);
      logger.info(`[${slug}] dropped legacy single-rider assignment index ${legacy.name}`);
    }
  } catch (err) {
    // A brand-new tenant may not have this collection yet.
    logger.warn(`[${slug}] legacy rider assignment index cleanup skipped: ${err.message}`);
  }
};

// Manual boutique products have no Shopify IDs, so those fields must allow
// multiple missing values while still enforcing uniqueness for imported IDs.
// Older tenant databases may have the original non-sparse unique indexes.
const migrateRetailCatalogIdIndexes = async (conn, slug) => {
  for (const [collectionName, field] of [
    ['retailproducts', 'shopifyProductId'],
    ['retailvariants', 'shopifyVariantId'],
  ]) {
    try {
      const collection = conn.collection(collectionName);
      const indexes = await collection.indexes().catch(() => []);
      const oldIndex = indexes.find((index) => index.unique === true
        && index.key?.[field] === 1
        && Object.keys(index.key).length === 1
        && !index.sparse
        && !index.partialFilterExpression);
      if (oldIndex) await collection.dropIndex(oldIndex.name);
      await collection.createIndex({ [field]: 1 }, { unique: true, sparse: true });
    } catch (err) {
      logger.warn(`[${slug}] retail catalog index migration skipped for ${field}: ${err.message}`);
    }
  }
};

export const getTenantConnectionFor = async (slug) => {
  if (!slug) throw new Error('Tenant slug required.');
  if (tenantConnections.has(slug)) return tenantConnections.get(slug);
  if (pending.has(slug)) return pending.get(slug);

  const promise = (async () => {
    try {
      const uri = buildUri(slug);
      const conn = await mongoose.createConnection(
        uri,
        connectionOptions(positiveInt(process.env.MONGO_TENANT_MAX_POOL_SIZE, 5)),
      ).asPromise();
      conn.on('error', (err) =>
        logger.error(`Tenant DB [${slug}] error: ${err.message}`)
      );
      await Promise.all([
        dropLegacyStockIndexes(conn, slug),
        dropLegacySingleAssignmentIndex(conn, slug),
        migrateRetailCatalogIdIndexes(conn, slug),
      ]);
      registerSchemas(conn);
      tenantConnections.set(slug, conn);
      logger.info(`Tenant DB connected: ${slug}`);
      return conn;
    } finally {
      // A failed connection must be retryable. Previously the rejected promise
      // remained cached forever and permanently poisoned that tenant process.
      pending.delete(slug);
    }
  })();
  pending.set(slug, promise);
  return promise;
};

export const dropTenantDatabase = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  await conn.dropDatabase();
  await conn.close();
  tenantConnections.delete(slug);
};

export const listOpenTenantSlugs = () => Array.from(tenantConnections.keys());

const stateName = (readyState) => (
  ['disconnected', 'connected', 'connecting', 'disconnecting'][readyState]
  || 'unknown'
);

export const getConnectionHealth = () => ({
  platform: {
    readyState: platformConn?.readyState ?? 0,
    state: stateName(platformConn?.readyState ?? 0),
  },
  tenants: {
    open: tenantConnections.size,
    connecting: pending.size,
  },
});

export const closeAllConnections = async () => {
  // Let in-flight connection attempts settle so they cannot add a new cached
  // connection after the registry has already been drained.
  await Promise.allSettled(Array.from(pending.values()));

  const tenantConns = Array.from(tenantConnections.values());
  tenantConnections.clear();
  pending.clear();

  await Promise.allSettled(tenantConns.map((conn) => conn.close()));

  const conn = platformConn;
  platformConn = null;
  if (conn) await conn.close();
};
