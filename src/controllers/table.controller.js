import mongoose from 'mongoose';
import Table from '../models/Table.js';
import Outlet from '../models/Outlet.js';
import MenuCategory from '../models/MenuCategory.js';
import logger from '../utils/logger.js';

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

// GET /api/tables?outlet=<id>
export const listTables = async (req, res) => {
  const filter = {};
  if (req.query.outlet && mongoose.isValidObjectId(req.query.outlet)) {
    filter.outlet = req.query.outlet;
  }
  if (req.query.active === 'true') filter.isActive = true;
  if (req.query.active === 'false') filter.isActive = false;

  const tables = await Table.find(filter)
    .populate('outlet', 'name code')
    .sort({ outlet: 1, label: 1 })
    .lean();

  return res.json({ success: true, data: tables });
};

// GET /api/tables/settings/:outletId/menu-categories
// Exposes only the category metadata needed for QR preparation routing, under
// tables.manage rather than the broader menu.manage permission.
export const listQrMenuCategories = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.outletId)) {
    return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  }
  const categories = await MenuCategory.find({ outlet: req.params.outletId })
    .select('_id name color isActive sortOrder')
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  return res.json({ success: true, data: categories });
};

const cleanText = (value, max) => String(value || '').trim().slice(0, max);

// PATCH /api/tables/settings/:outletId
// Kept under the Table QR permission boundary so a manager who can administer
// QR tables can also configure that customer experience without receiving
// access to unrelated outlet settings.
export const updateQrSettings = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.outletId)) {
    return res.status(422).json({ success: false, message: 'A valid outlet is required.' });
  }

  const preparationMinutes = Number(req.body?.preparationMinutes);
  if (!Number.isInteger(preparationMinutes) || preparationMinutes < 0 || preparationMinutes > 240) {
    return res.status(422).json({
      success: false,
      message: 'Standard preparation time must be a whole number from 0 to 240 minutes.',
    });
  }

  const existingOutlet = await Outlet.findById(req.params.outletId)
    .select('_id qrOrdering')
    .lean();
  if (!existingOutlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });

  const rawPreparationCategories = req.body?.preparationCategories;
  let preparationCategories = existingOutlet.qrOrdering?.preparationCategories || [];
  if (rawPreparationCategories !== undefined) {
    if (!Array.isArray(rawPreparationCategories) || rawPreparationCategories.length > 25) {
      return res.status(422).json({
        success: false,
        message: 'Preparation categories must be a list of no more than 25 entries.',
      });
    }

    const names = new Set();
    const assignedMenuCategories = new Set();
    preparationCategories = [];
    for (const [index, raw] of rawPreparationCategories.entries()) {
      const name = cleanText(raw?.name, 80);
      const categoryMinutes = Number(raw?.preparationMinutes);
      const ids = Array.isArray(raw?.menuCategoryIds)
        ? [...new Set(raw.menuCategoryIds.map(String))]
        : [];
      if (!name) {
        return res.status(422).json({ success: false, message: `Preparation category ${index + 1} needs a name.` });
      }
      const normalizedName = name.toLocaleLowerCase();
      if (names.has(normalizedName)) {
        return res.status(422).json({ success: false, message: `Preparation category names must be unique (${name}).` });
      }
      names.add(normalizedName);
      if (!Number.isInteger(categoryMinutes) || categoryMinutes < 0 || categoryMinutes > 240) {
        return res.status(422).json({
          success: false,
          message: `${name}'s preparation time must be a whole number from 0 to 240 minutes.`,
        });
      }
      if (ids.length === 0 || ids.some((id) => !mongoose.isValidObjectId(id))) {
        return res.status(422).json({
          success: false,
          message: `${name} must contain at least one valid Menu Management category.`,
        });
      }
      for (const id of ids) {
        if (assignedMenuCategories.has(id)) {
          return res.status(422).json({
            success: false,
            message: 'A Menu Management category can belong to only one preparation category.',
          });
        }
        assignedMenuCategories.add(id);
      }
      preparationCategories.push({
        ...(mongoose.isValidObjectId(raw?._id) ? { _id: raw._id } : {}),
        name,
        preparationMinutes: categoryMinutes,
        menuCategoryIds: ids,
      });
    }

    if (assignedMenuCategories.size > 0) {
      const ownedCount = await MenuCategory.countDocuments({
        _id: { $in: [...assignedMenuCategories] },
        outlet: existingOutlet._id,
      });
      if (ownedCount !== assignedMenuCategories.size) {
        return res.status(422).json({
          success: false,
          message: 'One or more selected menu categories do not belong to this outlet.',
        });
      }
    }
  }

  const payment = req.body?.customerPayment || existingOutlet.qrOrdering?.customerPayment || {};
  const qrOrdering = {
    preparationMinutes,
    preparationCategories,
    customerPayment: {
      enabled: Boolean(payment.enabled),
      bankName: cleanText(payment.bankName, 120),
      accountTitle: cleanText(payment.accountTitle, 120),
      accountNumber: cleanText(payment.accountNumber, 80),
      iban: cleanText(payment.iban, 50).replace(/\s+/g, '').toUpperCase(),
      instructions: cleanText(payment.instructions, 500),
    },
  };

  if (qrOrdering.customerPayment.enabled
    && !qrOrdering.customerPayment.accountNumber
    && !qrOrdering.customerPayment.iban) {
    return res.status(422).json({
      success: false,
      message: 'Add an account number or IBAN before enabling customer payment details.',
    });
  }

  const outlet = await Outlet.findByIdAndUpdate(
    req.params.outletId,
    { $set: { qrOrdering } },
    { returnDocument: 'after', runValidators: true },
  ).select('_id name code qrOrdering');
  logger.info(`Table QR settings updated for outlet ${outlet._id} by ${req.user?.email || req.user?.id}`);
  return res.json({ success: true, data: outlet });
};

