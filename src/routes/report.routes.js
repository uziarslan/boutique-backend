import { Router } from 'express';
import {
  getCOGSReport,
  getCOGSByItem,
  getCOGSItemDetail,
  getSpendReport,
  getPriceChangeReport,
  getVendorPerformanceReport,
  getSalesSummary,
  getSalesByItem,
  getSalesByCashier,
  getSalesTransactions,
  getAllSalesTransactions,
  getSalesTransactionById,
  getHourlyBreakdown,
  getCancelledOrders,
  getDashboardStats,
} from '../controllers/report.controller.js';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';

const router = Router();

router.use(protect);
// Lightweight dashboard stats — available to any authenticated user
router.get('/dashboard', getDashboardStats);

// Reports require explicit permission keys so per-user overrides can grant access
router.get('/cogs', requirePermission('reports.cogs'), getCOGSReport);
router.get('/cogs/by-item', requirePermission('reports.cogs'), getCOGSByItem);
router.get('/cogs/by-item/:itemId', requirePermission('reports.cogs'), getCOGSItemDetail);
router.get('/spend', requirePermission('reports.spend'), getSpendReport);
router.get('/price-changes', requirePermission('reports.priceHistory'), getPriceChangeReport);
router.get('/vendor-performance', requirePermission('reports.vendorPerformance'), getVendorPerformanceReport);
router.get('/sales', requirePermission('reports.salesSummary'), getSalesSummary);
router.get('/sales-summary', requirePermission('reports.salesSummary'), getSalesSummary);
router.get('/sales/by-item', requirePermission('reports.salesByItem'), getSalesByItem);
router.get('/sales/by-cashier', requirePermission('reports.salesByCashier'), getSalesByCashier);
router.get('/sales/hourly', requirePermission('reports.hourly'), getHourlyBreakdown);
router.get('/sales-transactions', requirePermission('reports.salesTransactions'), getAllSalesTransactions);
router.get('/sales-transactions/:id', requirePermission('reports.salesTransactions'), getSalesTransactionById);
// Frontend-friendly aliases
router.get('/sales-by-item', requirePermission('reports.salesByItem'), getSalesByItem);
router.get('/sales-by-cashier', requirePermission('reports.salesByCashier'), getSalesByCashier);
router.get('/hourly-breakdown', requirePermission('reports.hourly'), getHourlyBreakdown);
// Row drill-down — allowed for any of the three sales reports' viewers.
router.get(
  '/sales/transactions',
  allowRoleOrPermission(['owner', 'financeManager'], ['reports.salesSummary', 'reports.salesByItem', 'reports.salesByCashier']),
  getSalesTransactions,
);
// Cancelled (voided) orders — management view; reuses sales-summary access.
router.get(
  '/cancelled-orders',
  allowRoleOrPermission(['owner', 'financeManager'], ['reports.salesSummary']),
  getCancelledOrders,
);
// (routes above)

export default router;
