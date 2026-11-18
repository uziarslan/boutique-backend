import crypto from 'crypto';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import StockItem from '../models/StockItem.js';
import StockMovement from '../models/StockMovement.js';
import Outlet from '../models/Outlet.js';
import RetailVariant from '../models/RetailVariant.js';
import RetailInventoryMovement from '../models/RetailInventoryMovement.js';
import BillOfMaterials from '../models/BillOfMaterials.js';
import ProductionOrder from '../models/ProductionOrder.js';
import { getTenantConnection } from '../db/tenantContext.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const orderNumber = () => `MO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

export const getProductionSetup = async (req, res) => {
  const outlets = await Outlet.find({ isActive: { $ne: false } }).select('_id name code').sort({ name: 1 }).lean();
  let outletId = String(req.query.outletId || (outlets.length === 1 ? outlets[0]._id : '')).trim();
  if (outletId && (!mongoose.isValidObjectId(outletId) || !outlets.some((outlet) => String(outlet._id) === outletId))) throw fail('Choose an active outlet.', 404);
  const [products, stocks, variants] = await Promise.all([
    Product.find({ isActive: true }).select('_id name sku unit currentPrice category').sort({ name: 1 }).lean(),
    outletId ? StockItem.find({ outlet: outletId, area: 'store' }).select('product qtyOnHand unit').lean() : Promise.resolve([]),
    outletId ? RetailVariant.find({ isActive: true, tracked: true, 'inventoryByLocation.outlet': outletId })
      .populate('product', 'title').select('_id product title sku options unitCost inventoryByLocation catalogSource shopifyVariantId').sort({ sku: 1 }).lean() : Promise.resolve([]),
  ]);
  const stockByProduct = new Map(stocks.map((row) => [String(row.product), Number(row.qtyOnHand || 0)]));
  const materials = products.map((product) => ({ ...product, storeQty: stockByProduct.get(String(product._id)) || 0 }));
  const finishedVariants = variants.map((variant) => {
    const location = variant.inventoryByLocation.find((entry) => String(entry.outlet) === outletId);
    return { ...variant, catalogSource: variant.catalogSource || (variant.shopifyVariantId ? 'shopify' : 'manual'), productTitle: variant.product?.title || 'Product', shopifyLocationId: location?.shopifyLocationId || '', available: Number(location?.available || 0) };
  });
  res.json({ success: true, data: { outlets, outletId, materials, finishedVariants } });
};

const validateBom = async (input) => {
  const finishedVariant = String(input.finishedVariant || '').trim();
  const name = String(input.name || '').trim().slice(0, 120);
  const batchSize = Number(input.batchSize || 1);
  const materials = Array.isArray(input.materials) ? input.materials : [];
  if (!mongoose.isValidObjectId(finishedVariant) || !name || !Number.isFinite(batchSize) || batchSize < 1 || batchSize > 100000) throw fail('Enter a BOM name, finished variant, and positive batch size.');
  if (!materials.length || materials.length > 100) throw fail('A bill of materials needs 1 to 100 raw material lines.');
  if (!(await RetailVariant.exists({ _id: finishedVariant, isActive: true, tracked: true }))) throw fail('Choose an active, stock-tracked finished variant.', 422);
  const normalized = [];
  for (const line of materials) {
    const productId = String(line.product || '').trim();
    const quantity = Number(line.quantity);
    if (!mongoose.isValidObjectId(productId) || !Number.isFinite(quantity) || quantity <= 0) throw fail('Each material line needs a raw material and positive quantity.');
    const product = await Product.findOne({ _id: productId, isActive: true }).select('unit').lean();
    if (!product) throw fail('A selected raw material is inactive or unavailable.', 422);
    const unit = String(line.unit || product.unit || '').trim();
    if (unit !== product.unit) throw fail(`Use the stored unit (${product.unit}) for this raw material. Unit conversion is not enabled in boutique production.`, 422);
    normalized.push({ product: productId, quantity: round4(quantity), unit, notes: String(line.notes || '').trim().slice(0, 200) });
  }
  return {
    finishedVariant,
    name,
    batchSize: round4(batchSize),
    materials: normalized,
    standardLaborCost: round2(Number(input.standardLaborCost || 0)),
    standardOverheadCost: round2(Number(input.standardOverheadCost || 0)),
  };
};

export const listBillsOfMaterials = async (_req, res) => {
  const boms = await BillOfMaterials.find({}).sort({ updatedAt: -1 })
    .populate({ path: 'finishedVariant', select: 'title sku options', populate: { path: 'product', select: 'title' } })
    .populate('materials.product', 'name sku unit currentPrice').lean();
  res.json({ success: true, data: boms });
};

export const createBillOfMaterials = async (req, res) => {
  const input = await validateBom(req.body || {});
  const [bom] = await BillOfMaterials.create([{ ...input, createdBy: req.user.id, updatedBy: req.user.id }]);
  res.status(201).json({ success: true, data: bom });
};

