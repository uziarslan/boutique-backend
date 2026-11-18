import mongoose from 'mongoose';
import MenuCategory from '../models/MenuCategory.js';
import MenuItem from '../models/MenuItem.js';
import Outlet from '../models/Outlet.js';
import Table from '../models/Table.js';
import SaleTransaction from '../models/SaleTransaction.js';
import PrintStationConfig from '../models/PrintStationConfig.js';
import PrintJob from '../models/PrintJob.js';
import Customer from '../models/Customer.js';
import { effectiveTaxRate, getTaxConfig, serviceChargeAppliesTo } from '../services/tax.service.js';
import { priceLines } from '../utils/chargeInclusivePricing.js';
import { getIo } from '../utils/socket.js';
import logger from '../utils/logger.js';
import { notifyPrintStation } from '../utils/printClaimCoordinator.js';
import { getBusinessDate } from '../utils/businessDate.js';
import {
  expandDealItemsForKitchen,
  isDealCurrentlyAvailable,
  loadDealComponentMap,
  resolveDeal,
} from '../services/deal.service.js';

const round2 = (value) => Number((Number(value) || 0).toFixed(2));
const TABLET_ORDER_TYPES = new Set(['dine-in', 'takeaway', 'delivery', 'foodpanda']);
const ORDER_TYPE_LABELS = {
  'dine-in': 'DINE-IN',
  takeaway: 'TAKEAWAY',
  delivery: 'DELIVERY',
  foodpanda: 'FOODPANDA',
};
const center = (value, width = 42) => {
  const text = String(value || '');
  return `${' '.repeat(Math.max(0, Math.floor((width - text.length) / 2)))}${text}`;
};
const tabletOutlet = async (req) => {
  if (!mongoose.isValidObjectId(req.restaurantDevice?.outletId)) return null;
  return Outlet.findOne({
    _id: req.restaurantDevice.outletId,
    isActive: { $ne: false },
  }).select('_id name code timezone businessDayStart businessDayEnd').lean();
};

export const buildTabletKotText = ({ order, outlet, route, items, customer = null }) => {
  const orderType = TABLET_ORDER_TYPES.has(order.orderType) ? order.orderType : 'dine-in';
  const orderContext = orderType === 'dine-in'
    ? [`DINE-IN  TABLE ${order.tableNumber || '-'}`]
    : [ORDER_TYPE_LABELS[orderType]];
  if (orderType === 'delivery' && order.deliveryAddress) {
    if (customer?.name) orderContext.push(`CUSTOMER: ${customer.name}`);
    if (customer?.phone) orderContext.push(`MOBILE: ${customer.phone}`);
    const address = [
      order.deliveryAddress.label,
      order.deliveryAddress.street,
      order.deliveryAddress.area,
      order.deliveryAddress.city,
    ].filter(Boolean).join(', ');
    if (address) orderContext.push(`DELIVER TO: ${address}`);
  }
  if (orderType === 'foodpanda') {
    orderContext.push(`FOODPANDA #: ${order.foodPandaOrderNumber || '-'}`);
    if (order.foodPandaCustomerName) {
      orderContext.push(`CUSTOMER: ${order.foodPandaCustomerName}`);
    }
  }
  const lines = [
    center(route.role === 'dispatch' ? '*** DISPATCH COPY ***' : '*** KITCHEN COPY ***'),
    center(route.displayName || route.printerName),
    center(outlet.name || ''),
    '='.repeat(42),
    ...orderContext,
    `ORDER: ${order.transactionNumber}`,
    `WAITER: ${order.staffOrder?.waiterName || order.staffOrder?.deviceLabel || '-'}`,
    `TIME: ${new Date(order.createdAt || Date.now()).toLocaleString('en-PK', {
      timeZone: outlet.timezone || 'Asia/Karachi',
      hour12: true,
    })}`,
    '-'.repeat(42),
  ];
  for (const item of items) {
    lines.push(`${item.qty}x  ${item.name}${item.variation?.name ? ` (${item.variation.name})` : ''}`);
    if (item.notes) lines.push(`    > ${item.notes}`);
  }
  lines.push('-'.repeat(42));
  lines.push(`TOTAL ITEMS: ${items.reduce((sum, item) => sum + Number(item.qty || 0), 0)}`);
  if (order.notes) lines.push('', 'ORDER NOTE:', order.notes);
  lines.push('='.repeat(42), center('END OF TICKET'));
  return lines.join('\r\n');
};

