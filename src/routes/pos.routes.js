/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POS ROUTES — Cashier Terminal API
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All routes here belong to the built-in cashier POS terminal mounted at
 * /terminal in the main frontend. Cashiers authenticate with a short-lived
 * JWT Bearer token via /api/auth/pos-login.
 *
 * Third-party / external POS integration has been removed. The system no
 * longer accepts X-POS-API-KEY webhook traffic.
 *
 * PAYLOAD SCHEMAS
 * ───────────────
 * POST /api/pos/sale
 *   Header:  Authorization: Bearer <cashier JWT>
 *   Body:    {
 *              items:               [{ menuItemId, qty, discountAmount? }],
 *              paymentMethod:       'cash' | 'card' | 'split',
 *              cashTendered:        number (required if cash or split),
 *              cardAmount:          number (required if split),
 *              discountAmount:      number (order-level, optional),
 *              clientTransactionId: string (UUID, optional — for offline dedup)
 *            }
 *
 * POST /api/pos/sessions/open
 *   Header:  Authorization: Bearer <cashier JWT>
 *   Body:    { openingFloat?: number }
 *
 * POST /api/pos/sessions/close
 *   Header:  Authorization: Bearer <cashier JWT>
 *   Body:    { closingFloat: number, notes?: string }
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import requirePermission, { requireAnyPermission } from '../middleware/permission.middleware.js';
import { getPOSMenu, getPOSCategories, getPOSMenuAvailability } from '../controllers/posMenu.controller.js';
import {
  openSession,
  closeSession,
  getCurrentSession,
  getCurrentSessionSummary,
  recordDrawerMovement,
  issueEmployeeAdvanceFromDrawer,
  updateDrawerMovement,
  deleteDrawerMovement,
  getSessionById,
  getAllSessions,
} from '../controllers/session.controller.js';
import {
  processSale,
  getDeliveryRiders,
  getChargeToSalaryEmployees,
  getChargeToSalaryEmployeeCreditSummary,
  assignDeliveryRider,
  holdOrder,
  updateHeldOrder,
  resumeHeldOrder,
  cancelHeldOrder,
  markHeldOrderPrinted,
  voidTransaction,
  refundTransaction,
  syncOffline,
  getOfflineSyncStatus,
  getHeldOrders,
  moveHeldOrderItem,
  getMyTransactions,
  getPosWastePreview,
  logMyTransactionAsWaste,
  getTransactionsBySession,
} from '../controllers/sale.controller.js';
import { processRetailSale, syncRetailOfflineSales } from '../controllers/retailPos.controller.js';
import { getRetailSaleReturnable, processRetailReturn, getStoreCredit } from '../controllers/retailReturns.controller.js';
import {
  validate,
  saleSchema,
  holdSchema,
  voidSchema,
  cancelHeldOrderSchema,
  wasteOrderSchema,
  refundSchema,
  syncOfflineSchema,
  offlineSyncStatusSchema,
  moveHeldItemSchema,
} from '../validators/sale.validator.js';

const router = Router();

// ─── Cashier menu routes (cashier JWT auth) ───────────────────────────────────
// The categories route is intentionally placed before /menu/:outletId so Express
// does not treat the literal string "categories" as an outletId.
router.get('/menu/categories/:outletId',  protect, getPOSCategories);
router.get('/menu/:outletId/availability', protect, getPOSMenuAvailability);
router.get('/menu/:outletId',              protect, getPOSMenu);

// Boutique variant checkout uses the same cashier/session identity while
// keeping finished-goods stock separate from restaurant recipes and Kitchen.
router.post('/retail-sale', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), processRetailSale);
router.post('/retail-sync-offline', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), syncRetailOfflineSales);
router.get('/retail-returnable', protect, allowRoleOrPermission(['cashier', 'owner', 'financeManager'], 'pos.sale'), getRetailSaleReturnable);
router.post('/retail-returns', protect, allowRoleOrPermission(['cashier', 'owner', 'financeManager'], 'pos.sale'), processRetailReturn);
router.get('/store-credit/:code', protect, allowRoleOrPermission(['cashier', 'owner', 'financeManager'], 'pos.sale'), getStoreCredit);

// ─── Session (shift) routes ───────────────────────────────────────────────────
//
// current must be registered before /:id or Express treats "current" as an id.
router.post('/sessions/open',           protect, allowRoleOrPermission(['cashier'], 'pos.sale'), openSession);
router.post('/sessions/close',          protect, allowRoleOrPermission(['cashier'], 'pos.sale'), closeSession);
router.get('/sessions/current',         protect, allowRoleOrPermission(['cashier'], 'pos.sale'), getCurrentSession);
router.get('/sessions/current/summary', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), getCurrentSessionSummary);
router.post('/sessions/drawer-movement', protect, requirePermission('pos.drawerAdd'), recordDrawerMovement);
router.post('/sessions/employee-advance', protect, requirePermission('pos.drawerAdd'), issueEmployeeAdvanceFromDrawer);
router.patch('/sessions/drawer-movement/:movementId', protect, requirePermission('pos.drawerEdit'), updateDrawerMovement);
router.delete('/sessions/drawer-movement/:movementId', protect, requirePermission('pos.drawerDelete'), deleteDrawerMovement);

