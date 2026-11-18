import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import {
    listSalaryPayments,
    updateSalaryPayment,
    paySalary,
    voidSalaryPayment,
    listAdvances,
    getAdvanceById,
    getAdvanceDeletionPreview,
    updateAdvance,
    deleteAdvance,
    giveAdvance,
    getOutstandingAdvance,
    getOutstandingAllowanceExcess,
    getRevenueAccounts,
    repayAdvance,
    voidAdvance,
    voidRepayment,
} from '../controllers/salary.controller.js';

const router = Router();

// ── Salary Payments ───────────────────────────────────────────────────────────
router.get('/payments', protect, requirePermission('salaries.view'), listSalaryPayments);
router.post('/payments', protect, requirePermission('salaries.manage'), paySalary);
router.patch('/payments/:id', protect, authorize('owner'), updateSalaryPayment);
router.post('/payments/:id/void', protect, requirePermission('salaries.manage'), voidSalaryPayment);

// ── Advances ──────────────────────────────────────────────────────────────────
router.get('/advances', protect, requirePermission('salaries.view'), listAdvances);
router.get('/advances/outstanding/:employeeId', protect, requirePermission('salaries.view'), getOutstandingAdvance);
router.get('/advances/:id', protect, requirePermission('salaries.view'), getAdvanceById);
router.get('/advances/:id/deletion-preview', protect, authorize('owner'), getAdvanceDeletionPreview);
router.get('/allowance-excess/outstanding/:employeeId', protect, requirePermission('salaries.view'), getOutstandingAllowanceExcess);
router.get('/revenue-accounts', protect, requirePermission('salaries.manage'), getRevenueAccounts);
router.post('/advances', protect, requirePermission('salaries.manage'), giveAdvance);
router.patch('/advances/:id', protect, authorize('owner'), updateAdvance);
router.delete('/advances/:id', protect, authorize('owner'), deleteAdvance);
router.post('/advances/:id/repay', protect, requirePermission('salaries.manage'), repayAdvance);
router.post('/advances/:id/void', protect, requirePermission('salaries.manage'), voidAdvance);
router.post('/advances/:advanceId/repayments/:repaymentId/void', protect, requirePermission('salaries.manage'), voidRepayment);

export default router;
