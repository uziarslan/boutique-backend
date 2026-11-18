import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import { getConfig, updateConfig } from '../controllers/taxConfig.controller.js';

const router = Router();

router.use(protect);

const MANAGER_ROLES = ['owner', 'financeManager'];

// Read is broad — the POS terminal (cashier via pos.sale) reads the rates to
// mirror the server's tax maths for display. Editing is owner / finance only.
router.get('/config', allowRoleOrPermission([...MANAGER_ROLES, 'cashier'], ['pos.sale', 'settings.users']), getConfig);
router.patch('/config', allowRoleOrPermission(MANAGER_ROLES, 'settings.users'), updateConfig);

export default router;