// Management routes — owner and financeManager only.
router.get('/sessions',     protect, allowRoleOrPermission(['owner', 'financeManager'], 'pos.manage'), getAllSessions);
router.get('/sessions/:id', protect, allowRoleOrPermission(['owner', 'financeManager'], 'pos.manage'), getSessionById);

// ─── Sale processing routes ───────────────────────────────────────────────────
//
// Static sub-paths (hold, void, refund, sync-offline, held-orders, transactions)
// are registered BEFORE the /:id param routes to avoid Express treating string
// literals as ObjectIds.

// Cashier: process a completed sale
router.post(
  '/sale',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  validate(saleSchema),
  processSale
);

// Cashier: hold an order (items from body; :id param unused in v1)
router.post(
  '/sale/:id/hold',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  validate(holdSchema),
  holdOrder
);

// Cancel (void) a completed transaction. The dedicated permission is the
// authority for this action because cancellation is also available outside the
// terminal (for example, from Kitchen > Waste Log). Refund stays management-only.
router.post(
  '/sale/:id/void',
  protect,
  requirePermission('pos.cancelOrder'),
  validate(voidSchema),
  voidTransaction
);

router.post(
  '/sale/:id/refund',
  protect,
  allowRoleOrPermission(['owner', 'financeManager'], 'pos.manage'),
  validate(refundSchema),
  refundTransaction
);

router.get('/deliveries/riders', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), getDeliveryRiders);
router.get('/charge-to-salary/employees', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), getChargeToSalaryEmployees);
router.get('/charge-to-salary/employees/:employeeId/credit-summary', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), getChargeToSalaryEmployeeCreditSummary);
router.patch('/deliveries/:id/rider', protect, allowRoleOrPermission(['cashier'], 'pos.sale'), assignDeliveryRider);

// Cashier: offline sync — submit batched transactions
router.post(
  '/sync-offline/status',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  validate(offlineSyncStatusSchema),
  getOfflineSyncStatus
);

router.post(
  '/sync-offline',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  validate(syncOfflineSchema),
  syncOffline
);

// Cashier: resume a held order (record stays in DB until paid, returns cart)
router.patch(
  '/held-orders/:id',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  validate(holdSchema),
  updateHeldOrder,
);

router.post(
  '/held-orders/:id/resume',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  resumeHeldOrder
);

// Cashier: stamp a held order as kitchen-printed
router.patch(
  '/held-orders/:id/printed',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  markHeldOrderPrinted,
);

// Cashier: move a line item from one held order to another
router.patch(
  '/held-orders/:sourceId/move-item',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  validate(moveHeldItemSchema),
  moveHeldOrderItem
);

// Cashier: cancel a held order — keeps the record (status 'void'). If it was
// already prepared, deducts the recipe from stock and logs it as waste.
router.post(
  '/held-orders/:id/cancel',
  protect,
  requirePermission('pos.sale'),
  requirePermission('pos.cancelOrder'),
  validate(cancelHeldOrderSchema),
  cancelHeldOrder
);

// Cashier: list all held orders for an outlet
router.get(
  '/held-orders/:outletId',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  getHeldOrders
);

// Cashier: shared history for the caller's outlet (any cashier/session, all time)
router.get(
  '/transactions/me',
  protect,
  allowRoleOrPermission(['cashier'], 'pos.sale'),
  getMyTransactions,
);

// Cashier: preview ingredient cost and allocated order value before logging a
// held or completed order (or selected items) as waste.
router.get(
  '/transactions/:id/waste-preview',
  protect,
  requirePermission('pos.sale'),
  requireAnyPermission('pos.cancelOrder', 'pos.logWaste'),
  getPosWastePreview,
);

// Cashier: log one of their own completed orders as waste (POS order history)
router.post(
  '/transactions/:id/waste',
  protect,
  requirePermission('pos.sale'),
  requirePermission('pos.logWaste'),
  validate(wasteOrderSchema),
  logMyTransactionAsWaste,
);

// Cashier, owner, financeManager: transaction list for a session
router.get(
  '/transactions/:sessionId',
  protect,
  allowRoleOrPermission(['cashier', 'owner', 'financeManager'], 'pos.transactions'),
  getTransactionsBySession
);

export default router;
