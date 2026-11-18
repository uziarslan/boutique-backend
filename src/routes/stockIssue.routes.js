import { Router } from 'express';
import {
  createIssue,
  getAllIssues,
  getIssueById,
  getPendingCounts,
  acceptIssue,
  rejectIssue,
} from '../controllers/stockIssue.controller.js';
import protect from '../middleware/auth.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';

const router = Router();

router.use(protect);

// Transfers span both areas, so either side may VIEW them. Sending and
// accepting are direction-dependent — the coarse gate here requires a manager
// of EITHER area, and the controller enforces the exact side (sender vs
// receiver) for the transfer's direction.
const canView   = allowRoleOrPermission([], ['store.view', 'inventory.view']);
const canManage = allowRoleOrPermission([], ['store.manage', 'inventory.manage']);

router.get('/', canView, getAllIssues);
// Must precede '/:id' so 'pending-counts' isn't parsed as an id.
router.get('/pending-counts', canView, getPendingCounts);

router.post('/', canManage, auditLog('StockIssue', 'CREATE'), createIssue);

router.post('/:id/accept', canManage, auditLog('StockIssue', 'UPDATE'), acceptIssue);
router.post('/:id/reject', canManage, auditLog('StockIssue', 'UPDATE'), rejectIssue);

router.get('/:id', canView, getIssueById);

export default router;
