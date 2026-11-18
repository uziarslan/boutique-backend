#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { connectPlatform, getPlatformConnection, getTenantConnectionFor } from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';

const VERSION = 'unified-purchases-v1';
const args = new Set(process.argv.slice(2));
const argValue = (name) => {
  const prefix = `${name}=`;
  const hit = [...args].find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};
const mode = args.has('--cleanup') ? 'cleanup' : args.has('--apply') ? 'apply' : 'dry-run';
const onlyTenant = argValue('--tenant');
const reportPath = argValue('--report');
const sid = (value) => value?.toString?.() || String(value || '');
const oid = (value) => (value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null);
const r2 = (value) => Number((Number(value) || 0).toFixed(2));
const sum = (rows, key) => r2(rows.reduce((total, row) => total + Number(row?.[key] || 0), 0));
const exists = async (conn, name) => (await conn.db.listCollections({ name }).toArray()).length > 0;
const docs = async (conn, name) => ((await exists(conn, name)) ? conn.collection(name).find({}).toArray() : []);
const cleanRef = (value) => String(value || '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '');
const sourceRef = (prefix, value) => {
  const cleaned = cleanRef(value);
  return cleaned.toUpperCase().startsWith(`${prefix}-`) ? cleaned : `${prefix}-${cleaned}`;
};
const lineName = (line, productNames) =>
  line.productName || productNames.get(sid(line.product)) || line.description || 'Item';
const numberText = (value) => Number.isInteger(Number(value))
  ? Number(value).toLocaleString('en-US')
  : Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
const summarize = (lines, productNames, limit = 2) => {
  const meaningful = lines.filter((line) => Number(line.qty) > 0);
  if (!meaningful.length) return 'Legacy purchase record';
  const shown = meaningful.slice(0, limit).map((line) => {
    const units = Number(line.qty) * Math.max(1, Number(line.packSize) || 1);
    return `${lineName(line, productNames)} ${numberText(units)}${line.unit ? ` ${line.unit}` : ''}`;
  });
  return `${shown.join(', ')}${meaningful.length > limit ? ` +${meaningful.length - limit} more` : ''}`;
};

const statusFromInvoice = (invoice) => ({
  draft: 'draft',
  pendingApproval: 'pendingApproval',
  approved: 'open',
  overdue: 'open',
  partiallyPaid: 'partiallyPaid',
  paid: 'paid',
  disputed: 'disputed',
}[invoice?.status] || 'migrationReview');

const normalizeLines = ({ invoice, grn, po, productNames }) => {
  const source = invoice?.lines?.length ? 'invoice' : grn?.lines?.length ? 'grn' : 'po';
  const raw = source === 'invoice' ? invoice.lines : source === 'grn' ? grn.lines : (po?.lines || []);
  const lines = raw.map((line) => {
    const qty = source === 'grn' ? Number(line.receivedQty || 0) : Number(line.qty || 0);
    const packSize = source === 'po' ? 1 : Math.max(1, Number(line.packSize) || 1);
    const unitPrice = Number(line.unitPrice) || 0;
    const gross = qty * unitPrice;
    const lineDiscount = source === 'po' ? Number(line.lineDiscount || 0) + Number(line.promoShare || 0) : 0;
    return {
      _id: line._id || new mongoose.Types.ObjectId(),
      product: oid(line.product),
      productName: lineName(line, productNames),
      description: line.description || lineName(line, productNames),
      qty,
      entryMode: packSize > 1 ? 'pack' : 'loose',
      packSize,
      unit: line.unit || '',
      unitPrice,
      lineDiscount: r2(lineDiscount),
      lineTotal: r2(line.lineTotal ?? Math.max(0, gross - lineDiscount)),
      notes: line.notes || undefined,
    };
  }).filter((line) => line.qty > 0);
  if (lines.length) return lines;
  const value = Number(invoice?.totalAmount ?? grn?.totalReceived ?? po?.totalAmount) || 0;
  return [{
    _id: new mongoose.Types.ObjectId(),
    product: null,
    productName: 'Legacy purchase record',
    description: 'Legacy purchase record',
    qty: 1,
    entryMode: 'loose',
    packSize: 1,
    unit: '',
    unitPrice: value,
    lineDiscount: 0,
    lineTotal: r2(value),
  }];
};

const buildPurchase = ({ id, invoice, grn, po, vendorNames, productNames, orphanPayment }) => {
  const lines = orphanPayment
    ? [{
      _id: new mongoose.Types.ObjectId(),
      product: null,
      productName: 'Legacy payment without bill',
      description: 'Legacy payment without bill',
      qty: 1,
      entryMode: 'loose',
      packSize: 1,
      unit: '',
      unitPrice: Number(orphanPayment.amount) || 0,
      lineDiscount: 0,
      lineTotal: r2(orphanPayment.amount),
    }]
    : normalizeLines({ invoice, grn, po, productNames });
  const missingProducts = lines.filter((line) => !line.product && !orphanPayment).length;
  const reasons = [];
  if (missingProducts) reasons.push(`${missingProducts} line(s) have no product link`);
  if (grn?.status === 'confirmed' && !invoice) reasons.push('Confirmed receipt had no linked invoice');
  if (po && !grn && !invoice && !['draft', 'cancelled'].includes(po.status)) reasons.push('PO had no receipt');
  if (orphanPayment) reasons.push('Payment had no valid linked invoice');
  if (invoice?.status === 'disputed') reasons.push(`Legacy dispute: ${invoice.disputeReason || 'reason not recorded'}`);

  const legacyRef = invoice
    ? sourceRef('INV', invoice.internalRef || sid(invoice._id).slice(-8))
    : grn
      ? sourceRef('GRN', grn.grnNumber || sid(grn._id).slice(-8))
      : po
        ? sourceRef('PO', po.poNumber || sid(po._id).slice(-8))
        : sourceRef('PAY', sid(orphanPayment?._id).slice(-8));
  const vendor = oid(invoice?.vendor || grn?.vendor || po?.vendor || orphanPayment?.vendor);
  const subtotal = r2(invoice?.subtotal ?? grn?.totalReceived ?? po?.totalAmount ?? orphanPayment?.amount);
  const taxRate = Number(invoice?.taxRate || 0);
  const taxAmount = r2(invoice?.taxAmount || 0);
  const aitRate = Number(invoice?.aitRate ?? grn?.advanceTaxRate ?? po?.advanceTaxRate ?? 0);
  const aitAmount = r2(invoice?.aitAmount ?? (grn ? subtotal * aitRate / 100 : po?.advanceTaxAmount) ?? 0);
  const totalAmount = r2(invoice?.totalAmount ?? (subtotal + taxAmount + aitAmount));
  let status = invoice
    ? statusFromInvoice(invoice)
    : grn
      ? (grn.status === 'draft' ? 'draft' : 'migrationReview')
      : po
        ? (po.status === 'draft' ? 'draft' : po.status === 'cancelled' || po.isTemplate ? 'reversed' : 'migrationReview')
        : 'migrationReview';
  if (orphanPayment) status = 'migrationReview';
  const posted = invoice && ['approved', 'paid', 'partiallyPaid', 'overdue'].includes(invoice.status);
  const now = new Date();
  return {
    _id: oid(id),
    purchaseNumber: `PUR-${cleanRef(legacyRef)}`,
    type: orphanPayment ? 'expense' : 'stock',
    vendor,
    vendorName: vendorNames.get(sid(vendor)) || (orphanPayment ? 'Unknown legacy vendor' : undefined),
    vendorInvoiceNumber: invoice?.invoiceNumber || '',
    purchaseDate: invoice?.invoiceDate || grn?.purchaseDate || po?.createdAt || orphanPayment?.paymentDate || now,
    dueDate: invoice?.dueDate || null,
    outlet: oid(invoice?.outlet || grn?.outlet || po?.outlet),
    destination: invoice?.destination || grn?.destination || (orphanPayment ? 'none' : 'store'),
    lines,
    subtotal,
    discountAmount: 0,
    taxRate,
    taxAmount,
    aitRate,
    aitAmount,
    totalAmount,
    amountPaid: r2(invoice?.amountPaid ?? orphanPayment?.amount ?? 0),
    currency: invoice?.currency || 'PKR',
    itemSummary: summarize(lines, productNames),
    status,
    migrationReview: { required: reasons.length > 0 || status === 'migrationReview', reasons },
    attachmentUrl: invoice?.scannedFileUrl || grn?.scannedInvoiceUrl || undefined,
    ocrData: invoice?.ocrData || grn?.ocrRawData || undefined,
    notes: invoice?.notes || grn?.notes || po?.notes || orphanPayment?.notes || undefined,
    stockPostedAt: posted ? (invoice.approvedAt || grn?.confirmedAt || invoice.updatedAt || now) : null,
    postedAt: posted ? (invoice.approvedAt || grn?.confirmedAt || invoice.updatedAt || now) : null,
    postedBy: oid(invoice?.approvedBy || grn?.receivedBy),
    journalEntryId: oid(invoice?.journalEntryId),
    reversedAt: status === 'reversed' ? (po?.cancelledAt || po?.updatedAt || now) : null,
    reversalReason: status === 'reversed' ? (po?.cancelReason || (po?.isTemplate ? 'Legacy template preserved during migration' : 'Legacy purchase cancelled')) : undefined,
    legacy: {
      purchaseOrderId: oid(po?._id),
      purchaseOrderNumber: po?.poNumber,
      purchaseOrderSnapshot: po || undefined,
      grnId: oid(grn?._id),
      grnNumber: grn?.grnNumber,
      grnSnapshot: grn || undefined,
      invoiceId: oid(invoice?._id),
      invoiceRef: invoice?.internalRef,
      invoiceSnapshot: invoice || undefined,
      migratedAt: now,
      migrationVersion: VERSION,
      orphanPaymentSnapshot: orphanPayment || undefined,
    },
    createdBy: oid(invoice?.createdBy || grn?.createdBy || po?.createdBy || orphanPayment?.recordedBy),
    createdAt: invoice?.createdAt || grn?.createdAt || po?.createdAt || orphanPayment?.createdAt || now,
    updatedAt: now,
  };
};

const collectControlTotals = async (conn) => {
  const [stockRows, journalRows] = await Promise.all([
    (await exists(conn, 'stockitems')) ? conn.collection('stockitems').aggregate([
      { $group: { _id: null, qty: { $sum: '$qtyOnHand' } } },
    ]).toArray() : [],
    (await exists(conn, 'journalentries')) ? conn.collection('journalentries').aggregate([
      { $unwind: '$lines' },
      { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]).toArray() : [],
  ]);
  return {
    stockQty: Number(stockRows[0]?.qty || 0),
    journalDebit: r2(journalRows[0]?.debit),
    journalCredit: r2(journalRows[0]?.credit),
  };
};

const prepareTenant = async (conn) => {
  const [
    purchaseOrders, grns, invoices, payments, products, vendors,
    stockMovements, journalEntries, auditLogs, users,
  ] = await Promise.all([
    docs(conn, 'purchaseorders'), docs(conn, 'goodsreceivednotes'), docs(conn, 'invoices'),
    docs(conn, 'payments'), docs(conn, 'products'), docs(conn, 'vendors'),
    docs(conn, 'stockmovements'), docs(conn, 'journalentries'), docs(conn, 'auditlogs'), docs(conn, 'users'),
  ]);
  const productNames = new Map(products.map((row) => [sid(row._id), row.name]));
  const vendorNames = new Map(vendors.map((row) => [sid(row._id), row.name]));
  const poById = new Map(purchaseOrders.map((row) => [sid(row._id), row]));
  const grnById = new Map(grns.map((row) => [sid(row._id), row]));
  const invoiceById = new Map(invoices.map((row) => [sid(row._id), row]));
  const invoiceByGrn = new Map(invoices.filter((row) => row.grn).map((row) => [sid(row.grn), row]));
  const purchases = new Map();
  const sourceMap = new Map();
  const mappingRows = [];
  const link = (type, sourceId, purchaseId) => {
    if (!sourceId) return;
    sourceMap.set(`${type}:${sid(sourceId)}`, oid(purchaseId));
    mappingRows.push({
      sourceType: type,
      sourceId: oid(sourceId),
      purchaseId: oid(purchaseId),
      migrationVersion: VERSION,
      migratedAt: new Date(),
    });
  };

  for (const invoice of invoices) {
    const grn = grnById.get(sid(invoice.grn));
    const po = poById.get(sid(invoice.purchaseOrder || grn?.purchaseOrder));
    const purchase = buildPurchase({ id: invoice._id, invoice, grn, po, vendorNames, productNames });
    purchases.set(sid(purchase._id), purchase);
    link('invoice', invoice._id, purchase._id);
    if (grn) link('grn', grn._id, purchase._id);
    if (po) link('purchaseOrder', po._id, purchase._id);
  }
  for (const grn of grns) {
    if (invoiceByGrn.has(sid(grn._id))) continue;
    const po = poById.get(sid(grn.purchaseOrder));
    const purchase = buildPurchase({ id: grn._id, grn, po, vendorNames, productNames });
    purchases.set(sid(purchase._id), purchase);
    link('grn', grn._id, purchase._id);
    if (po) link('purchaseOrder', po._id, purchase._id);
  }
  const mappedPoIds = new Set(mappingRows.filter((row) => row.sourceType === 'purchaseOrder').map((row) => sid(row.sourceId)));
  for (const po of purchaseOrders) {
    if (mappedPoIds.has(sid(po._id))) continue;
    const purchase = buildPurchase({ id: po._id, po, vendorNames, productNames });
    purchases.set(sid(purchase._id), purchase);
    link('purchaseOrder', po._id, purchase._id);
  }

  const paymentPurchase = new Map();
  for (const payment of payments) {
    let purchaseId = sourceMap.get(`invoice:${sid(payment.invoice)}`);
    if (!purchaseId) {
      const purchase = buildPurchase({
        id: payment._id,
        orphanPayment: payment,
        vendorNames,
        productNames,
      });
      purchases.set(sid(purchase._id), purchase);
      purchaseId = purchase._id;
      link('orphanPayment', payment._id, purchaseId);
    }
    paymentPurchase.set(sid(payment._id), purchaseId);
  }

  return {
    purchaseOrders, grns, invoices, payments, products, stockMovements,
    journalEntries, auditLogs, users, purchases: [...purchases.values()],
    sourceMap, paymentPurchase, mappingRows, productNames,
  };
};

const applyTenant = async (conn, data) => {
  if (data.purchases.length) {
    await conn.collection('purchases').bulkWrite(data.purchases.map((purchase) => ({
      updateOne: {
        filter: { _id: purchase._id },
        update: { $setOnInsert: purchase },
        upsert: true,
      },
    })), { ordered: false });
  }
  if (data.mappingRows.length) {
    await conn.collection('purchasemigrationmaps').bulkWrite(data.mappingRows.map((row) => ({
      updateOne: {
        filter: { sourceType: row.sourceType, sourceId: row.sourceId, purchaseId: row.purchaseId },
        update: { $set: row },
        upsert: true,
      },
    })), { ordered: false });
  }

  if (data.payments.length) {
    await conn.collection('payments').bulkWrite(data.payments.map((payment) => ({
      updateOne: {
        filter: { _id: payment._id },
        update: { $set: {
          purchase: data.paymentPurchase.get(sid(payment._id)),
          legacyInvoiceId: oid(payment.invoice),
          status: payment.status || 'posted',
          migrationVersion: VERSION,
        } },
      },
    })), { ordered: false });
  }

  const purchaseById = new Map(data.purchases.map((purchase) => [sid(purchase._id), purchase]));
  const journalOps = [];
  for (const entry of data.journalEntries) {
    let purchaseId = null;
    if (entry.sourceModule === 'invoice') purchaseId = data.sourceMap.get(`invoice:${sid(entry.sourceId)}`);
    if (['inventory', 'grn'].includes(entry.sourceModule)) {
      purchaseId = data.sourceMap.get(`grn:${sid(entry.sourceId)}`)
        || data.sourceMap.get(`invoice:${sid(entry.sourceId)}`);
    }
    if (entry.sourceModule === 'purchaseOrder') purchaseId = data.sourceMap.get(`purchaseOrder:${sid(entry.sourceId)}`);
    if (entry.sourceModule === 'payment') purchaseId = data.paymentPurchase.get(sid(entry.sourceId));
    if (!purchaseId) continue;
    const purchase = purchaseById.get(sid(purchaseId));
    const isPayment = entry.sourceModule === 'payment';
    const description = `${isPayment ? 'Payment: ' : ''}${purchase?.itemSummary || 'Legacy purchase record'}`;
    const set = {
      sourcePath: `/purchases/${purchaseId}`,
      sourceNumber: purchase?.purchaseNumber,
      itemSummary: purchase?.itemSummary,
      legacyDescription: entry.legacyDescription || entry.description,
      description,
      migrationVersion: VERSION,
    };
    if (!isPayment) {
      set.sourceModule = 'purchase';
      set.sourceId = purchaseId;
      set.partyVendor = purchase?.vendor || null;
      set.party = purchase?.vendor ? null : purchase?.vendorName;
    }
    journalOps.push({ updateOne: { filter: { _id: entry._id }, update: { $set: set } } });
  }
  if (journalOps.length) await conn.collection('journalentries').bulkWrite(journalOps, { ordered: false });

  const movementOps = [];
  for (const movement of data.stockMovements) {
    const kind = movement.ref?.kind;
    const sourceId = movement.ref?.id;
    const purchaseId = kind === 'invoice'
      ? data.sourceMap.get(`invoice:${sid(sourceId)}`)
      : kind === 'grn'
        ? data.sourceMap.get(`grn:${sid(sourceId)}`)
        : kind === 'purchaseOrder'
          ? data.sourceMap.get(`purchaseOrder:${sid(sourceId)}`)
          : null;
    if (!purchaseId) continue;
    movementOps.push({ updateOne: {
      filter: { _id: movement._id },
      update: { $set: { 'ref.kind': 'purchase', 'ref.id': purchaseId, migrationVersion: VERSION } },
    } });
  }
  if (movementOps.length) await conn.collection('stockmovements').bulkWrite(movementOps, { ordered: false });

  const productOps = [];
  for (const product of data.products) {
    let changed = false;
    const rewriteHistory = (history = []) => history.map((row) => {
      const purchaseId = row.grn ? data.sourceMap.get(`grn:${sid(row.grn)}`) : null;
      if (!purchaseId && row.source !== 'grn') return row;
      changed = true;
      const next = { ...row, source: 'purchase' };
      if (purchaseId) next.purchase = purchaseId;
      if (row.grn) next.legacyGrnId = row.grn;
      delete next.grn;
      return next;
    });
    const priceHistory = rewriteHistory(product.priceHistory);
    const vendors = (product.vendors || []).map((vendor) => ({ ...vendor, priceHistory: rewriteHistory(vendor.priceHistory) }));
    if (changed) productOps.push({ updateOne: {
      filter: { _id: product._id },
      update: { $set: { priceHistory, vendors, migrationVersion: VERSION } },
    } });
  }
  if (productOps.length) await conn.collection('products').bulkWrite(productOps, { ordered: false });

  const recordMap = new Map();
  for (const row of data.mappingRows) recordMap.set(sid(row.sourceId), row.purchaseId);
  const auditOps = data.auditLogs
    .filter((log) => recordMap.has(sid(log.recordId)))
    .map((log) => ({ updateOne: {
      filter: { _id: log._id },
      update: { $set: {
        legacyModule: log.module,
        legacyRecordId: log.recordId,
        module: 'Purchase',
        recordId: recordMap.get(sid(log.recordId)),
        migrationVersion: VERSION,
      } },
    } }));
  if (auditOps.length) await conn.collection('auditlogs').bulkWrite(auditOps, { ordered: false });

  const userOps = data.users.map((user) => {
    const permissions = { ...(user.permissions || {}) };
    const explicit = (...keys) => {
      const stored = keys.flatMap((key) => [key, key.replaceAll('.', '___')]);
      const present = stored.filter((key) => Object.prototype.hasOwnProperty.call(permissions, key));
      return present.length ? present.some((key) => permissions[key] === true) : undefined;
    };
    const view = explicit('purchases.view', 'grn.view', 'invoices.view');
    const create = explicit('purchases.create', 'grn.receive', 'invoices.submit');
    const post = explicit('purchases.post', 'grn.receive', 'invoices.approve');
    if (view !== undefined) permissions.purchases___view = view;
    if (create !== undefined) permissions.purchases___create = create;
    if (post !== undefined) permissions.purchases___post = post;
    return { updateOne: { filter: { _id: user._id }, update: { $set: { permissions } } } };
  });
  if (userOps.length) await conn.collection('users').bulkWrite(userOps, { ordered: false });
};

const verifyTenant = async (conn, data, beforeControls, prospective = false) => {
  const represented = (type, rows) => {
    const ids = new Set(data.mappingRows.filter((row) => row.sourceType === type).map((row) => sid(row.sourceId)));
    return rows.filter((row) => ids.has(sid(row._id))).length;
  };
  const purchases = prospective ? data.purchases : await docs(conn, 'purchases');
  const migratedByInvoice = new Map(purchases.filter((row) => row.legacy?.invoiceId).map((row) => [sid(row.legacy.invoiceId), row]));
  const migratedInvoiceTotal = r2(data.invoices.reduce((total, invoice) => total + Number(migratedByInvoice.get(sid(invoice._id))?.totalAmount || 0), 0));
  const validPaymentLinks = prospective
    ? data.payments.length
    : await conn.collection('payments').countDocuments({ _id: { $in: data.payments.map((row) => row._id) }, purchase: { $type: 'objectId' } });
  const eligibleJournalIds = data.journalEntries.filter((entry) => {
    if (entry.migrationVersion === VERSION) return true;
    if (entry.sourceModule === 'invoice') return data.sourceMap.has(`invoice:${sid(entry.sourceId)}`);
    if (['inventory', 'grn'].includes(entry.sourceModule)) {
      return data.sourceMap.has(`grn:${sid(entry.sourceId)}`) || data.sourceMap.has(`invoice:${sid(entry.sourceId)}`);
    }
    if (entry.sourceModule === 'purchaseOrder') return data.sourceMap.has(`purchaseOrder:${sid(entry.sourceId)}`);
    if (entry.sourceModule === 'payment') return data.paymentPurchase.has(sid(entry.sourceId));
    return false;
  }).map((entry) => entry._id);
  const eligibleMovementIds = data.stockMovements.filter((movement) => {
    if (movement.migrationVersion === VERSION) return true;
    if (movement.ref?.kind === 'invoice') return data.sourceMap.has(`invoice:${sid(movement.ref.id)}`);
    if (movement.ref?.kind === 'grn') return data.sourceMap.has(`grn:${sid(movement.ref.id)}`);
    if (movement.ref?.kind === 'purchaseOrder') return data.sourceMap.has(`purchaseOrder:${sid(movement.ref.id)}`);
    return false;
  }).map((movement) => movement._id);
  const mappedRecordIds = new Set(data.mappingRows.map((row) => sid(row.sourceId)));
  const eligibleAuditIds = data.auditLogs
    .filter((log) => log.migrationVersion === VERSION || mappedRecordIds.has(sid(log.recordId)))
    .map((log) => log._id);
  const [linkedJournals, linkedMovements, linkedAudits] = prospective ? [
    eligibleJournalIds.length, eligibleMovementIds.length, eligibleAuditIds.length,
  ] : await Promise.all([
    eligibleJournalIds.length ? conn.collection('journalentries').countDocuments({
      _id: { $in: eligibleJournalIds },
      migrationVersion: VERSION,
      sourcePath: /^\/purchases\/[a-f0-9]{24}$/,
      description: { $type: 'string' },
    }) : 0,
    eligibleMovementIds.length ? conn.collection('stockmovements').countDocuments({
      _id: { $in: eligibleMovementIds },
      migrationVersion: VERSION,
      'ref.kind': 'purchase',
      'ref.id': { $type: 'objectId' },
    }) : 0,
    eligibleAuditIds.length ? conn.collection('auditlogs').countDocuments({
      _id: { $in: eligibleAuditIds },
      migrationVersion: VERSION,
      module: 'Purchase',
      recordId: { $type: 'objectId' },
    }) : 0,
  ]);
  const afterControls = prospective ? beforeControls : await collectControlTotals(conn);
  const expectedUniquePurchases = data.purchases.length;
  const actualUniquePurchases = prospective
    ? expectedUniquePurchases
    : await conn.collection('purchases').countDocuments({ 'legacy.migrationVersion': VERSION });
  const checks = {
    purchaseOrdersRepresented: represented('purchaseOrder', data.purchaseOrders) === data.purchaseOrders.length,
    grnsRepresented: represented('grn', data.grns) === data.grns.length,
    invoicesRepresented: represented('invoice', data.invoices) === data.invoices.length,
    paymentsLinked: validPaymentLinks === data.payments.length,
    journalSourcesLinked: linkedJournals === eligibleJournalIds.length,
    stockSourcesLinked: linkedMovements === eligibleMovementIds.length,
    auditSourcesLinked: linkedAudits === eligibleAuditIds.length,
    purchaseCount: actualUniquePurchases === expectedUniquePurchases,
    invoiceValue: Math.abs(sum(data.invoices, 'totalAmount') - migratedInvoiceTotal) < 0.01,
    stockUnchanged: Math.abs(beforeControls.stockQty - afterControls.stockQty) < 0.0001,
    journalDebitsUnchanged: Math.abs(beforeControls.journalDebit - afterControls.journalDebit) < 0.01,
    journalCreditsUnchanged: Math.abs(beforeControls.journalCredit - afterControls.journalCredit) < 0.01,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    counts: {
      purchaseOrders: data.purchaseOrders.length,
      grns: data.grns.length,
      invoices: data.invoices.length,
      payments: data.payments.length,
      purchases: expectedUniquePurchases,
      stockMovements: data.stockMovements.length,
      journalEntries: data.journalEntries.length,
      auditLogs: data.auditLogs.length,
      migratedJournalLinks: eligibleJournalIds.length,
      migratedStockLinks: eligibleMovementIds.length,
      migratedAuditLinks: eligibleAuditIds.length,
    },
    values: {
      legacyInvoiceTotal: sum(data.invoices, 'totalAmount'),
      migratedInvoiceTotal,
      stockQty: beforeControls.stockQty,
      journalDebit: beforeControls.journalDebit,
      journalCredit: beforeControls.journalCredit,
    },
    reviewRequired: data.purchases.filter((purchase) => purchase.migrationReview?.required).map((purchase) => ({
      purchaseNumber: purchase.purchaseNumber,
      reasons: purchase.migrationReview.reasons,
    })),
  };
};

const cleanupTenant = async (conn, data, verification) => {
  if (!verification.pass) throw new Error('Cleanup refused because reconciliation did not pass.');
  if (!args.has('--confirm-cleanup=REMOVE-PO-GRN-INVOICE')) {
    throw new Error('Cleanup requires --confirm-cleanup=REMOVE-PO-GRN-INVOICE.');
  }
  if (data.payments.length) {
    await conn.collection('payments').updateMany(
      { _id: { $in: data.payments.map((row) => row._id) } },
      { $unset: { invoice: '' } },
    );
  }
  if (await exists(conn, 'counters')) {
    await conn.collection('counters').deleteMany({ _id: { $in: ['PO', 'GRN', 'INV'] } });
  }
  for (const name of ['purchaseorders', 'goodsreceivednotes', 'invoices']) {
    if (await exists(conn, name)) await conn.collection(name).drop();
  }
};

const migrateTenant = async (slug) => {
  const conn = await getTenantConnectionFor(slug);
  const beforeControls = await collectControlTotals(conn);
  const data = await prepareTenant(conn);
  if (mode === 'apply') await applyTenant(conn, data);
  const verification = await verifyTenant(conn, data, beforeControls, mode === 'dry-run');
  let cleanupChecks = null;
  if (mode === 'cleanup') {
    await cleanupTenant(conn, data, verification);
    cleanupChecks = {
      purchaseOrdersDropped: !(await exists(conn, 'purchaseorders')),
      grnsDropped: !(await exists(conn, 'goodsreceivednotes')),
      invoicesDropped: !(await exists(conn, 'invoices')),
      paymentInvoiceRefsRemoved: data.payments.length === 0
        || await conn.collection('payments').countDocuments({ invoice: { $exists: true } }) === 0,
    };
    verification.pass = verification.pass && Object.values(cleanupChecks).every(Boolean);
  }
  return { tenant: slug, mode, ...verification, cleaned: mode === 'cleanup', cleanupChecks };
};

const main = async () => {
  await connectPlatform();
  const tenantFilter = onlyTenant ? { slug: onlyTenant } : {};
  const tenants = await TenantModel().find(tenantFilter).select('slug status').sort({ slug: 1 }).lean();
  if (!tenants.length) throw new Error(onlyTenant ? `Tenant "${onlyTenant}" was not found.` : 'No tenants found.');
  const results = [];
  for (const tenant of tenants) {
    try {
      const result = await migrateTenant(tenant.slug);
      results.push(result);
      console.log(`[${tenant.slug}] ${mode}: ${result.pass ? 'PASS' : 'FAIL'} | ${JSON.stringify(result.counts)}`);
    } catch (error) {
      results.push({ tenant: tenant.slug, mode, pass: false, error: error.message });
      console.error(`[${tenant.slug}] ${mode}: ERROR — ${error.message}`);
    }
  }
  const report = {
    migrationVersion: VERSION,
    generatedAt: new Date().toISOString(),
    mode,
    pass: results.every((result) => result.pass),
    tenants: results,
  };
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ mode, pass: report.pass, tenants: results.length, reportPath: reportPath || null }));
  await Promise.all([...new Set(tenants.map((tenant) => tenant.slug))].map(async (slug) => {
    try { (await getTenantConnectionFor(slug)).close(); } catch { /* best effort */ }
  }));
  await getPlatformConnection().close();
  process.exitCode = report.pass ? 0 : 1;
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
