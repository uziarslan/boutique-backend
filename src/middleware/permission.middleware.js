// Middleware to require a specific permission key for the current user.
import logger from '../utils/logger.js';

export default function requirePermission(permissionKey) {
    return (req, res, next) => {
        if (!req.user || typeof req.user.hasPermission !== 'function') {
            logger.info(`[perm] missing req.user or hasPermission for key=${permissionKey}`);
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }
        try {
            // Check primary permission
            let allowed = req.user.hasPermission(permissionKey);

            // Some permissions imply others (e.g., if a user can create/approve/send PO
            // they should also be able to view POs). Define lightweight implication rules
            // here to avoid superficial 403s when owners grant related permissions.
            const IMPLIED = {
                'po.view': ['po.create', 'po.approve', 'po.send', 'po.pdf', 'po.edit'],
                'vendors.manage': ['vendors.manage'],
                'menu.manage': ['menu.manage'],
                'attendance.view': ['attendance.manage'],
                // RoleSettings groups "Ledger & Trial Balance" under a single
                // toggle that flips accounting.ledger. Trial balance is the
                // summary view of the same data, so granting ledger should
                // unlock it. Accept either key.
                'accounting.reports': ['accounting.ledger'],
                // Reverse direction: granting full reports access (P&L /
                // Balance Sheet) should imply ledger as well.
                'accounting.ledger': ['accounting.reports'],
            };

            if (!allowed && IMPLIED[permissionKey]) {
                allowed = IMPLIED[permissionKey].some((k) => req.user.hasPermission(k));
            }
            logger.info(`[perm] check user=${req.user.id} key=${permissionKey} allowed=${allowed} overrides=${JSON.stringify(req.user.permissions || {})}`);
            if (!allowed) return res.status(403).json({ success: false, message: 'Forbidden.' });
            return next();
        } catch (e) {
            logger.error('[perm] check failed', e);
            return res.status(500).json({ success: false, message: 'Permission check failed.' });
        }
    };
}

export const requireAnyPermission = (...permissionKeys) => (req, res, next) => {
    if (!req.user || typeof req.user.hasPermission !== 'function') {
        return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }
    try {
        const allowed = permissionKeys.some((key) => req.user.hasPermission(key));
        logger.info(`[perm] any check user=${req.user.id} keys=${permissionKeys.join(',')} allowed=${allowed}`);
        if (!allowed) return res.status(403).json({ success: false, message: 'Forbidden.' });
        return next();
    } catch (error) {
        logger.error('[perm] any check failed', error);
        return res.status(500).json({ success: false, message: 'Permission check failed.' });
    }
};
