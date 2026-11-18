// All known roles — update here when adding new roles.
export const ALL_ROLES = ['owner', 'financeManager', 'purchaseManager', 'receivingStaff', 'cashier', 'rider'];

/**
 * authorize(...roles)
 * Allow-list: only the listed roles may proceed.
 * Must be used after the protect middleware so req.user is populated.
 *
 * Usage:
 *   router.post('/approve', protect, authorize('owner', 'financeManager'), handler);
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Role '${req.user?.role}' is not permitted to perform this action.`,
      });
    }
    next();
  };
};

/**
 * denyRole(...roles)
 * Block-list: the listed roles are rejected; all other roles may proceed.
 * Must be used after the protect middleware so req.user is populated.
 *
 * Usage:
 *   // Block cashiers from all management-app routes
 *   router.use(protect, denyRole('cashier'));
 */
export const denyRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }
    if (roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Role '${req.user.role}' is not permitted to access this area.`,
      });
    }
    next();
  };
};

export default authorize;
