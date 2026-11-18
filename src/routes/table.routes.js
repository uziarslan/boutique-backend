import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import {
  listTables,
  createTable,
  updateTable,
  deleteTable,
  reactivateTable,
  updateQrSettings,
  listQrMenuCategories,
} from '../controllers/table.controller.js';

const router = Router();

router.use(protect, requireFeature('qrOrdering'));

const MANAGER = ['owner', 'financeManager'];

// Listing is needed by the POS terminal (cashier via pos.sale) and by managers
// of the Tables tab (tables.manage). Managing tables requires tables.manage.
router.get('/', allowRoleOrPermission([...MANAGER, 'cashier'], ['pos.sale', 'tables.manage']), listTables);
router.post('/', allowRoleOrPermission(MANAGER, 'tables.manage'), createTable);
router.get('/settings/:outletId/menu-categories', allowRoleOrPermission(MANAGER, 'tables.manage'), listQrMenuCategories);
router.patch('/settings/:outletId', allowRoleOrPermission(MANAGER, 'tables.manage'), updateQrSettings);
router.put('/:id', allowRoleOrPermission(MANAGER, 'tables.manage'), updateTable);
router.delete('/:id', allowRoleOrPermission(MANAGER, 'tables.manage'), deleteTable);
router.post('/:id/reactivate', allowRoleOrPermission(MANAGER, 'tables.manage'), reactivateTable);

export default router;
