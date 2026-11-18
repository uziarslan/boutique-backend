import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import tenantFromSlug from '../middleware/publicTenant.middleware.js';
import {
  publicGetMenu,
  publicPlaceOrder,
  publicGetOrder,
  listQrOrders,
  approveQrOrder,
  declineQrOrder,
  publicRequestBill,
  acknowledgeBillRequest,
} from '../controllers/qrOrder.controller.js';

const publicRouter = Router();
const cashierRouter = Router();

// ── Public (no auth, tenant resolved from slug) ─────────────────────────────
publicRouter.get(
  '/menu/:tenantSlug/:outletCode/:tableCode',
  tenantFromSlug('qrOrdering'),
  publicGetMenu,
);
publicRouter.post(
  '/orders/:tenantSlug/:orderNumber/request-bill',
  tenantFromSlug('qrOrdering'),
  publicRequestBill,
);
publicRouter.post(
  '/orders/:tenantSlug/:outletCode/:tableCode',
  tenantFromSlug('qrOrdering'),
  publicPlaceOrder,
);
publicRouter.get(
  '/orders/:tenantSlug/:orderNumber',
  tenantFromSlug('qrOrdering'),
  publicGetOrder,
);

// ── Cashier (JWT, qrOrdering feature) ───────────────────────────────────────
cashierRouter.use(protect, requireFeature('qrOrdering'));
const STAFF = ['cashier', 'owner', 'financeManager'];
cashierRouter.get('/', allowRoleOrPermission(STAFF, 'pos.sale'), listQrOrders);
cashierRouter.post('/:id/approve', allowRoleOrPermission(STAFF, 'pos.sale'), approveQrOrder);
cashierRouter.post('/:id/decline', allowRoleOrPermission(STAFF, 'pos.sale'), declineQrOrder);
cashierRouter.post('/:id/bill-request/acknowledge', allowRoleOrPermission(STAFF, 'pos.sale'), acknowledgeBillRequest);

export { publicRouter, cashierRouter };
