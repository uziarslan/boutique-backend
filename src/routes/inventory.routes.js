import { Router } from 'express';
import {
    getAllStock,
    updateStockItem,
    submitStockCount,
    createNewStock,
    logWaste,
    getWasteLogs,
    getVarianceReport,
    getStockDetail,
    getSaleTransactionsForWaste,
    logWasteFromSale,
    getSaleWasteCostPreview,
} from '../controllers/inventory.controller.js';
import {
    getInventoryInsightsDashboard,
    getDetailedIngredients,
    getUsageHistory,
} from '../controllers/recipe.controller.js';
import {
    getStockMovementSummary,
    getStockMovements,
} from '../controllers/stockReport.controller.js';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import { cancelPunchedOrder } from '../controllers/inventoryOrderCancellation.controller.js';
import { validate, voidSchema } from '../validators/sale.validator.js';

const router = Router();

router.use(protect);

// Roles:
//   Read stock levels: all authenticated roles (receiving staff need visibility)
//   Write / count / waste: owner, purchaseManager, receivingStaff
//   Reports (variance): owner, financeManager, purchaseManager

// ─── Static named routes MUST come before /:productId ────────────────────────

router.post(
    '/stock-count',
    // require explicit manage permission for mutating inventory
    requirePermission('inventory.manage'),
    auditLog('Inventory', 'STOCK_COUNT'),
    submitStockCount
);

router.get(
    '/waste-log',
    requirePermission('inventory.view'),
    getWasteLogs
);

router.post(
    '/waste-log',
    requirePermission('inventory.manage'),
    auditLog('Inventory', 'WASTE_LOG'),
    logWaste
);

router.get(
    '/waste-log/sale-transactions',
    requirePermission('inventory.manage'),
    getSaleTransactionsForWaste
);

router.get(
    '/waste-log/sale-transactions/:id/cost-preview',
    requirePermission('inventory.manage'),
    getSaleWasteCostPreview
);

router.post(
    '/waste-log/sale-transactions/:id/cancel',
    requirePermission('inventory.manage'),
    requirePermission('pos.cancelOrder'),
    validate(voidSchema),
    cancelPunchedOrder
);

router.post(
    '/waste-log/from-sale',
    requirePermission('inventory.manage'),
    auditLog('Inventory', 'WASTE_FROM_SALE'),
    logWasteFromSale
);

router.get(
    '/variance-report',
    // variance is an inventory/report view — use inventory.view permission
    requirePermission('inventory.view'),
    getVarianceReport
);

// ─── Store / Kitchen movement reports (over the StockMovement ledger) ─────────

router.get(
    '/stock-movement-summary',
    requirePermission('inventory.view'),
    getStockMovementSummary
);

router.get(
    '/stock-movements',
    requirePermission('inventory.view'),
    getStockMovements
);

// ─── Insights & Adaptive Variance ────────────────────────────────────────────

router.get(
    '/insights',
    requirePermission('inventory.view'),
    getInventoryInsightsDashboard
);

router.get(
    '/insights/detailed',
    requirePermission('inventory.view'),
    getDetailedIngredients
);

router.get(
    '/usage-history/:productId',
    requirePermission('inventory.view'),
    getUsageHistory
);

// ─── Collection & single-resource ────────────────────────────────────────────

router.get('/', getAllStock);   // all authenticated roles

router.post(
    '/create-new-stock',
    requirePermission('inventory.manage'),
    auditLog('Inventory', 'CREATE_NEW_STOCK'),
    createNewStock
);

router.get(
    '/:productId/detail',
    requirePermission('inventory.view'),
    getStockDetail
);

router.put(
    '/:productId',
    requirePermission('inventory.manage'),
    auditLog('Inventory', 'MANUAL_ADJUSTMENT'),
    updateStockItem
);

export default router;
