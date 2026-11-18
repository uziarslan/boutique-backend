import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import {
    searchCustomers,
    getCustomer,
    upsertCustomer,
    addAddress,
    updateAddress,
    updateCustomer,
} from '../controllers/customer.controller.js';

const router = Router();

// All customer routes require a logged-in cashier JWT (same auth as POS).
router.use(protect);

router.get('/search', searchCustomers);
router.get('/:id', getCustomer);
router.post('/', upsertCustomer);
router.post('/:id/addresses', addAddress);
router.patch('/:id/addresses/:addressId', updateAddress);
router.patch('/:id', updateCustomer);

export default router;