export const getItemsForPrinterRoute = (route, items) => {
  if (route.role === 'dispatch' || route.allCategories === true) return items;
  const allowed = new Set((route.categoryIds || []).map(String));
  return items.filter((item) => allowed.has(String(item.categoryId)));
};

export const getTabletPrintStationFilter = (device, outletId) => ({
  outlet: outletId,
  ...(device?.printStationId && { stationId: String(device.printStationId) }),
  'printers.enabled': true,
});

export const calculateTabletOrderCharges = ({
  items,
  orderType,
  taxConfig,
  deliveryChargeAmount = 0,
}) => {
  const taxRate = orderType === 'foodpanda' ? 0 : effectiveTaxRate(taxConfig, 0);
  const serviceRate = serviceChargeAppliesTo(taxConfig, orderType)
    ? Number(taxConfig.serviceChargeRate || 0)
    : 0;
  const pricing = priceLines(items, { taxRate, serviceChargeRate: serviceRate });
  return {
    items: pricing.items,
    subtotal: pricing.subtotal,
    taxAmount: pricing.taxAmount,
    effectiveTaxRate: taxRate,
    serviceChargeRate: serviceRate,
    serviceChargeAmount: pricing.serviceChargeAmount,
    deliveryChargeAmount: round2(deliveryChargeAmount),
    totalAmount: round2(
      pricing.subtotal + pricing.taxAmount + pricing.serviceChargeAmount + Number(deliveryChargeAmount || 0)
    ),
  };
};

export const verifyOrderTablet = async (req, res) => {
  const outlet = await tabletOutlet(req);
  if (!outlet) return res.status(409).json({ success: false, message: 'The device outlet is unavailable.' });
  const configuredStations = await PrintStationConfig.countDocuments(
    getTabletPrintStationFilter(req.restaurantDevice, outlet._id),
  );
  return res.json({
    success: true,
    device: req.restaurantDevice,
    outlet,
    printStationReady: configuredStations > 0,
  });
};

export const getTabletMenu = async (req, res) => {
  const outlet = await tabletOutlet(req);
  if (!outlet) return res.status(409).json({ success: false, message: 'The device outlet is unavailable.' });
  const [categories, items, tables, taxConfig] = await Promise.all([
    MenuCategory.find({ outlet: outlet._id, isActive: true })
      .select('name color sortOrder')
      .sort({ sortOrder: 1, name: 1 })
      .lean(),
    MenuItem.find({ outlet: outlet._id, isAvailable: true })
      .populate('dealConfig.fixedItems.menuItem', 'name itemType isAvailable category variations._id variations.name variations.price variations.foodPandaPrice variations.sortOrder')
      .populate('dealConfig.choiceGroups.options.menuItem', 'name itemType isAvailable category variations._id variations.name variations.price variations.foodPandaPrice variations.sortOrder')
      .select('name itemType dealConfig description imageUrl price foodPandaPrice priceMode taxRate category variations sortOrder')
      .sort({ sortOrder: 1, name: 1 })
      .lean(),
    Table.find({ outlet: outlet._id, isActive: true })
      .select('label code capacity')
      .sort({ label: 1 })
      .lean(),
    getTaxConfig(outlet._id),
  ]);
  const byCategory = new Map();
  for (const item of items) {
    if (!isDealCurrentlyAvailable(item)) continue;
    const key = String(item.category);
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push({
      _id: item._id,
      name: item.name,
      description: item.description || '',
      imageUrl: item.imageUrl || '',
      price: item.price,
      foodPandaPrice: item.foodPandaPrice,
      priceMode: item.priceMode || 'exclusive',
      taxRate: item.taxRate,
      itemType: item.itemType || 'regular',
      dealConfig: item.itemType === 'deal' ? item.dealConfig : undefined,
      variations: (item.variations || []).map((variation) => ({
        _id: variation._id,
        name: variation.name,
        price: variation.price,
        foodPandaPrice: variation.foodPandaPrice,
      })),
    });
  }
  return res.json({
    success: true,
    outlet,
    tables,
    taxConfig,
    categories: categories.map((category) => ({
      ...category,
      items: byCategory.get(String(category._id)) || [],
    })),
  });
};

