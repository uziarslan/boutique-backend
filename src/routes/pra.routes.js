import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import allowRoleOrPermission from '../middleware/rolePermission.middleware.js';
import {
  checkPraSetup,
  getPraConfig,
  retryPra,
  updatePraConfig,
} from '../controllers/pra.controller.js';

const router = Router();
router.use(protect);

const ownerOnly = allowRoleOrPermission(['owner']);
router.get('/config', ownerOnly, getPraConfig);
router.patch('/config', ownerOnly, updatePraConfig);
router.post('/check', ownerOnly, checkPraSetup);
router.post('/retry/:saleId', allowRoleOrPermission(['owner', 'financeManager']), retryPra);

export default router;
