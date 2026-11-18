import { Router } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import Outlet from '../models/Outlet.js';
import PrintStationConfig from '../models/PrintStationConfig.js';
import { RestaurantDeviceModel } from '../platform/models/RestaurantDevice.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  hashRestaurantDeviceToken,
  invalidateRestaurantDeviceCache,
  loadActiveRestaurantDevice,
} from '../middleware/restaurantDevice.middleware.js';
import logger from '../utils/logger.js';

const router = Router();

const sanitize = (device) => ({
  id: device._id,
  type: device.type,
  label: device.label || '',
  outletId: device.outletId,
  outletName: device.outletName || '',
  outletCode: device.outletCode || '',
  printStationId: device.printStationId || '',
  printStationLabel: device.printStationLabel || '',
  createdAt: device.createdAt,
  lastUsedAt: device.lastUsedAt || null,
  revokedAt: device.revokedAt || null,
});

router.post('/verify', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ success: false, message: 'Device token required.' });
  const device = await loadActiveRestaurantDevice(token);
  if (!device) return res.status(401).json({ success: false, message: 'Invalid or revoked device token.' });
  const tenant = await TenantModel().findOne({ slug: device.tenantSlug }).select('slug outletName status accessUntil').lean();
  if (!tenant) return res.status(401).json({ success: false, message: 'Tenant no longer exists.' });
  return res.json({
    success: true,
    tenant: { slug: tenant.slug, name: tenant.outletName },
    device: sanitize(device),
  });
});

router.use(protect, authorize('owner'));

router.get('/', async (req, res) => {
  const devices = await RestaurantDeviceModel()
    .find({ tenantSlug: req.tenantSlug })
    .sort({ createdAt: -1 })
    .lean();
  return res.json({ success: true, devices: devices.map(sanitize) });
});

router.post('/', async (req, res) => {
  const type = req.body?.type;
  if (!['orderTablet', 'printStation'].includes(type)) {
    return res.status(422).json({ success: false, message: 'Device type must be orderTablet or printStation.' });
  }
  const outletId = String(req.body?.outletId || '');
  if (!mongoose.isValidObjectId(outletId)) {
    return res.status(422).json({ success: false, message: 'Select a valid outlet.' });
  }
  const outlet = await Outlet.findOne({ _id: outletId, isActive: { $ne: false } })
    .select('_id name code')
    .lean();
  if (!outlet) return res.status(422).json({ success: false, message: 'Outlet not found.' });

  let linkedStation = null;
  let existingStations = [];
  if (type === 'orderTablet') {
    const requestedStationId = String(req.body?.printStationId || '').trim();
    if (requestedStationId && !mongoose.isValidObjectId(requestedStationId)) {
      return res.status(422).json({ success: false, message: 'Select a valid print computer.' });
    }
    if (requestedStationId) {
      linkedStation = await RestaurantDeviceModel().findOne({
        _id: requestedStationId,
        tenantSlug: req.tenantSlug,
        type: 'printStation',
        outletId,
        revokedAt: null,
      }).lean();
      if (!linkedStation) {
        return res.status(422).json({
          success: false,
          message: 'The selected print computer is not active for this outlet.',
        });
      }
    } else {
      existingStations = await RestaurantDeviceModel().find({
        tenantSlug: req.tenantSlug,
        type: 'printStation',
        outletId,
        revokedAt: null,
      }).sort({ createdAt: 1 }).lean();
      if (existingStations.length > 1) {
        return res.status(422).json({
          success: false,
          message: 'Select which print computer this tablet should use.',
        });
      }
      [linkedStation] = existingStations;
    }
  } else {
    existingStations = await RestaurantDeviceModel().find({
      tenantSlug: req.tenantSlug,
      type: 'printStation',
      outletId,
      revokedAt: null,
    }).sort({ createdAt: 1 }).lean();
  }

  const token = crypto.randomBytes(32).toString('hex');
  const device = await RestaurantDeviceModel().create({
    tokenHash: hashRestaurantDeviceToken(token),
    tenantSlug: req.tenantSlug,
    type,
    label: String(req.body?.label || '').trim().slice(0, 80),
    outletId: String(outlet._id),
    outletName: outlet.name || '',
    outletCode: outlet.code || '',
    printStationId: linkedStation ? String(linkedStation._id) : '',
    printStationLabel: linkedStation?.label || '',
    createdByEmail: req.user?.email || '',
  });
  if (type === 'printStation') {
    await PrintStationConfig.create({
      stationId: String(device._id),
      stationLabel: device.label || 'Reception Print Station',
      outlet: outlet._id,
      printers: [],
      updatedBy: req.user.id,
    });
    // Preserve legacy Tablet 1 → Computer 1 behaviour. If this is the first
    // station, attach previously-created unassigned tablets to it. If this is
    // Computer 2, attach legacy tablets to the original Computer 1 so enabling
    // multiple stations never creates duplicate tickets.
    const legacyStation = existingStations[0] || device;
    await RestaurantDeviceModel().updateMany(
      {
        tenantSlug: req.tenantSlug,
        type: 'orderTablet',
        outletId,
        revokedAt: null,
        $or: [
          { printStationId: { $exists: false } },
          { printStationId: '' },
          { printStationId: null },
        ],
      },
      {
        $set: {
          printStationId: String(legacyStation._id),
          printStationLabel: legacyStation.label || '',
        },
      },
    );
  }
  logger.info(`Restaurant device created: ${type} ${device._id} tenant=${req.tenantSlug} outlet=${outlet.code}`);
  return res.status(201).json({ success: true, device: sanitize(device.toObject()), token });
});

