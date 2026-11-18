// Permission defaults per role. This mirrors frontend `permissions.js` so
// both front and back agree on role defaults when no per-user override exists.
export const PERMISSIONS = [
    { key: 'dashboard.view', owner: true, financeManager: true, purchaseManager: true, receivingStaff: true },

    // Purchasing
    { key: 'vendors.manage', owner: true, financeManager: false, purchaseManager: true, receivingStaff: false },
    { key: 'products.manage', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'purchases.view', owner: true, financeManager: true, purchaseManager: true, receivingStaff: true },
    { key: 'purchases.create', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'purchases.post', owner: true, financeManager: true, purchaseManager: true, receivingStaff: true },
    // Destructive/correction authority is explicit. Owners always retain it;
    // every other user must be granted it from Role Settings.
    { key: 'purchases.edit', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'purchases.delete', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'payments.view', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'payments.record', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'payments.edit', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'payments.delete', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },

    // Accounting
    { key: 'accounting.view', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.journals', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.coa', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.journalEntries', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.ledger', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.reports', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.apAging', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.arAging', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    // Edit/delete are off for every role by default — the owner grants them per
    // user in Role Settings. (Owner always has them via the superuser bypass.)
    { key: 'accounting.editJournalEntry', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.deleteJournalEntry', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.editAccount', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'accounting.deleteAccount', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },

    // Staff allowances — independent of accounting.reports / reports.aging so
    // toggling P&L / Balance Sheet doesn't accidentally expose this tab.
    { key: 'allowances.view', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'allowances.manage', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },

    // Operations
    { key: 'menu.manage', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'inventory.view', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'inventory.manage', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'store.view', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'store.manage', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'kds.view', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    { key: 'kds.operate', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    { key: 'kds.cancel', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },

    // Rider Tracking & Dispatch (also gated by the outlet riderTracking feature).
    { key: 'riderTracking.live', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false, cashier: true, rider: false },
    { key: 'riderTracking.assign', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: true, rider: false },
    { key: 'riderTracking.history', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false, cashier: false, rider: false },
    { key: 'riderTracking.manage', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false, rider: false },

    // Asset Register & Audit (also gated by the outlet-scoped assetAudit feature).
    { key: 'assets.view', owner: true, financeManager: true, purchaseManager: true, receivingStaff: true },
    { key: 'assets.manage', owner: true, financeManager: false, purchaseManager: true, receivingStaff: false },
    { key: 'assetAudits.create', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },
    { key: 'assetAudits.count', owner: true, financeManager: false, purchaseManager: true, receivingStaff: true },
    { key: 'assetAudits.review', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },
    { key: 'assetAudits.approve', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'assets.accounting', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },

    { key: 'attendance.view', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },
    { key: 'attendance.manage', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },

    // Reports
    { key: 'reports.cogs', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.belowPar', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },
    { key: 'reports.spend', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.priceHistory', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.vendorPerformance', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.aging', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.salesSummary', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.salesTransactions', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.salesByItem', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.salesByCashier', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.hourly', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'reports.orderLifecycle', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    { key: 'reports.kitchenCounterSales', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },

    // Settings
    { key: 'settings.users', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'settings.roles', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'settings.outlets', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'settings.integrations', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'settings.printers', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    { key: 'settings.kds', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    // POS
    { key: 'pos.sale', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: true },
    { key: 'pos.manage', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'pos.transactions', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false },
    { key: 'pos.discount', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false, cashier: false },
    // Whole-order cancellation remains owner authority by default.
    { key: 'pos.cancelOrder', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    // Owners retain full access; every non-owner must be granted this high-risk
    // authority individually.
    { key: 'pos.cancelSentItem', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false, rider: false },
    { key: 'pos.logWaste', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false, cashier: true },
    { key: 'pos.drawerAdd', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: true },
    { key: 'pos.drawerEdit', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
    { key: 'pos.drawerDelete', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },

    // Add-on features (only usable when the admin has enabled the feature flag)
    { key: 'tables.manage',  owner: true, financeManager: true, purchaseManager: false, receivingStaff: false, cashier: false },
    { key: 'loyalty.manage', owner: true, financeManager: true, purchaseManager: false, receivingStaff: false, cashier: false },

    // Employees
    { key: 'employees.view', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },
    { key: 'employees.manage', owner: true, financeManager: true, purchaseManager: true, receivingStaff: false },

    // Salaries
    { key: 'salaries.view', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    { key: 'salaries.manage', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false },
    // Explicit owner-granted exception authority. It only bypasses the daily
    // and rolling seven-day limits; the 60% outstanding/cycle ceiling remains
    // non-overridable in the credit policy service.
    { key: 'salaries.overrideCreditLimits', owner: true, financeManager: false, purchaseManager: false, receivingStaff: false, cashier: false },
];

export const allowedByDefault = (permissionKey, role) => {
    const p = PERMISSIONS.find((x) => x.key === permissionKey);
    if (!p) return false;
    return !!p[role];
};

export default { PERMISSIONS, allowedByDefault };
