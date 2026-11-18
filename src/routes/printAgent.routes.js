import { Router } from 'express';
import { attachRestaurantDevice } from '../middleware/restaurantDevice.middleware.js';
import {
  getPrintStationStatus,
  claimPrintJob,
  completePrintJob,
  failPrintJob,
} from '../controllers/printAgent.controller.js';

const router = Router();
router.use(attachRestaurantDevice('printStation'));
router.get('/status', getPrintStationStatus);
router.post('/jobs/claim', claimPrintJob);
router.post('/jobs/:id/complete', completePrintJob);
router.post('/jobs/:id/fail', failPrintJob);
export default router;

