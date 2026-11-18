import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission, { requireAnyPermission } from '../middleware/permission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import {
  listPurchases,
  getPurchaseAging,
  getPurchaseAssetOptions,
  getPurchase,
  createPurchase,
  updateDraftPurchase,
  postPurchaseById,
  correctPurchase,
  recordPurchasePaymentController,
  deletePurchase,
} from '../controllers/purchase.controller.js';

const router = Router();
router.use(protect);

router.get('/aging', requirePermission('reports.aging'), getPurchaseAging);
router.get('/asset-options', requireAnyPermission('purchases.create', 'purchases.edit'), getPurchaseAssetOptions);
router.get('/', requirePermission('purchases.view'), listPurchases);
router.post('/', requirePermission('purchases.create'), auditLog('Purchase', 'CREATE'), createPurchase);
router.get('/:id', requirePermission('purchases.view'), getPurchase);
router.put('/:id', requirePermission('purchases.edit'), auditLog('Purchase', 'UPDATE_DRAFT'), updateDraftPurchase);
router.post('/:id/post', requirePermission('purchases.post'), auditLog('Purchase', 'POST'), postPurchaseById);
router.post('/:id/corrections', requirePermission('purchases.edit'), auditLog('Purchase', 'CORRECT'), correctPurchase);
router.post('/:id/payments', requirePermission('payments.record'), auditLog('PurchasePayment', 'CREATE'), recordPurchasePaymentController);
router.delete('/:id', requirePermission('purchases.delete'), auditLog('Purchase', 'DELETE'), deletePurchase);

export default router;
