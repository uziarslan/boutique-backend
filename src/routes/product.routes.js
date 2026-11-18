import { Router } from 'express';
import {
  getAllProducts,
  createProduct,
  getProductById,
  updateProduct,
  deleteProduct,
  getBelowPar,
} from '../controllers/product.controller.js';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import { validate, createProductSchema, updateProductSchema } from '../validators/product.validator.js';

const router = Router();

// All product routes require authentication
router.use(protect);

// ─── Static named routes MUST come before /:id ───────────────────────────────

// Reports: owner, financeManager, purchaseManager (receivingStaff excluded per plan)
router.get('/below-par', requirePermission('reports.belowPar'), getBelowPar);

// ─── Read (all authenticated roles) ──────────────────────────────────────────

router.get('/', getAllProducts);
router.get('/:id', getProductById);

// ─── Write (owner + purchaseManager) ─────────────────────────────────────────

router.post(
  '/',
  requirePermission('products.manage'),
  validate(createProductSchema),
  auditLog('Product', 'CREATE'),
  createProduct
);

router.put(
  '/:id',
  requirePermission('products.manage'),
  validate(updateProductSchema),
  auditLog('Product', 'UPDATE'),
  updateProduct
);

// ─── Delete (owner only) ──────────────────────────────────────────────────────

router.delete(
  '/:id',
  requirePermission('products.manage'),
  auditLog('Product', 'DELETE'),
  deleteProduct
);

export default router;
