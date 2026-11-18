import { Router } from 'express';
import requirePlatformAdmin from '../middleware/adminAuth.middleware.js';
import {
  adminLogin,
  adminRefresh,
  adminLogout,
  adminMe,
} from '../controllers/adminAuth.controller.js';
import {
  listTenants,
  getTenant,
  updateTenant,
  grantAccess,
  suspendTenant,
  deleteTenant,
  updateFeatures,
  updateOutletFeatures,
  updateAssetAuditOutlet,
} from '../controllers/adminTenant.controller.js';
import {
  getTenantBilling,
  updateTenantBillingConfig,
  issueTenantInvoice,
  markSubscriptionInvoicePaid,
  voidSubscriptionInvoice,
  resendSubscriptionInvoice,
  downloadSubscriptionInvoice,
  downloadSubscriptionReceipt,
} from '../controllers/adminBilling.controller.js';
import {
  getAdminBillingSettings,
  updateAdminBillingSettings,
} from '../controllers/adminBillingSettings.controller.js';

const router = Router();

router.post('/auth/login', adminLogin);
router.post('/auth/refresh', adminRefresh);
router.post('/auth/logout', adminLogout);
router.get('/auth/me', requirePlatformAdmin, adminMe);

router.get('/tenants', requirePlatformAdmin, listTenants);
router.get('/tenants/:id', requirePlatformAdmin, getTenant);
router.patch('/tenants/:id', requirePlatformAdmin, updateTenant);
router.get('/billing/settings', requirePlatformAdmin, getAdminBillingSettings);
router.patch('/billing/settings', requirePlatformAdmin, updateAdminBillingSettings);
router.get('/tenants/:id/billing', requirePlatformAdmin, getTenantBilling);
router.patch('/tenants/:id/billing/config', requirePlatformAdmin, updateTenantBillingConfig);
router.post('/tenants/:id/billing/invoices', requirePlatformAdmin, issueTenantInvoice);
router.post('/billing/invoices/:invoiceId/mark-paid', requirePlatformAdmin, markSubscriptionInvoicePaid);
router.post('/billing/invoices/:invoiceId/void', requirePlatformAdmin, voidSubscriptionInvoice);
router.post('/billing/invoices/:invoiceId/resend', requirePlatformAdmin, resendSubscriptionInvoice);
router.get('/billing/invoices/:invoiceId/pdf', requirePlatformAdmin, downloadSubscriptionInvoice);
router.get('/billing/invoices/:invoiceId/receipt', requirePlatformAdmin, downloadSubscriptionReceipt);
// Outlet-scoped feature management (authoritative).
router.patch(
  '/tenants/:id/outlets/:outletId/features',
  requirePlatformAdmin,
  updateOutletFeatures,
);
// Deprecated bulk/compatibility endpoints retained for rolling deployments.
router.patch('/tenants/:id/features', requirePlatformAdmin, updateFeatures);
router.patch(
  '/tenants/:id/features/asset-audit/outlets/:outletId',
  requirePlatformAdmin,
  updateAssetAuditOutlet,
);
router.post('/tenants/:id/grant-access', requirePlatformAdmin, grantAccess);
router.post('/tenants/:id/suspend', requirePlatformAdmin, suspendTenant);
router.delete('/tenants/:id', requirePlatformAdmin, deleteTenant);

export default router;
