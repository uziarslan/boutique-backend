import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import requirePermission, { requireAnyPermission } from '../middleware/permission.middleware.js';
import {
  getLiveRiderDispatch,
  getRiderOrderRoute,
  getRiderPerformance,
  getRiderShiftRoute,
  getRiderTrackingHistory,
  notifyAssignedRider,
  overrideRiderReturn,
  upsertRiderDeliveryReview,
  updateRiderTrackingConfig,
} from '../controllers/riderTracking.controller.js';

const router = Router();
router.use(protect);
router.use(requireFeature('riderTracking'));

router.get('/live', requireAnyPermission('riderTracking.live', 'riderTracking.assign'), getLiveRiderDispatch);
router.get('/history', requirePermission('riderTracking.history'), getRiderTrackingHistory);
router.get('/performance', requireAnyPermission('riderTracking.live', 'riderTracking.assign', 'riderTracking.history'), getRiderPerformance);
router.get('/orders/:orderId/route', requirePermission('riderTracking.history'), getRiderOrderRoute);
router.put('/orders/:orderId/review', requireAnyPermission('riderTracking.assign', 'riderTracking.history'), upsertRiderDeliveryReview);
router.patch('/assignments/:id/return', requireAnyPermission('riderTracking.assign', 'riderTracking.history'), overrideRiderReturn);
router.get('/shifts/:shiftId/route', requirePermission('riderTracking.history'), getRiderShiftRoute);
router.patch('/outlets/:outletId/config', requirePermission('riderTracking.manage'), updateRiderTrackingConfig);
router.post('/assignments/:id/notify', requirePermission('riderTracking.assign'), notifyAssignedRider);

export default router;
