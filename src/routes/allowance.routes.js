import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import {
    listAllowances,
    getExcessReport,
    getUserAllowance,
    setUserAllowanceLimit,
    searchUsersForAllowance,
    settleExcess,
} from '../controllers/allowance.controller.js';

const router = Router();

// ── POS-accessible routes (cashier JWT or management JWT) ────────────────────
// These two endpoints power the cashier's allowance picker at checkout, so
// they only require an authenticated session — no allowances.* permission.

// Search users by name for allowance selection at checkout
// GET /api/allowances/search?q=name
router.get('/search', protect, searchUsersForAllowance);

// Get a specific user's current allowance (POS needs this to show balance)
// GET /api/allowances/user/:userId
router.get('/user/:userId', protect, getUserAllowance);

// ── Management routes ────────────────────────────────────────────────────────
// Read endpoints require allowances.view; write endpoints require
// allowances.manage. These keys are independent of accounting.reports so
// toggling P&L / Balance Sheet in Role Settings does not affect them.

// List all users with allowance summary for current (or specified) period
router.get('/', protect, requirePermission('allowances.view'), listAllowances);

// Get all users with unsettled excess (for aging report)
router.get('/excess', protect, requirePermission('allowances.view'), getExcessReport);

// Set a user's monthly allowance limit
router.post('/user/:userId', protect, requirePermission('allowances.manage'), setUserAllowanceLimit);

// Settle excess (records the payment and zeroes the unsettled balance)
router.post('/:allowanceId/settle', protect, requirePermission('allowances.manage'), settleExcess);

export default router;
