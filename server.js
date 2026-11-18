// Must be first — loads and validates env vars before anything else
import 'dotenv/config';
import './src/config/env.js';

import express from 'express';
import 'express-async-errors';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import compression from 'compression';

import connectDB from './src/config/db.js';
import logger from './src/utils/logger.js';
import requestContext from './src/middleware/requestContext.middleware.js';
import notFound from './src/middleware/notFound.middleware.js';
import errorHandler from './src/middleware/error.middleware.js';
import auditLogger from './src/middleware/auditLogger.js';
import { env } from './src/config/env.js';
import {
  closeAllConnections,
  getConnectionHealth,
} from './src/db/connections.js';
import {
  buildReadiness,
  setDraining,
} from './src/utils/runtimeState.js';
import {
  closeRateLimitRedis,
  devicePairingLimiter,
  publicApiLimiter,
} from './src/middleware/rateLimit.middleware.js';
import { closePraQueue } from './src/queues/pra.queue.js';
import { closeRiderTrackingQueue } from './src/queues/riderTracking.queue.js';
import { closeQueueRedisConnections } from './src/queues/redisConnection.js';
import { shopifyWebhookRouter } from './src/routes/shopify.routes.js';

// ─── App ────────────────────────────────────────────────────────────────────

const app = express();

// Behind Heroku's router (a single proxy hop) — trust it so req.ip and
// req.secure resolve from the real client information in X-Forwarded-For.
app.set('trust proxy', 1);

// Disable ETag generation to avoid conditional 304 responses for APIs
app.set('etag', false);

// ─── Security & Parsing ─────────────────────────────────────────────────────

app.use(helmet());

// Build the allowed-origins set from CLIENT_URL (comma-separated) plus the
// admin client URL. Deduplicate so the same origin isn't checked twice.
const allowedOrigins = [
  ...env.CLIENT_URL.split(',').map((u) => u.trim()),
  env.ADMIN_CLIENT_URL,
].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