export const createTabletOrder = async (req, res) => {
  const outlet = await tabletOutlet(req);
  if (!outlet) return res.status(409).json({ success: false, message: 'The device outlet is unavailable.' });
  const clientTransactionId = String(req.body?.clientTransactionId || '').trim();
  if (!clientTransactionId || clientTransactionId.length > 100) {
    return res.status(422).json({ success: false, message: 'A valid client order ID is required.' });
  }
  const existing = await SaleTransaction.findOne({
    clientTransactionId,
    source: 'staff-tablet',
    'staffOrder.deviceId': req.restaurantDevice.id,
  }).lean();
  if (existing) {
    const jobs = await PrintJob.find({ order: existing._id }).select('status lastError printerName').lean();
    return res.json({ success: true, duplicate: true, data: { order: existing, jobs } });
  }
  const requestedOrderType = String(req.body?.orderType || 'dine-in').trim().toLowerCase();
  if (!TABLET_ORDER_TYPES.has(requestedOrderType)) {
    return res.status(422).json({ success: false, message: 'Select a valid order type.' });
  }
  const orderType = requestedOrderType;
  const tableNumber = String(req.body?.tableNumber || '').trim().slice(0, 20);
  if (orderType === 'dine-in' && !tableNumber) {
    return res.status(422).json({ success: false, message: 'Enter the table number or name.' });
  }
  const rawDeliveryAddress = req.body?.deliveryAddress;
  const deliveryAddress = orderType === 'delivery'
    ? {
        label: String(rawDeliveryAddress?.label || '').trim().slice(0, 100),
        street: String(
          typeof rawDeliveryAddress === 'string'
            ? rawDeliveryAddress
            : rawDeliveryAddress?.street || ''
        ).trim().slice(0, 300),
        area: String(rawDeliveryAddress?.area || '').trim().slice(0, 200),
        city: String(rawDeliveryAddress?.city || '').trim().slice(0, 100),
      }
    : undefined;
  if (
    orderType === 'delivery'
    && ![
      deliveryAddress.label,
      deliveryAddress.street,
      deliveryAddress.area,
      deliveryAddress.city,
    ].some(Boolean)
  ) {
    return res.status(422).json({ success: false, message: 'Enter the delivery address.' });
  }
  const deliveryChargeAmount = orderType === 'delivery'
    ? round2(Math.max(0, Number(req.body?.deliveryChargeAmount) || 0))
    : 0;
  const foodPandaOrderNumber = orderType === 'foodpanda'
    ? String(req.body?.foodPandaOrderNumber || '').trim().slice(0, 100)
    : '';
  const foodPandaCustomerName = orderType === 'foodpanda'
    ? String(req.body?.foodPandaCustomerName || '').trim().slice(0, 150)
    : '';
  if (orderType === 'foodpanda' && !foodPandaOrderNumber) {
    return res.status(422).json({ success: false, message: 'Enter the Foodpanda order number.' });
  }
  const requestedCustomerId = String(req.body?.customerId || '').trim();
  let customer = null;
  if (requestedCustomerId) {
    if (!mongoose.isValidObjectId(requestedCustomerId)) {
      return res.status(422).json({ success: false, message: 'Select a valid customer.' });
    }
    customer = await Customer.findById(requestedCustomerId)
      .select('_id name phone addresses')
      .lean();
    if (!customer) {
      return res.status(422).json({ success: false, message: 'The selected customer is unavailable.' });
    }
  }
  const rawItems = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
  if (!rawItems.length) return res.status(422).json({ success: false, message: 'Add at least one item.' });
  const menuIds = rawItems.map((item) => item.menuItemId).filter((id) => mongoose.isValidObjectId(id));
  const menuItems = await MenuItem.find({
    _id: { $in: menuIds },
    outlet: outlet._id,
    isAvailable: true,
  }).lean();
  const menuById = new Map(menuItems.map((item) => [String(item._id), item]));
  const dealComponentMap = await loadDealComponentMap(menuItems);
  const items = [];
  for (const raw of rawItems) {
    const menuItem = menuById.get(String(raw.menuItemId));
    if (!menuItem) return res.status(422).json({ success: false, message: 'One or more menu items are unavailable.' });
    const qty = Math.max(1, Math.min(99, Math.floor(Number(raw.qty) || 1)));
    let unitPrice = Number(
      orderType === 'foodpanda' && menuItem.foodPandaPrice != null
        ? menuItem.foodPandaPrice
        : menuItem.price
    ) || 0;
    let variation;
    if ((menuItem.variations || []).length) {
      const selected = menuItem.variations.find((row) => String(row._id) === String(raw.variationId || ''));
      if (!selected) return res.status(422).json({ success: false, message: `Choose a size for ${menuItem.name}.` });
      unitPrice = Number(
        orderType === 'foodpanda' && selected.foodPandaPrice != null
          ? selected.foodPandaPrice
          : selected.price
      ) || 0;
      variation = { id: selected._id, name: selected.name };
    }
    const resolvedDeal = resolveDeal(menuItem, raw.dealSelections, dealComponentMap);
    unitPrice = round2(unitPrice + resolvedDeal.priceAdjustment);
    const lineTotal = round2(unitPrice * qty);
    items.push({
      menuItem: menuItem._id,
      categoryId: menuItem.category,
      name: menuItem.name,
      variation,
      qty,
      listedUnitPrice: unitPrice,
      priceMode: menuItem.priceMode || 'exclusive',
      unitPrice,
      lineTotal,
      taxable: Number(menuItem.taxRate || 0) > 0,
      notes: String(raw.notes || '').trim().slice(0, 300),
      dealSelections: resolvedDeal.dealSelections,
      dealComponents: resolvedDeal.dealComponents.map((component) => ({
        source: component.source,
        groupId: component.groupId,
        groupName: component.groupName,
        optionId: component.optionId,
        menuItem: component.menuItem,
        categoryId: component.categoryId,
        categoryName: component.categoryName,
        variation: component.variation,
        name: component.name,
        qtyPerDeal: component.qtyPerDeal,
        priceAdjustment: component.priceAdjustment,
      })),
    });
  }

  let stationConfigQuery = PrintStationConfig.find(
    getTabletPrintStationFilter(req.restaurantDevice, outlet._id),
  );
  // Legacy tablets created before explicit station assignment should keep
  // using the original station, never fan out one order to every computer.
  if (!req.restaurantDevice.printStationId) {
    stationConfigQuery = stationConfigQuery.sort({ createdAt: 1 }).limit(1);
  }
  const stationConfigs = await stationConfigQuery.lean();
  if (!stationConfigs.length) {
    return res.status(409).json({
      success: false,
      code: 'PRINT_STATION_NOT_CONFIGURED',
      message: 'No active reception print station is configured for this outlet.',
    });
  }

  const taxConfig = await getTaxConfig(outlet._id);
  const charges = calculateTabletOrderCharges({
    items,
    orderType,
    taxConfig,
    deliveryChargeAmount,
  });
  const pricedItems = charges.items.map((item) => {
    const pricedItem = { ...item };
    pricedItem.taxRate = pricedItem.taxable ? charges.effectiveTaxRate : 0;
    pricedItem.serviceChargeRate = charges.serviceChargeRate;
    pricedItem.discountAmount = 0;
    delete pricedItem.taxable;
    return pricedItem;
  });

  let order;
  try {
    order = await SaleTransaction.create({
      outlet: outlet._id,
      businessDate: getBusinessDate(
        new Date(),
        outlet.timezone,
        outlet.businessDayStart,
        outlet.businessDayEnd,
      ),
      session: null,
      cashier: null,
      items: pricedItems,
      subtotal: charges.subtotal,
      taxAmount: charges.taxAmount,
      effectiveTaxRate: charges.effectiveTaxRate,
      serviceChargeAmount: charges.serviceChargeAmount,
      deliveryChargeAmount: charges.deliveryChargeAmount,
      discountAmount: 0,
      totalAmount: charges.totalAmount,
      paymentMethod: 'cash',
      cashAmount: 0,
      cardAmount: 0,
      status: 'held',
      heldAt: new Date(),
      kitchenPrintQueuedAt: new Date(),
      source: 'staff-tablet',
      syncedToManagement: false,
      isRefund: false,
      orderType,
      customer: customer?._id || null,
      tableNumber: orderType === 'dine-in' ? tableNumber : '',
      deliveryAddress,
      foodPandaOrderNumber: foodPandaOrderNumber || null,
      foodPandaCustomerName: foodPandaCustomerName || null,
      notes: String(req.body?.notes || '').trim().slice(0, 500),
      clientTransactionId,
      staffOrder: {
        deviceId: req.restaurantDevice.id,
        deviceLabel: req.restaurantDevice.label,
        waiterName: String(req.body?.waiterName || '').trim().slice(0, 100),
        submittedAt: new Date(),
      },
    });
    const printRows = [];
    const kitchenItems = expandDealItemsForKitchen(items);
    for (const config of stationConfigs) {
      for (const route of (config.printers || []).filter((printer) => printer.enabled !== false)) {
        const routedItems = getItemsForPrinterRoute(route, kitchenItems);
        if (!routedItems.length) continue;
        printRows.push({
          jobKey: `${order._id}:initial:${config.stationId}:${route._id}`,
          stationId: config.stationId,
          outlet: outlet._id,
          order: order._id,
          submittedByDeviceId: req.restaurantDevice.id,
          printerName: route.printerName,
          jobName: `Cenciss KOT - ${order.transactionNumber}`,
          text: buildTabletKotText({ order, outlet, route, items: routedItems, customer }),
          copies: route.copies || 1,
        });
      }
    }
    if (!printRows.length) throw Object.assign(new Error('No configured printer route matched this order.'), { statusCode: 409 });
    const jobs = await PrintJob.insertMany(printRows);
    for (const stationId of new Set(printRows.map((row) => String(row.stationId)))) {
      notifyPrintStation(stationId);
    }

    const io = getIo();
    if (io) {
      io.to(`orders:${req.tenantSlug}:${String(outlet._id)}`).emit('tablet-order:new', {
        orderId: order._id,
        orderNumber: order.transactionNumber,
        orderType: order.orderType,
        tableNumber: order.tableNumber,
        waiterName: order.staffOrder?.waiterName || '',
        deviceLabel: order.staffOrder?.deviceLabel || '',
        totalAmount: order.totalAmount,
      });
    }
    logger.info(`Tablet order queued: ${order.transactionNumber} outlet=${outlet.code} device=${req.restaurantDevice.id} jobs=${jobs.length}`);
    return res.status(201).json({ success: true, data: { order, jobs } });
  } catch (error) {
    if (order?._id) {
      await PrintJob.deleteMany({ order: order._id }).catch(() => {});
      await SaleTransaction.deleteOne({ _id: order._id }).catch(() => {});
    }
    if (error?.code === 11000) {
      const duplicate = await SaleTransaction.findOne({
        clientTransactionId,
        source: 'staff-tablet',
        'staffOrder.deviceId': req.restaurantDevice.id,
      }).lean();
      if (duplicate) {
        const jobs = await PrintJob.find({ order: duplicate._id }).lean();
        return res.json({ success: true, duplicate: true, data: { order: duplicate, jobs } });
      }
      return res.status(409).json({
        success: false,
        message: 'That client order ID is already in use. Send the order again with a new ID.',
      });
    }
    throw error;
  }
};

