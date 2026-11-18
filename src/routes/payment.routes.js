import { Router } from 'express';
import {
  recordPayment,
  getAllPayments,
  getPaymentById,
  getPaymentsByVendor,
  updatePaymentDate,
  deletePayment,
} from '../controllers/payment.controller.js';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';

const router = Router();

// All payment routes require authentication
router.use(protect);

// ─── Static named routes MUST come before /:id ───────────────────────────────

router.get('/vendor/:vendorId', requirePermission('payments.view'), getPaymentsByVendor);

// ─── Collection ───────────────────────────────────────────────────────────────

router.get('/', requirePermission('payments.view'), getAllPayments);

router.post(
  '/',
  requirePermission('payments.record'),
  auditLog('Payment', 'CREATE'),
  recordPayment
);

// ─── Single resource ──────────────────────────────────────────────────────────

router.get('/:id', requirePermission('payments.view'), getPaymentById);

router.patch(
  '/:id/date',
  requirePermission('payments.edit'),
  auditLog('Payment', 'UPDATE_DETAILS'),
  updatePaymentDate,
);

router.delete(
  '/:id',
  requirePermission('payments.delete'),
  auditLog('Payment', 'REVERSE'),
  deletePayment
);

export default router;