// Per-request CORS config:
//   /api/public/*  → open to any origin (customer self-order, scanned QRs
//                    can come from any device / network).
//   everything else → strict allowlist.
//
// Public endpoints are designed to be unauthenticated and called cross-origin
// — they're feature-flag gated and tenant-resolved from the URL slug. CORS
// isn't the right security boundary for them.
const corsOptionsDelegate = (req, callback) => {
  if (req.path.startsWith('/api/public/')) {
    return callback(null, { origin: true, credentials: false });
  }
  return callback(null, {
    origin: (origin, cb) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed.`));
    },
    credentials: true,
  });
};

app.use(cors(corsOptionsDelegate));

morgan.token('request-id', (req) => req.id);
app.use(requestContext);
app.use(
  morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" request_id=:request-id response_time_ms=:response-time', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  })
);

app.use(compression({ threshold: 1024 }));
// Shopify signs the exact request bytes. Keep this raw-body route ahead of the
// global JSON parser so HMAC verification is performed on the original body.
app.use('/api/shopify/webhooks', express.raw({ type: 'application/json', limit: '2mb' }), shopifyWebhookRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Disable caching for API responses to avoid stale 304 results in the browser
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  // Remove conditional request headers so proxies or browsers don't trigger 304
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  next();
});

// Audit trail — records every mutating API request once the response is sent.
app.use('/api', auditLogger);

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.NODE_ENV });
});

app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health/ready', (_req, res) => {
  const readiness = buildReadiness(getConnectionHealth());
  res.status(readiness.ready ? 200 : 503).json(readiness);
});

// ─── API Routes ───────────────────────────────────────────────────────────────

import authRoutes from './src/routes/auth.routes.js';
import onboardingRoutes from './src/routes/onboarding.routes.js';
import billingRoutes from './src/routes/billing.routes.js';
import adminRoutes from './src/platform/routes/admin.routes.js';
import attendanceDeviceRoutes from './src/routes/attendanceDevice.routes.js';
import restaurantDeviceRoutes from './src/routes/restaurantDevice.routes.js';
import tabletOrderRoutes from './src/routes/tabletOrder.routes.js';
import printAgentRoutes from './src/routes/printAgent.routes.js';
import hikvisionTerminalRoutes from './src/routes/hikvisionTerminal.routes.js';
import outletRoutes from './src/routes/outlet.routes.js';
import vendorRoutes from './src/routes/vendor.routes.js';
import productRoutes from './src/routes/product.routes.js';
import purchaseRoutes from './src/routes/purchase.routes.js';
import paymentRoutes from './src/routes/payment.routes.js';
import accountingRoutes from './src/routes/accounting.routes.js';
import inventoryRoutes from './src/routes/inventory.routes.js';
import stockIssueRoutes from './src/routes/stockIssue.routes.js';
import reportRoutes from './src/routes/report.routes.js';
import posRoutes from './src/routes/pos.routes.js';
import attendanceRoutes from './src/routes/attendance.routes.js';
import menuRoutes from './src/routes/menu.routes.js';
import usersRoutes from './src/routes/users.routes.js';
import allowanceRoutes from './src/routes/allowance.routes.js';
import salaryRoutes from './src/routes/salary.routes.js';
import employeeRoutes from './src/routes/employee.routes.js';
import customerRoutes from './src/routes/customer.routes.js';
import loyaltyRoutes from './src/routes/loyalty.routes.js';
import taxConfigRoutes from './src/routes/taxConfig.routes.js';
import praRoutes from './src/routes/pra.routes.js';
import auditRoutes from './src/routes/audit.routes.js';
import tableRoutes from './src/routes/table.routes.js';
import assetRoutes from './src/routes/asset.routes.js';
import kdsRoutes from './src/routes/kds.routes.js';
import riderRoutes from './src/routes/rider.routes.js';
import riderTrackingRoutes from './src/routes/riderTracking.routes.js';
import { publicRouter as qrPublicRoutes, cashierRouter as qrCashierRoutes } from './src/routes/qrOrder.routes.js';
import shopifyRoutes from './src/routes/shopify.routes.js';
import productionRoutes from './src/routes/production.routes.js';

import { requireFeature } from './src/middleware/feature.middleware.js';

// Platform admin (no tenant context)
app.use('/api/admin', adminRoutes);

// Auth endpoints handle both signup (no tenant yet) and tenant-bound operations.
app.use('/api/auth', authRoutes);

// Onboarding wizard — protected, but bypasses subscription gate so a brand-
// new tenant can finish setup before their first billing decision.
// (The subscription gate lives inside the protect middleware itself; routes
// listed in SUBSCRIPTION_BYPASS skip it.)
app.use('/api/onboarding', onboardingRoutes);
// Billing status/documents stay reachable after expiry so an owner can review
// what is due while the rest of the tenant API is subscription-gated.
app.use('/api/billing', billingRoutes);

// Attendance device pairing — owners mint/list/revoke tokens for the
// attendance terminal. /verify is public (the terminal calls it after
// pairing); the rest are owner-only.
app.use('/api/attendance-devices/verify', devicePairingLimiter);
app.use('/api/attendance-devices', attendanceDeviceRoutes);
app.use('/api/restaurant-devices/verify', devicePairingLimiter);
app.use('/api/restaurant-devices', restaurantDeviceRoutes);
app.use('/api/tablet-ordering', tabletOrderRoutes);
app.use('/api/print-agent', printAgentRoutes);

// Hikvision face terminals — owners mint/list/revoke terminal tokens; the
// device POSTs recognition events to the public /event/:token webhook. Gated
// per-tenant by the `attendanceExternalDevice` feature flag at the UI layer;
// the webhook itself validates the token so it's safe to leave mounted.
app.use('/api/hikvision-terminals', hikvisionTerminalRoutes);

app.use('/api/outlets', outletRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/production', productionRoutes);

// Feature-gated route groups
app.use('/api/vendors',         requireFeature('purchasing'), vendorRoutes);
app.use('/api/products',        requireFeature('purchasing'), productRoutes);
app.use('/api/purchases',       requireFeature('purchasing'), purchaseRoutes);
app.use('/api/payments',        requireFeature('purchasing'), paymentRoutes);
app.use('/api/accounting',      requireFeature('accounting'), accountingRoutes);
// In the boutique build, raw-material stock is the enabled `store` feature;
// restaurant kitchen inventory stays behind the disabled `inventory` flag.
// These three area-aware read endpoints serve both products, so select the
// entitlement from the requested holding area rather than gating the entire
// router as restaurant inventory.
app.use('/api/inventory', (req, res, next) => {
  const rawMaterialRead = req.method === 'GET'
    && req.query.area === 'store'
    && ['/', '/stock-movement-summary', '/stock-movements'].includes(req.path);
  return requireFeature(rawMaterialRead ? 'store' : 'inventory')(req, res, next);
}, inventoryRoutes);
app.use('/api/stock-issues',    requireFeature('store'),      stockIssueRoutes);
app.use('/api/reports',         requireFeature('reports'),    reportRoutes);
app.use('/api/pos/attendance',  attendanceRoutes);
app.use('/api/pos/qr-orders',   qrCashierRoutes); // qrOrdering is gated inside the router
app.use('/api/pos',             requireFeature('pos'),        posRoutes);
app.use('/api/menu',            requireFeature('menu'),       menuRoutes);
app.use('/api/allowances',      requireFeature('payroll'),    allowanceRoutes);
app.use('/api/salary/employees', employeeRoutes);
app.use('/api/salary',          requireFeature('payroll'),    salaryRoutes);
app.use('/api/assets',          requireFeature('assetAudit'), assetRoutes);
app.use('/api/users',           usersRoutes); // core — not feature-gated (needed for settings/team)
app.use('/api/customers',       customerRoutes);
app.use('/api/loyalty',         loyaltyRoutes); // membershipRewards gated inside the router
app.use('/api/tax',             taxConfigRoutes);
app.use('/api/pra',             praRoutes);
app.use('/api/audit-logs',      auditRoutes);
app.use('/api/kds',             requireFeature('kds'),        kdsRoutes);
app.use('/api/rider', riderRoutes);
app.use('/api/rider-tracking', riderTrackingRoutes);
app.use('/api/tables',          tableRoutes);   // qrOrdering gated inside the router

// Public (no JWT) — tenant resolved from URL slug, qrOrdering gated inside.
app.use('/api/public', publicApiLimiter, qrPublicRoutes);

// ─── 404 & Error Handlers ────────────────────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────────────────────────────

import seedPlatformAdmin from './src/platform/bootstrap.js';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import { setIo } from './src/utils/socket.js';
import {
  createSocketAuthMiddleware,
  registerSocketHandlers,
} from './src/socket/registerSocketHandlers.js';
import {
  closeSocketRedisAdapter,
  configureSocketRedisAdapter,
} from './src/socket/redisStreamsAdapter.js';
import {
  closeRiderTrackingEventBridge,
  startRiderTrackingEventBridge,
} from './src/socket/riderTrackingEventBridge.js';

const start = async () => {
  await connectDB();

  // Bootstrap the first platform super-admin from PLATFORM_ADMIN_* env vars.
  // Per-tenant chart of accounts is now seeded on signup, not at startup.
  await seedPlatformAdmin();

  const server = http.createServer(app);

  // Initialize Socket.IO. The public QR self-order app connects from any
  // origin (customer phones, captive portals, etc.) so we accept any origin
  // here — the channels are namespaced via rooms below, not via origin.
  const io = new IOServer(server, {
    cors: {
      origin: true,
      credentials: false,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
    maxHttpBufferSize: 1_000_000,
  });
  await configureSocketRedisAdapter(io);

  // Optional socket auth: authenticated staff pass their access token in the
  // handshake so we can trust their tenant SERVER-SIDE. Public QR customer
  // sockets connect withOUT a token and are still allowed (they never join
  // tenant-private rooms). An invalid/expired token is treated as anonymous.
  io.use(createSocketAuthMiddleware({ jwtSecret: env.JWT_SECRET }));
  registerSocketHandlers(io);

  // Make io instance available to controllers
  setIo(io);
  await startRiderTrackingEventBridge();

  server.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  let shutdownPromise = null;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      setDraining(true);
      logger.warn(`Received ${signal}; draining HTTP, Socket.IO, and database connections.`);

      const forceTimer = setTimeout(() => {
        logger.error('Graceful shutdown exceeded 25 seconds; forcing process termination.');
        process.exit(1);
      }, 25_000);
      forceTimer.unref();

      await new Promise((resolve) => io.close(resolve));
      setIo(null);
      await closeRiderTrackingEventBridge();
      await closeSocketRedisAdapter();
      await closeRateLimitRedis();
      await closePraQueue();
      await closeRiderTrackingQueue();
      await closeQueueRedisConnections();
      await closeAllConnections();

      clearTimeout(forceTimer);
      logger.info('Graceful shutdown complete.');
    })().catch((err) => {
      logger.error(`Graceful shutdown failed: ${err.stack || err.message}`);
      process.exitCode = 1;
    });

    return shutdownPromise;
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  // Scheduled jobs are NOT run from the API server. Run them separately:
  //   • Local dev: `npm run jobs:scheduler` (long-running worker)
  //   • Heroku:    add the Scheduler add-on → command `npm run jobs:overdue`
};

start().catch((err) => {
  logger.error(`Server failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