export const updateBillOfMaterials = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.bomId)) throw fail('Bill of materials not found.', 404);
  const input = await validateBom(req.body || {});
  const bom = await BillOfMaterials.findByIdAndUpdate(req.params.bomId, { $set: { ...input, updatedBy: req.user.id } }, { new: true, runValidators: true });
  if (!bom) throw fail('Bill of materials not found.', 404);
  res.json({ success: true, data: bom });
};

export const listProductionOrders = async (req, res) => {
  const filter = {};
  if (req.query.outletId && mongoose.isValidObjectId(req.query.outletId)) filter.outlet = req.query.outletId;
  const orders = await ProductionOrder.find(filter).sort({ createdAt: -1 }).limit(100)
    .populate('outlet', 'name code')
    .populate({ path: 'finishedVariant', select: 'title sku options', populate: { path: 'product', select: 'title' } })
    .populate('billOfMaterials', 'name batchSize').populate('materialUsage.product', 'name sku unit').lean();
  res.json({ success: true, data: orders });
};

export const releaseProductionOrder = async (req, res) => {
  const billOfMaterialsId = String(req.body?.billOfMaterials || '').trim();
  const outletId = String(req.body?.outlet || '').trim();
  const plannedQuantity = Number(req.body?.plannedQuantity);
  if (!mongoose.isValidObjectId(billOfMaterialsId) || !mongoose.isValidObjectId(outletId) || !Number.isInteger(plannedQuantity) || plannedQuantity < 1 || plannedQuantity > 100000) throw fail('Choose a bill of materials, outlet, and whole planned quantity.');
  const bom = await BillOfMaterials.findOne({ _id: billOfMaterialsId, isActive: true }).populate('materials.product', 'name sku unit currentPrice').lean();
  if (!bom) throw fail('Active bill of materials not found.', 404);
  const outlet = await Outlet.findOne({ _id: outletId, isActive: { $ne: false } }).lean();
  if (!outlet) throw fail('Active production outlet not found.', 404);
  const finishedVariant = await RetailVariant.findOne({ _id: bom.finishedVariant, isActive: true, tracked: true }).lean();
  if (!finishedVariant) throw fail('Finished variant is unavailable or not stock-tracked.', 409);
  const location = finishedVariant.inventoryByLocation.find((entry) => String(entry.outlet || '') === outletId);
  const isShopifyVariant = Boolean(finishedVariant.shopifyVariantId);
  if (!location) throw fail('Add this finished variant to the selected outlet before producing it.', 409);
  if (isShopifyVariant && !location.shopifyLocationId) throw fail('Map a Shopify location to this outlet before producing Shopify-linked finished goods.', 409);
  if (Number(bom.standardLaborCost || 0) > 0 || Number(bom.standardOverheadCost || 0) > 0) throw fail('This copy is using material-only production costing. Confirm the labor and overhead allocation accounts before adding those costs to a BOM.', 409);

  const requirements = new Map();
  for (const line of bom.materials) {
    const id = String(line.product?._id || line.product);
    const qty = round4(Number(line.quantity) * plannedQuantity / Number(bom.batchSize || 1));
    const current = requirements.get(id);
    if (current) current.quantity = round4(current.quantity + qty);
    else requirements.set(id, { product: line.product, quantity: qty, unit: line.unit });
  }
  const mongoSession = await getTenantConnection().startSession();
  let order;
  try {
    await mongoSession.withTransaction(async () => {
      const usage = [];
      const movements = [];
      for (const need of requirements.values()) {
        const product = need.product;
        const stock = await StockItem.findOne({ product: product._id, outlet: outlet._id, area: 'store' }).session(mongoSession);
        if (!stock || Number(stock.qtyOnHand || 0) < need.quantity) throw fail(`Not enough ${product.name} in Store. Need ${need.quantity} ${need.unit}; available ${stock?.qtyOnHand || 0}.`, 409);
        const updated = await StockItem.updateOne({ _id: stock._id, qtyOnHand: { $gte: need.quantity } }, { $inc: { qtyOnHand: -need.quantity } }, { session: mongoSession });
        if (!updated.modifiedCount) throw fail(`Store stock changed while releasing ${product.name}. Refresh and try again.`, 409);
        const unitCost = Number(product.currentPrice || 0);
        usage.push({ product: product._id, quantity: need.quantity, unit: need.unit, unitCost, totalCost: round2(unitCost * need.quantity) });
      }
      const [created] = await ProductionOrder.create([{
        orderNumber: orderNumber(),
        billOfMaterials: bom._id,
        finishedVariant: finishedVariant._id,
        outlet: outlet._id,
        shopifyLocationId: location.shopifyLocationId || '',
        plannedQuantity,
        materialUsage: usage,
        totalProductionCost: round2(usage.reduce((sum, line) => sum + line.totalCost, 0)),
        status: 'released',
        notes: String(req.body?.notes || '').trim().slice(0, 1000),
        releasedAt: new Date(),
        createdBy: req.user.id,
      }], { session: mongoSession });
      order = created;
      for (const line of usage) movements.push({
        product: line.product,
        outlet: outlet._id,
        area: 'store',
        qty: -line.quantity,
        unit: line.unit,
        type: 'production-out',
        unitCost: line.unitCost,
        value: -line.totalCost,
        ref: { kind: 'productionOrder', id: order._id },
        note: `Issued to ${order.orderNumber}`,
        user: req.user.id,
      });
      if (movements.length) await StockMovement.insertMany(movements, { session: mongoSession, ordered: true });
    });
  } finally { await mongoSession.endSession(); }
  const fullOrder = await ProductionOrder.findById(order._id).populate('outlet', 'name code')
    .populate({ path: 'finishedVariant', select: 'title sku', populate: { path: 'product', select: 'title' } })
    .populate('materialUsage.product', 'name sku unit').lean();
  res.status(201).json({ success: true, data: fullOrder });
};

