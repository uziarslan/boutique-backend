// Middleware to gate access by role and/or a specific permission key.
//
// When a `permissionKey` is provided, the user's effective permission map
// (which already merges role defaults with per-user overrides) is the source
// of truth. The role list is only used as an extra grant when no permission
// key is supplied, OR when the user document predates per-permission
// overrides (no `hasPermission` method on req.user).
//
// This means: a cashier with role=cashier but an explicit `pos.sale: false`
// override is correctly denied — the override wins over the role default.
// `permissionKey` may be a single key OR an array of keys — access is granted
// if the user holds ANY of them (e.g. a POS cashier via 'pos.sale' OR a manager
// via the dedicated 'loyalty.manage').
export default function allowRoleOrPermission(roles = [], permissionKey = null) {
    const keys = Array.isArray(permissionKey)
        ? permissionKey
        : (permissionKey ? [permissionKey] : []);
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

        if (keys.length && typeof req.user.hasPermission === 'function') {
            return keys.some((k) => req.user.hasPermission(k))
                ? next()
                : res.status(403).json({ success: false, message: 'Forbidden.' });
        }

        if (roles.includes(req.user.role)) return next();
        return res.status(403).json({ success: false, message: 'Forbidden.' });
    };
}
