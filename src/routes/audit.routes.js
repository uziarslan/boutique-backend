import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import { listAuditLogs } from '../controllers/audit.controller.js';

const router = Router();

// Owner-only — the audit trail is sensitive and shows everyone's activity.
router.get('/', protect, authorize('owner'), listAuditLogs);

export default router;
