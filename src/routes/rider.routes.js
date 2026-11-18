import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import {
  endRiderShift,
  getRiderOrder,
  ingestRiderLocations,
  listRiderOrders,
  registerRiderDevice,
  riderBootstrap,
  riderHeartbeat,
  startRiderShift,
  updateRiderOrder,
} from '../controllers/riderTracking.controller.js';

const router = Router();
router.use(protect);
router.use(requireFeature('riderTracking'));

router.get('/bootstrap', riderBootstrap);
router.post('/devices/register', registerRiderDevice);
router.post('/heartbeat', riderHeartbeat);
router.post('/shifts/start', startRiderShift);
router.post('/shifts/end', endRiderShift);
router.get('/orders', listRiderOrders);
router.get('/orders/:id', getRiderOrder);
router.patch('/orders/:id/action', updateRiderOrder);
router.post('/locations/batch', ingestRiderLocations);

export default router;
