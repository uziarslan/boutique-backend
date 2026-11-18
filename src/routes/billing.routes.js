import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import {
  getMyBillingStatus,
  listMySubscriptionInvoices,
  downloadMySubscriptionInvoice,
  downloadMySubscriptionReceipt,
} from '../controllers/billing.controller.js';

const router = Router();
router.use(protect);
router.get('/status', getMyBillingStatus);
router.get('/invoices', listMySubscriptionInvoices);
router.get('/invoices/:invoiceId/pdf', downloadMySubscriptionInvoice);
router.get('/invoices/:invoiceId/receipt', downloadMySubscriptionReceipt);

export default router;
