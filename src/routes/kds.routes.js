import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission, { requireAnyPermission } from '../middleware/permission.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import {
  acceptKdsOrder,
  acknowledgeKdsReady,
  cancelKdsOrder,
  cancelKdsOrderItem,
  getKdsItemCancellationPreview,
  dispatchKdsOrder,
  getKdsConfig,
  getKdsLifecycleReport,
  getKdsReadyCounts,
  getKdsWastePreview,
  getKitchenCounterReport,
  listKdsOrders,
  startKdsPrep,
} from '../controllers/kds.controller.js';

const router = Router();
router.use(protect);

router.get('/config', requireAnyPermission('kds.view', 'settings.kds'), getKdsConfig);
router.get('/orders', requirePermission('kds.view'), listKdsOrders);
router.patch('/orders/:id/accept', requirePermission('kds.operate'), acceptKdsOrder);
router.patch('/orders/:id/start-prep', requirePermission('kds.operate'), startKdsPrep);
router.patch('/orders/:id/dispatch', requirePermission('kds.operate'), dispatchKdsOrder);
router.get('/orders/:id/waste-preview', requirePermission('kds.cancel'), getKdsWastePreview);
router.get('/orders/:id/items/:itemIndex/cancellation-preview', requirePermission('kds.cancel'), getKdsItemCancellationPreview);
router.post('/orders/:id/items/:itemIndex/cancel', requirePermission('kds.cancel'), cancelKdsOrderItem);
router.post('/orders/:id/cancel', requirePermission('kds.cancel'), cancelKdsOrder);
router.patch('/orders/:id/acknowledge', requireAnyPermission('pos.sale', 'kds.operate'), acknowledgeKdsReady);
router.get('/ready-counts', requireAnyPermission('pos.sale', 'kds.view'), getKdsReadyCounts);
router.get('/reports/lifecycle', requireFeature('reports'), requirePermission('reports.orderLifecycle'), getKdsLifecycleReport);
router.get('/reports/kitchen-counter', requireFeature('reports'), requirePermission('reports.kitchenCounterSales'), getKitchenCounterReport);

export default router;