// POST /api/tables
export const createTable = async (req, res) => {
  const { outlet, label, code, capacity, notes } = req.body || {};
  if (!outlet || !mongoose.isValidObjectId(outlet)) {
    return res.status(422).json({ success: false, message: 'Outlet is required.' });
  }
  if (!label || !label.trim()) {
    return res.status(422).json({ success: false, message: 'Label is required.' });
  }

  const finalCode = slugify(code || label);
  if (!finalCode) {
    return res.status(422).json({ success: false, message: 'Code could not be derived.' });
  }

  const exists = await Table.findOne({ outlet, code: finalCode }).lean();
  if (exists) {
    return res.status(409).json({ success: false, message: `A table with code "${finalCode}" already exists in this outlet.` });
  }

  const table = await Table.create({
    outlet,
    label: label.trim(),
    code: finalCode,
    capacity: Number(capacity) || 0,
    notes: notes || '',
    createdBy: req.user?.id,
  });

  logger.info(`Table created: ${table.label} (${table.code}) in outlet ${outlet}`);
  return res.status(201).json({ success: true, data: table });
};

// PUT /api/tables/:id
export const updateTable = async (req, res) => {
  const { label, code, capacity, notes, isActive } = req.body || {};
  const table = await Table.findById(req.params.id);
  if (!table) return res.status(404).json({ success: false, message: 'Table not found.' });

  if (label !== undefined) table.label = String(label).trim();
  if (capacity !== undefined) table.capacity = Number(capacity) || 0;
  if (notes !== undefined) table.notes = String(notes);
  if (isActive !== undefined) table.isActive = Boolean(isActive);

  // Code handling:
  //  - sent + non-empty → use it (slugified, uniqueness-checked)
  //  - sent but empty / whitespace → re-derive from the (possibly new) label
  //  - not sent at all → leave it alone
  let nextCode = null;
  if (code !== undefined) {
    const raw = String(code).trim();
    if (raw === '') {
      nextCode = slugify(table.label);
    } else {
      nextCode = slugify(raw);
      if (!nextCode) {
        return res.status(422).json({ success: false, message: 'Code must contain at least one letter or digit.' });
      }
    }
  }

  if (nextCode && nextCode !== table.code) {
    // Auto-suffix on collision so the auto-derived path "just works" instead
    // of erroring. For an explicit user-typed code we still error so they
    // know to pick a different one.
    const explicit = code !== undefined && String(code).trim() !== '';
    let candidate = nextCode;
    let i = 2;
    while (await Table.findOne({ outlet: table.outlet, code: candidate, _id: { $ne: table._id } }).lean()) {
      if (explicit) {
        return res.status(409).json({ success: false, message: `Code "${nextCode}" is already in use.` });
      }
      candidate = `${nextCode}-${i++}`;
      if (i > 50) break;
    }
    table.code = candidate;
  }

  await table.save();
  return res.json({ success: true, data: table });
};

// DELETE /api/tables/:id  (soft delete)
export const deleteTable = async (req, res) => {
  const table = await Table.findById(req.params.id);
  if (!table) return res.status(404).json({ success: false, message: 'Table not found.' });
  table.isActive = false;
  await table.save();
  return res.json({ success: true, data: table });
};

// POST /api/tables/:id/reactivate  — flips a soft-deleted table back to active.
export const reactivateTable = async (req, res) => {
  const table = await Table.findById(req.params.id);
  if (!table) return res.status(404).json({ success: false, message: 'Table not found.' });
  if (table.isActive) return res.json({ success: true, data: table }); // idempotent
  table.isActive = true;
  await table.save();
  return res.json({ success: true, data: table });
};
