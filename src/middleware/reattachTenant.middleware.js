import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant, getTenantStore } from '../db/tenantContext.js';

// Re-establishes the tenant AsyncLocalStorage context for the rest of the chain.
//
// `protect` wraps `next()` in runWithTenant(...), but that context does NOT
// survive multer's async multipart parsing — multer resolves from stream
// events created before the context existed, so a controller running after a
// multer middleware sees no tenant connection ("attachTenant middleware must
// run before model access").
//
// Place this AFTER any file-upload middleware and BEFORE the controller on
// routes that both parse uploads and touch tenant-scoped models.
const reattachTenant = async (req, res, next) => {
  // Already inside a valid context (no upload middleware ran) — nothing to do.
  if (getTenantStore()?.conn) return next();

  const slug = req.tenantSlug || req.tenant?.slug;
  if (!slug) return next();

  try {
    const conn = await getTenantConnectionFor(slug);
    runWithTenant({ conn, slug }, () => next());
  } catch (err) {
    next(err);
  }
};

export default reattachTenant;
