import { Router } from 'express';
import { attachRestaurantDevice } from '../middleware/restaurantDevice.middleware.js';
import {
  verifyOrderTablet,
  getTabletMenu,
  createTabletOrder,
  listTabletOrders,
  getTabletOrderStatus,
} from '../controllers/tabletOrder.controller.js';
import {
  searchCustomers,
  getCustomer,
  upsertCustomer,
  addAddress,
  updateAddress,
  updateCustomer,
} from '../controllers/customer.controller.js';

const router = Router();
router.use(attachRestaurantDevice('orderTablet'));
router.get('/verify', verifyOrderTablet);
router.get('/menu', getTabletMenu);
// Reuse the same customer handlers and tenant data as the POS terminal while
// authenticating with the paired order-tablet token.
router.get('/customers/search', searchCustomers);
router.get('/customers/:id', getCustomer);
router.post('/customers', upsertCustomer);
router.post('/customers/:id/addresses', addAddress);
router.patch('/customers/:id/addresses/:addressId', updateAddress);
router.patch('/customers/:id', updateCustomer);
router.get('/orders', listTabletOrders);
router.post('/orders', createTabletOrder);
router.get('/orders/:id', getTabletOrderStatus);
export default router;
