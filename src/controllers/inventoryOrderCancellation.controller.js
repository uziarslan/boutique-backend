import mongoose from 'mongoose';
import SaleTransaction from '../models/SaleTransaction.js';
import { getSaleKdsCancellationState } from '../services/kds.service.js';
import { cancelKdsOrder } from './kds.controller.js';
import { voidTransaction } from './sale.controller.js';

// The Waste Log collects the same preparation confirmation as KDS. Resolve
// kitchen ownership at submission time, rather than trusting a cached preview
// or a client-supplied flag to bypass the cashier cancellation guard.
export const cancelPunchedOrder = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
  }
  const sale = await SaleTransaction.findById(req.params.id).select('outlet status').lean();
  if (!sale) return res.status(404).json({ success: false, message: 'Transaction not found.' });
  if (!['completed', 'out-for-delivery'].includes(sale.status)) {
    return res.status(409).json({ success: false, message: `Cannot void a transaction with status '${sale.status}'.` });
  }

  const kds = await getSaleKdsCancellationState(sale, req.tenant || req.user?.tenantSlug);
  if (kds?.cancellationRequiresKitchen) {
    if (!req.user.hasPermission('kds.cancel')) {
      return res.status(403).json({
        success: false,
        code: 'KDS_CANCELLATION_REQUIRED',
        message: 'Kitchen has accepted this order. A staff member with KDS cancellation permission must confirm and cancel it.',
      });
    }
    req.params.id = String(kds._id);
    // Reuse the KDS outlet/feature checks and the existing stock, accounting,
    // waste, and cancellation-history handling.
    return cancelKdsOrder(req, res);
  }

  return voidTransaction(req, res);
};
