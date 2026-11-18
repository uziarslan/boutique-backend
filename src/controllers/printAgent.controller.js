import PrintJob from '../models/PrintJob.js';
import { ensureKdsOrderForSale, reportKdsError } from '../services/kds.service.js';
import SaleTransaction from '../models/SaleTransaction.js';
import logger from '../utils/logger.js';
import { getIo } from '../utils/socket.js';
import { qrOrderTimingData, stampQrKitchenTiming } from '../services/qrOrderState.service.js';
import {
  canProbePrintStation,
  getPrintStationSignalVersion,
  markPrintStationEmpty,
  millisecondsUntilPrintProbe,
  schedulePrintStationNotification,
  waitForPrintStationSignal,
} from '../utils/printClaimCoordinator.js';

export const getPrintStationStatus = async (req, res) => {
  const counts = await PrintJob.aggregate([
    { $match: { stationId: req.restaurantDevice.id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return res.json({
    success: true,
    station: req.restaurantDevice,
    queue: Object.fromEntries(counts.map((row) => [row._id, row.count])),
  });
};

export const claimPrintJob = async (req, res) => {
  const requestedWaitSeconds = Number(req.query?.wait || 0);
  const waitMs = Number.isFinite(requestedWaitSeconds)
    ? Math.min(25, Math.max(0, requestedWaitSeconds)) * 1000
    : 0;
  const deadline = Date.now() + waitMs;
  const stationId = req.restaurantDevice.id;

  while (true) {
    const observedVersion = getPrintStationSignalVersion(stationId);
    if (canProbePrintStation(stationId)) {
      const now = new Date();
      const job = await PrintJob.findOneAndUpdate(
        {
          stationId,
          outlet: req.restaurantDevice.outletId,
          $or: [
            { status: 'pending', availableAt: { $lte: now } },
            { status: 'failed', availableAt: { $lte: now } },
            { status: 'claimed', leaseUntil: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'claimed',
            claimedAt: now,
            leaseUntil: new Date(now.getTime() + 60_000),
            lastError: '',
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after', sort: { createdAt: 1 } },
      ).lean();
      if (job) return res.json({ success: true, job });
      markPrintStationEmpty(stationId, observedVersion);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return res.json({ success: true, job: null });
    const untilProbeMs = millisecondsUntilPrintProbe(stationId);
    await waitForPrintStationSignal(
      stationId,
      observedVersion,
      Math.min(remainingMs, Math.max(1, untilProbeMs)),
    );
  }
};

export const completePrintJob = async (req, res) => {
  const job = await PrintJob.findOneAndUpdate(
    {
      _id: req.params.id,
      stationId: req.restaurantDevice.id,
      outlet: req.restaurantDevice.outletId,
      status: { $in: ['claimed', 'printed'] },
    },
    {
      $set: {
        status: 'printed',
        printedAt: new Date(),
        confirmation: String(req.body?.confirmation || 'windows-spooler-accepted').slice(0, 100),
        leaseUntil: null,
        lastError: '',
      },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!job) return res.status(404).json({ success: false, message: 'Claimed print job not found.' });
  const remaining = await PrintJob.countDocuments({
    order: job.order,
    status: { $nin: ['printed', 'cancelled'] },
  });
  const order = await SaleTransaction.findById(job.order);
  if (remaining === 0) {
    if (order) {
      order.kitchenPrintedAt = new Date();
      order.kitchenPrintedQtyMap = Object.fromEntries(
        (order.items || []).map((item) => [
          `${item.menuItem?._id || item.menuItem}::${item.variation?.id || ''}`,
          Number(item.qty || 0),
        ]),
      );
      await stampQrKitchenTiming(order, order.kitchenPrintedAt);
      await order.save();
      try {
        await ensureKdsOrderForSale(order, null, {
          tenantSlug: req.tenantSlug,
          printStatus: 'printed',
        });
      } catch (kdsError) {
        reportKdsError(`Could not create connector KDS ticket for ${order.transactionNumber}`, kdsError);
      }
    }
  }
  if (order?.source === 'staff-tablet') {
    const payload = {
      orderId: String(order._id),
      status: remaining === 0 ? 'printed' : 'sending',
      printedAt: remaining === 0 ? order.kitchenPrintedAt : null,
    };
    const io = getIo();
    io?.to(`orders:${req.tenantSlug}:${String(req.restaurantDevice.outletId)}`)
      .emit('tablet-order:print-status', payload);
    if (job.submittedByDeviceId) {
      io?.to(`tablet-orders:${req.tenantSlug}:${String(job.submittedByDeviceId)}`)
        .emit('tablet-order:print-status', payload);
    }
  }
  if (order?.source === 'qr-self-order' && remaining === 0) {
    const io = getIo();
    io?.to(`qr:order:${req.tenantSlug}:${order.transactionNumber}`)
      .emit('qr-order:status', {
        orderNumber: order.transactionNumber,
        status: order.status,
        kitchenPrintedAt: order.kitchenPrintedAt,
        ...qrOrderTimingData(order),
      });
  }
  logger.info(`Print job completed: ${job._id} station=${req.restaurantDevice.id} printer=${job.printerName}`);
  return res.json({ success: true, job });
};

export const failPrintJob = async (req, res) => {
  const existing = await PrintJob.findOne({
    _id: req.params.id,
    stationId: req.restaurantDevice.id,
    outlet: req.restaurantDevice.outletId,
  }).select('attempts').lean();
  if (!existing) return res.status(404).json({ success: false, message: 'Print job not found.' });
  const delaySeconds = Math.min(60, Math.max(3, 2 ** Math.min(existing.attempts || 1, 5)));
  const job = await PrintJob.findOneAndUpdate(
    { _id: existing._id },
    {
      $set: {
        status: 'failed',
        lastError: String(req.body?.error || 'Printer job failed.').slice(0, 500),
        availableAt: new Date(Date.now() + delaySeconds * 1000),
        leaseUntil: null,
      },
    },
    { returnDocument: 'after' },
  ).lean();
  schedulePrintStationNotification(req.restaurantDevice.id, delaySeconds * 1000);
  const order = await SaleTransaction.findById(job.order).select('source').lean();
  if (order?.source === 'staff-tablet') {
    const payload = { orderId: String(order._id), status: 'failed' };
    const io = getIo();
    io?.to(`orders:${req.tenantSlug}:${String(req.restaurantDevice.outletId)}`)
      .emit('tablet-order:print-status', payload);
    if (job.submittedByDeviceId) {
      io?.to(`tablet-orders:${req.tenantSlug}:${String(job.submittedByDeviceId)}`)
        .emit('tablet-order:print-status', payload);
    }
  }
  logger.warn(`Print job failed: ${job._id} station=${req.restaurantDevice.id} error=${job.lastError}`);
  return res.json({ success: true, job });
};