router.patch('/:id', async (req, res) => {
  const device = await RestaurantDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
    revokedAt: null,
  });
  if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });

  if (req.body?.label !== undefined) {
    device.label = String(req.body.label || '').trim().slice(0, 80);
  }
  if (req.body?.printStationId !== undefined) {
    if (device.type !== 'orderTablet') {
      return res.status(422).json({ success: false, message: 'Only order tablets can be assigned to a print computer.' });
    }
    const printStationId = String(req.body.printStationId || '').trim();
    if (!mongoose.isValidObjectId(printStationId)) {
      return res.status(422).json({ success: false, message: 'Select a valid print computer.' });
    }
    const station = await RestaurantDeviceModel().findOne({
      _id: printStationId,
      tenantSlug: req.tenantSlug,
      type: 'printStation',
      outletId: device.outletId,
      revokedAt: null,
    }).lean();
    if (!station) {
      return res.status(422).json({
        success: false,
        message: 'The selected print computer is not active for this tablet outlet.',
      });
    }
    device.printStationId = String(station._id);
    device.printStationLabel = station.label || '';
  }
  await device.save();
  invalidateRestaurantDeviceCache(device.tokenHash);

  if (device.type === 'printStation' && req.body?.label !== undefined) {
    await Promise.all([
      PrintStationConfig.updateOne(
        { stationId: String(device._id) },
        { $set: { stationLabel: device.label || '' } },
      ),
      RestaurantDeviceModel().updateMany(
        {
          tenantSlug: req.tenantSlug,
          type: 'orderTablet',
          printStationId: String(device._id),
        },
        { $set: { printStationLabel: device.label || '' } },
      ),
    ]);
  }
  return res.json({ success: true, device: sanitize(device.toObject()) });
});

router.post('/:id/regenerate', async (req, res) => {
  const device = await RestaurantDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
    revokedAt: null,
  });
  if (!device) return res.status(404).json({ success: false, message: 'Active device not found.' });
  const token = crypto.randomBytes(32).toString('hex');
  const previousTokenHash = device.tokenHash;
  device.tokenHash = hashRestaurantDeviceToken(token);
  device.lastUsedAt = null;
  await device.save();
  invalidateRestaurantDeviceCache(previousTokenHash);
  return res.json({ success: true, device: sanitize(device.toObject()), token });
});

router.delete('/:id', async (req, res) => {
  const device = await RestaurantDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
  });
  if (!device) return res.status(404).json({ success: false, message: 'Device not found.' });
  if (device.type === 'printStation') {
    const linkedTablets = await RestaurantDeviceModel().countDocuments({
      tenantSlug: req.tenantSlug,
      type: 'orderTablet',
      printStationId: String(device._id),
      revokedAt: null,
    });
    if (linkedTablets > 0) {
      return res.status(409).json({
        success: false,
        message: `Move or revoke the ${linkedTablets} linked order tablet${linkedTablets === 1 ? '' : 's'} before revoking this print computer.`,
      });
    }
  }
  device.revokedAt = new Date();
  await device.save();
  invalidateRestaurantDeviceCache(device.tokenHash);
  if (device.type === 'printStation') {
    await PrintStationConfig.updateOne(
      { stationId: String(device._id) },
      { $set: { printers: [] } },
    );
  }
  return res.json({ success: true });
});

router.get('/:id/printer-config', async (req, res) => {
  const device = await RestaurantDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
    type: 'printStation',
    revokedAt: null,
  }).lean();
  if (!device) return res.status(404).json({ success: false, message: 'Print station not found.' });
  const config = await PrintStationConfig.findOne({ stationId: String(device._id) }).lean();
  return res.json({ success: true, config: config || null });
});

router.put('/:id/printer-config', async (req, res) => {
  const device = await RestaurantDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
    type: 'printStation',
    revokedAt: null,
  }).lean();
  if (!device) return res.status(404).json({ success: false, message: 'Print station not found.' });
  const printers = Array.isArray(req.body?.printers) ? req.body.printers.slice(0, 20) : [];
  const normalized = [];
  const physicalPrinters = new Set();
  for (const printer of printers) {
    const printerName = String(printer?.printerName || '').trim();
    if (!printerName) continue;
    const physicalKey = printerName.toLocaleLowerCase();
    if (physicalPrinters.has(physicalKey)) {
      return res.status(422).json({
        success: false,
        message: `Windows printer "${printerName}" is listed more than once. Use one route per physical printer to prevent duplicate tickets.`,
      });
    }
    physicalPrinters.add(physicalKey);
    const categoryIds = (Array.isArray(printer.categoryIds) ? printer.categoryIds : [])
      .filter((id) => mongoose.isValidObjectId(id));
    normalized.push({
      printerName,
      displayName: String(printer.displayName || printerName).trim().slice(0, 100),
      role: printer.role === 'dispatch' ? 'dispatch' : 'kitchen',
      categoryIds,
      allCategories: printer.allCategories === true,
      copies: Math.max(1, Math.min(5, Number(printer.copies) || 1)),
      enabled: printer.enabled !== false,
    });
  }
  const config = await PrintStationConfig.findOneAndUpdate(
    { stationId: String(device._id) },
    {
      $set: {
        stationLabel: device.label || '',
        outlet: new mongoose.Types.ObjectId(device.outletId),
        printers: normalized,
        updatedBy: req.user.id,
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).lean();
  return res.json({ success: true, config });
});

export default router;
