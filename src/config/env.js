import { ACCESS_TOKEN_EXPIRES_IN } from './authTokens.js';

const REQUIRED_VARS = [
  'MONGO_URI',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_REFRESH_EXPIRES_IN',
  'PORT',
  'CLIENT_URL',
  'NODE_ENV',
];

const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}\n` +
    'Check your .env file against .env.example.'
  );
}

const bool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const praQueueEnabled = bool(process.env.PRA_QUEUE_ENABLED ?? process.env.FBR_QUEUE_ENABLED, false);
const praWorkerConcurrencyRaw = process.env.PRA_WORKER_CONCURRENCY || process.env.FBR_WORKER_CONCURRENCY;
const praWorkerConcurrency = praWorkerConcurrencyRaw
  ? Math.max(1, Math.min(20, parseInt(praWorkerConcurrencyRaw, 10) || 1))
  : 5;
const riderTrackingQueueEnabled = bool(process.env.RIDER_TRACKING_QUEUE_ENABLED, false);
const queueRedisUrl = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL || '';
if ((praQueueEnabled || riderTrackingQueueEnabled) && !queueRedisUrl) {
  throw new Error('Queue processing requires QUEUE_REDIS_URL or REDIS_URL.');
}
const socketRedisEnabled = bool(process.env.SOCKET_REDIS_ENABLED, false);
const socketRedisUrl = process.env.SOCKET_REDIS_URL || process.env.CACHE_REDIS_URL || process.env.REDIS_URL || '';
if (socketRedisEnabled && !socketRedisUrl) {
  throw new Error('SOCKET_REDIS_ENABLED=true requires SOCKET_REDIS_URL, CACHE_REDIS_URL, or REDIS_URL.');
}
const distributedRateLimitEnabled = bool(process.env.DISTRIBUTED_RATE_LIMIT_ENABLED, false);
const rateLimitRedisUrl = process.env.RATE_LIMIT_REDIS_URL || process.env.CACHE_REDIS_URL || process.env.REDIS_URL || '';
if (distributedRateLimitEnabled && !rateLimitRedisUrl) {
  throw new Error('DISTRIBUTED_RATE_LIMIT_ENABLED=true requires RATE_LIMIT_REDIS_URL, CACHE_REDIS_URL, or REDIS_URL.');
}

export const env = {
  MONGO_URI: process.env.MONGO_URI,
  PLATFORM_DB_NAME: process.env.PLATFORM_DB_NAME || 'platform',
  TRIAL_DAYS: parseInt(process.env.TRIAL_DAYS || '14', 10),
  ADMIN_CLIENT_URL: process.env.ADMIN_CLIENT_URL || 'http://localhost:3002',
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_EXPIRES_IN: ACCESS_TOKEN_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN,
  PORT: parseInt(process.env.PORT, 10) || 5000,
  CLIENT_URL: process.env.CLIENT_URL,
  NODE_ENV: process.env.NODE_ENV,
  // Rate limiter max requests in window (optional)
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ? parseInt(process.env.RATE_LIMIT_MAX, 10) : (process.env.NODE_ENV === 'production' ? 200 : 5000),

  // Scheduled jobs (read by the standalone scheduler worker — see
  // src/jobs/scheduler.run.js). Not used by the API server.
  // Cron expression for the overdue-invoice check. Required when running
  // `npm run jobs:scheduler`. Example: "*/5 * * * *" (every 5 min).
  OVERDUE_CRON: process.env.OVERDUE_CRON || '',
  // Cron expression for the loyalty-points expiry sweep. Optional —
  // defaults to "15 3 * * *" (daily at 03:15) when scheduler is running.
  LOYALTY_EXPIRY_CRON: process.env.LOYALTY_EXPIRY_CRON || '',
  // Cron expression for the PRA retry sweep (re-submits pending invoices).
  // Optional — defaults to every 10 min ("*/10 * * * *") when scheduler runs.
  PRA_RETRY_CRON: process.env.PRA_RETRY_CRON || process.env.FBR_RETRY_CRON || '',
  // Hourly scanner; invoice.nextReminderAt enforces the 24-hour cadence.
  BILLING_REMINDER_CRON: process.env.BILLING_REMINDER_CRON || '',
  // Dedicated key for encrypting PRA tokens at rest. FBR_ENC_KEY is accepted as
  // a rollout fallback so existing deployments do not lose decryption access.
  // in production; falls back to JWT_SECRET when unset (see utils/secretBox.js).
  PRA_ENC_KEY: process.env.PRA_ENC_KEY || process.env.FBR_ENC_KEY || '',
  // Critical queue rollout is off by default. The direct PRA path
  // remains active until this is explicitly enabled after Redis verification.
  PRA_QUEUE_ENABLED: praQueueEnabled,
  QUEUE_REDIS_URL: queueRedisUrl,
  PRA_WORKER_CONCURRENCY: praWorkerConcurrency,
  RIDER_TRACKING_QUEUE_ENABLED: riderTrackingQueueEnabled,
  RIDER_TRACKING_WORKER_CONCURRENCY: process.env.RIDER_TRACKING_WORKER_CONCURRENCY
    ? Math.max(1, Math.min(50, parseInt(process.env.RIDER_TRACKING_WORKER_CONCURRENCY, 10) || 1))
    : 1,
  SOCKET_REDIS_ENABLED: socketRedisEnabled,
  SOCKET_REDIS_URL: socketRedisUrl,
  DISTRIBUTED_RATE_LIMIT_ENABLED: distributedRateLimitEnabled,
  RATE_LIMIT_REDIS_URL: rateLimitRedisUrl,
  SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || '2026-10',
  SHOPIFY_EVENT_POLL_MS: Math.max(250, parseInt(process.env.SHOPIFY_EVENT_POLL_MS || '1000', 10) || 1000),
  SHOPIFY_RECONCILE_CRON: process.env.SHOPIFY_RECONCILE_CRON || '17 * * * *',
  SHOPIFY_WEBHOOK_BASE_URL: process.env.SHOPIFY_WEBHOOK_BASE_URL || '',
  PUBLIC_RATE_LIMIT_MAX: process.env.PUBLIC_RATE_LIMIT_MAX
    ? Math.max(30, parseInt(process.env.PUBLIC_RATE_LIMIT_MAX, 10) || 120)
    : 120,
};
