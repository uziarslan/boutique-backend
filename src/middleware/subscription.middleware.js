// Allow these tenant-scoped paths through even when the subscription is
// inactive — users still need to log out, refresh tokens, and read their own
// account. Everything else returns 402 with a structured payload the
// frontend renders as a billing-blocked screen.
const ALLOW_PREFIXES = [
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/me',
];

const isActive = (tenant) => {
  if (!tenant) return false;
  if (tenant.status === 'suspended') return false;
  if (!tenant.accessUntil) return false;
  return new Date(tenant.accessUntil).getTime() > Date.now();
};

const requireActiveSubscription = (req, res, next) => {
  if (ALLOW_PREFIXES.some((p) => req.originalUrl.startsWith(p))) return next();
  if (!req.tenant) return next();
  if (isActive(req.tenant)) return next();

  return res.status(402).json({
    success: false,
    code: 'SUBSCRIPTION_INACTIVE',
    message:
      req.tenant.status === 'suspended'
        ? 'This account is suspended. Contact support to reactivate.'
        : 'Subscription has expired. Contact support to renew access.',
    tenantStatus: req.tenant.status,
    accessUntil: req.tenant.accessUntil,
  });
};

export default requireActiveSubscription;