export const listTabletOrders = async (req, res) => {
  const outlet = await tabletOutlet(req);
  if (!outlet) return res.status(409).json({ success: false, message: 'The device outlet is unavailable.' });
  const orders = await SaleTransaction.find({
    outlet: outlet._id,
    source: 'staff-tablet',
    'staffOrder.deviceId': req.restaurantDevice.id,
  })
    .populate('customer', 'name phone addresses')
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();
  const orderIds = orders.map((order) => order._id);
  const jobs = await PrintJob.find({ order: { $in: orderIds } }).select('order status lastError printerName printedAt').lean();
  const byOrder = new Map();
  for (const job of jobs) {
    const key = String(job.order);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(job);
  }
  return res.json({
    success: true,
    data: orders.map((order) => ({ ...order, printJobs: byOrder.get(String(order._id)) || [] })),
  });
};

export const getTabletOrderStatus = async (req, res) => {
  const order = await SaleTransaction.findOne({
    _id: req.params.id,
    outlet: req.restaurantDevice.outletId,
    source: 'staff-tablet',
    'staffOrder.deviceId': req.restaurantDevice.id,
  })
    .populate('customer', 'name phone addresses')
    .lean();
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  const jobs = await PrintJob.find({ order: order._id }).select('status lastError printerName printedAt').lean();
  const status = jobs.length && jobs.every((job) => job.status === 'printed')
    ? 'printed'
    : jobs.some((job) => job.status === 'failed')
      ? 'failed'
      : jobs.some((job) => job.status === 'claimed')
        ? 'sending'
        : 'queued';
  return res.json({ success: true, data: { order, jobs, printStatus: status } });
};
