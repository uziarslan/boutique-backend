import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import {
  getConfig,
  updateConfig,
  listMembers,
  getMember,
  issueMemberCard,
  adjustMemberPoints,
  listTransactions,
  getDashboard,
  getReports,
  triggerExpiry,
} from '../controllers/loyalty.controller.js';

const router = Router();

// Every loyalty route requires the membershipRewards feature flag and a JWT.
router.use(protect, requireFeature('membershipRewards'));

const MANAGER_ROLES = ['owner', 'financeManager'];

// Read access is broad — the POS terminal (cashier via pos.sale) needs the
// config/members to compute earn previews and validate redemptions. Managing
// the loyalty programme requires the dedicated loyalty.manage permission.
const LOYALTY_READ = ['pos.sale', 'loyalty.manage'];

// ── Config ──────────────────────────────────────────────────────────────────
router.get('/config', allowRoleOrPermission([...MANAGER_ROLES, 'cashier'], LOYALTY_READ), getConfig);
router.patch('/config', allowRoleOrPermission(MANAGER_ROLES, 'loyalty.manage'), updateConfig);

// ── Members ─────────────────────────────────────────────────────────────────
router.get('/members', allowRoleOrPermission([...MANAGER_ROLES, 'cashier'], LOYALTY_READ), listMembers);
router.get('/members/:id', allowRoleOrPermission([...MANAGER_ROLES, 'cashier'], LOYALTY_READ), getMember);
router.post('/members/:id/issue-card', allowRoleOrPermission([...MANAGER_ROLES, 'cashier'], LOYALTY_READ), issueMemberCard);
router.post('/members/:id/adjust', allowRoleOrPermission(MANAGER_ROLES, 'loyalty.manage'), adjustMemberPoints);

// ── Transactions ────────────────────────────────────────────────────────────
router.get('/transactions', allowRoleOrPermission([...MANAGER_ROLES, 'cashier'], LOYALTY_READ), listTransactions);

// ── Reporting ───────────────────────────────────────────────────────────────
router.get('/dashboard', allowRoleOrPermission(MANAGER_ROLES, 'loyalty.manage'), getDashboard);
router.get('/reports', allowRoleOrPermission(MANAGER_ROLES, 'loyalty.manage'), getReports);

// ── Expiry sweep (manual trigger; cron also calls runExpirySweep) ──────────
router.post('/expiry/run', allowRoleOrPermission(MANAGER_ROLES, 'loyalty.manage'), triggerExpiry);

export default router;
