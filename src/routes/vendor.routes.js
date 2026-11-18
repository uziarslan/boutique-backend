import { Router } from 'express';
import {
  getAllVendors,
  createVendor,
  getVendorById,
  updateVendor,
  deleteVendor,
  getPriceHistory,
} from '../controllers/vendor.controller.js';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import { validate, createVendorSchema, updateVendorSchema } from '../validators/vendor.validator.js';
import requirePermission from '../middleware/permission.middleware.js';

const router = Router();

// All routes require authentication
router.use(protect);

// ─── Read (all authenticated roles) ──────────────────────────────────────────

router.get('/', requirePermission('vendors.manage'), getAllVendors);
router.get('/:id', requirePermission('vendors.manage'), getVendorById);
router.get('/:id/price-history', getPriceHistory);

// ─── Write (owner + purchaseManager) ─────────────────────────────────────────

router.post(
  '/',
  // allow role OR explicit vendors.manage permission
  allowRoleOrPermission(['owner', 'purchaseManager'], 'vendors.manage'),
  validate(createVendorSchema),
  auditLog('Vendor', 'CREATE'),
  createVendor
);

router.put(
  '/:id',
  allowRoleOrPermission(['owner', 'purchaseManager'], 'vendors.manage'),
  validate(updateVendorSchema),
  auditLog('Vendor', 'UPDATE'),
  updateVendor
);

// ─── Delete (owner only) ──────────────────────────────────────────────────────

router.delete(
  '/:id',
  authorize('owner'),
  auditLog('Vendor', 'DELETE'),
  deleteVendor
);

export default router;
