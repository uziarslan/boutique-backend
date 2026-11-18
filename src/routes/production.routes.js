import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import {
  getProductionSetup,
  listBillsOfMaterials,
  createBillOfMaterials,
  updateBillOfMaterials,
  listProductionOrders,
  releaseProductionOrder,
  completeProductionOrder,
} from '../controllers/production.controller.js';

const router = Router();
router.use(protect, requireFeature('store'));
router.get('/setup', requirePermission('inventory.view'), getProductionSetup);
router.get('/boms', requirePermission('inventory.view'), listBillsOfMaterials);
router.post('/boms', requirePermission('inventory.manage'), createBillOfMaterials);
router.put('/boms/:bomId', requirePermission('inventory.manage'), updateBillOfMaterials);
router.get('/orders', requirePermission('inventory.view'), listProductionOrders);
router.post('/orders', requirePermission('inventory.manage'), releaseProductionOrder);
router.patch('/orders/:orderId/complete', requirePermission('inventory.manage'), completeProductionOrder);

export default router;
