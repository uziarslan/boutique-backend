import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import {
  getAllOutlets,
  createOutlet,
  getOutletById,
  updateOutlet,
} from '../controllers/outlet.controller.js';

const router = Router();

// Read-only outlet lookup — any authenticated user (needed for PO form outlet dropdown).
router.get('/', protect, getAllOutlets);
router.get('/:id', protect, getOutletById);

// Outlet management — restricted to users with settings.outlets permission (owner only by default).
router.post('/', protect, requirePermission('settings.outlets'), createOutlet);
router.patch('/:id', protect, requirePermission('settings.outlets'), updateOutlet);

export default router;
