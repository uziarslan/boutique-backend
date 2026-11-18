export const FEATURES = [
  { key: 'purchasing',       label: 'Purchases',           description: 'Unified purchases, stock posting, vendor balances and payments' },
  { key: 'accounting',       label: 'Accounting',          description: 'Chart of Accounts, Journals, Ledger, Financial Reports' },
  { key: 'inventory',        label: 'Legacy Kitchen Inventory', description: 'Restaurant recipe stock, counts and kitchen waste; disabled in the boutique build' },
  { key: 'store',            label: 'Raw Materials',            description: 'Purchased raw material stock used by boutique production' },
  { key: 'menu',             label: 'Menu Management',     description: 'Menu and Recipe Management' },
  { key: 'pos',              label: 'POS',                 description: 'Point of Sale Sessions and Terminal' },
  { key: 'reports',          label: 'Reports',             description: 'Business Analytics and Reports' },
  { key: 'payroll',          label: 'Payroll',             description: 'Salaries and Staff Allowances' },
  { key: 'attendance',       label: 'Attendance',          description: 'Staff Attendance Tracking' },
  { key: 'employees',        label: 'Employees',           description: 'Employee Management' },
  { key: 'assetAudit',       label: 'Asset Register & Audit', description: 'Outlet asset register, physical audits, depreciation and accounting reconciliation' },
  { key: 'membershipRewards', label: 'Membership / Rewards', description: 'Customer loyalty points and membership cards' },
  { key: 'qrOrdering',        label: 'QR Self-Order',         description: 'Customers scan a table QR code and place orders themselves' },
  { key: 'kds',               label: 'Kitchen Display System', description: 'Kitchen display board, KDS settings, ready-order alerts and lifecycle reports' },
  { key: 'riderTracking',     label: 'Rider Tracking & Dispatch', description: 'React Native rider app, live locations, route history and cashier dispatch' },
  // Attendance anti-spoofing add-ons. Behavioural flags — they gate no routes,
  // only runtime behaviour of the attendance flow. Both default OFF so every
  // existing tenant keeps the current camera Face-ID behaviour untouched.
  { key: 'attendanceLiveness',       label: 'Enhanced Attendance (Liveness)', description: 'Require a live blink + head-turn check before the camera face scan to defeat photo/video spoofing' },
  { key: 'attendanceExternalDevice', label: 'External Face Terminal',         description: 'Use an on-premise Hikvision face terminal for attendance instead of the tablet camera' },
];

// Most features ship enabled. Opt-in features are listed here and default to
// false until an admin enables them for an outlet.
export const FEATURE_DEFAULT_OVERRIDES = {
  inventory: false,
  menu: false,
  kds: false,
  riderTracking: false,
  qrOrdering: false,
  assetAudit: false,
  membershipRewards: false,
  attendanceLiveness: false,
  attendanceExternalDevice: false,
};

export const DEFAULT_FEATURES = Object.fromEntries(
  FEATURES.map((f) => [f.key, FEATURE_DEFAULT_OVERRIDES[f.key] ?? true])
);

/**
 * Normalizes a feature snapshot (Map | plain object | undefined) into
 * a plain object with every known feature key present. Missing keys fall
 * back to DEFAULT_FEATURES (which respects FEATURE_DEFAULT_OVERRIDES).
 *
 * Kept for legacy tenant-level production data and migration. New runtime
 * consumers should use outletFeatures.service so the outlet scope is applied.
 */
export const resolveTenantFeatures = (rawFeatures) => {
  const stored = rawFeatures instanceof Map
    ? Object.fromEntries(rawFeatures)
    : (rawFeatures || {});
  return { ...DEFAULT_FEATURES, ...stored };
};
