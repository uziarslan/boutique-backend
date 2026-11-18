import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';

/**
 * Factory middleware that logs an audit entry after the response is sent.
 *
 * Usage:
 *   router.put('/:id', protect, auditLog('Vendor', 'UPDATE'), updateVendor);
 *
 * The controller is responsible for attaching `req.auditBefore` and
 * `req.auditAfter` (and optionally `req.auditRecordId`) if detailed
 * before/after snapshots are needed. The middleware will pick them up.
 */
const auditLog = (module, action) => {
  return (req, res, next) => {
    // Run audit after the response finishes
    res.on('finish', async () => {
      try {
        // Only audit successful mutating responses (2xx)
        if (res.statusCode < 200 || res.statusCode >= 300) return;

        await AuditLog.create({
          user: req.user?.id ?? null,
          action,
          module,
          recordId: req.auditRecordId ?? req.params?.id ?? null,
          before: req.auditBefore ?? null,
          after: req.auditAfter ?? null,
          ip: req.ip,
          timestamp: new Date(),
        });
      } catch (err) {
        // Audit failures must never crash the app
        logger.error(`Audit log write failed [${module}/${action}]: ${err.message}`);
      }
    });

    next();
  };
};

export default auditLog;