export const completeProductionOrder = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) throw fail('Production order not found.', 404);
  const producedQuantity = Number(req.body?.producedQuantity);
  const rejectedQuantity = Number(req.body?.rejectedQuantity || 0);
  const laborCost = round2(Number(req.body?.laborCost || 0));
  const overheadCost = round2(Number(req.body?.overheadCost || 0));
  if (!Number.isInteger(producedQuantity) || producedQuantity < 1 || !Number.isInteger(rejectedQuantity) || rejectedQuantity < 0) throw fail('Enter whole produced and rejected quantities. At least one good item is required.');
  if (laborCost > 0 || overheadCost > 0) throw fail('This copy is using material-only production costing. Confirm labor and overhead allocation accounts before recording these costs.', 409);
  const mongoSession = await getTenantConnection().startSession();
  let order;
  try {
    await mongoSession.withTransaction(async () => {
      order = await ProductionOrder.findOne({ _id: req.params.orderId, status: 'released' }).session(mongoSession);
      if (!order) throw fail('Only a released production order can be completed.', 409);
      if (producedQuantity + rejectedQuantity !== Number(order.plannedQuantity)) throw fail('Produced plus rejected quantity must equal the planned batch quantity.', 422);
      const variant = await RetailVariant.findOne({ _id: order.finishedVariant, tracked: true, isActive: true }).session(mongoSession);
      if (!variant) throw fail('Finished product variant is no longer available.', 409);
      const stockIndex = variant.inventoryByLocation.findIndex((entry) => entry.shopifyLocationId === order.shopifyLocationId && String(entry.outlet || '') === String(order.outlet));
      if (stockIndex < 0) throw fail('The outlet stock mapping changed. Restore it before completing production.', 409);
      const materialCost = round2((order.materialUsage || []).reduce((sum, line) => sum + Number(line.totalCost || 0), 0));
      const batchUnitCost = round2(materialCost / producedQuantity);
      const oldQty = (variant.inventoryByLocation || []).reduce((sum, stock) => sum + Number(stock.onHand ?? stock.available ?? 0), 0);
      const previousCost = Number(variant.unitCost || 0);
      const newQty = oldQty + producedQuantity;
      variant.unitCost = newQty > 0 ? round2(((oldQty * previousCost) + (producedQuantity * batchUnitCost)) / newQty) : batchUnitCost;
      variant.unitCostSource = 'production';
      // The current batch value includes raw materials only. Keep it provisional
      // until the client confirms labor, overhead, and valuation policy.
      variant.unitCostStatus = 'review';
      const stock = variant.inventoryByLocation[stockIndex];
      stock.available = Number(stock.available || 0) + producedQuantity;
      stock.onHand = Number(stock.onHand || 0) + producedQuantity;
      stock.updatedAt = new Date();
      await variant.save({ session: mongoSession });
      await RetailInventoryMovement.create([{
        variant: variant._id,
        outlet: order.outlet,
        shopifyLocationId: order.shopifyLocationId,
        quantityDelta: producedQuantity,
        unitCost: batchUnitCost,
        type: 'production-receipt',
        referenceType: 'production-order',
        referenceId: String(order._id),
        idempotencyKey: crypto.createHash('sha256').update(`production:${order._id}:${variant._id}`).digest('hex'),
        syncStatus: variant.shopifyVariantId ? 'pending' : 'not-required',
        createdBy: req.user.id,
        occurredAt: new Date(),
      }], { session: mongoSession });
      order.producedQuantity = producedQuantity;
      order.rejectedQuantity = rejectedQuantity;
      order.laborCost = 0;
      order.overheadCost = 0;
      order.totalProductionCost = materialCost;
      order.unitCost = batchUnitCost;
      order.costingStatus = 'review';
      order.status = 'completed';
      order.completedAt = new Date();
      order.completedBy = req.user.id;
      await order.save({ session: mongoSession });
    });
  } finally { await mongoSession.endSession(); }
  const fullOrder = await ProductionOrder.findById(order._id).populate('outlet', 'name code')
    .populate({ path: 'finishedVariant', select: 'title sku', populate: { path: 'product', select: 'title' } })
    .populate('materialUsage.product', 'name sku unit').lean();
  res.json({ success: true, data: fullOrder });
};
