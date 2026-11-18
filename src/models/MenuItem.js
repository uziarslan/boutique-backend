import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const ingredientSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'product is required.'],
    },
    qty: {
      type: Number,
      required: [true, 'qty is required.'],
      min: [0.0001, 'qty must be positive.'],
    },
    unit: {
      type: String,
      trim: true,
      required: [true, 'unit is required.'],
    },
    parLevel: {
      type: Number,
      default: 0,
      min: 0,
    },
    varianceBaseline: {
      type: Number,
      default: 5,
      min: 0,
    },
    adaptiveVariance: {
      type: Number,
      default: 5,
      min: 0,
    },
    usageWindow: {
      type: [Number],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { _id: true, timestamps: true }
);

// A size variation (e.g. Small/Medium/Large). Each variation owns its OWN price
// and its OWN recipe — sizes can use different ingredients/quantities, not just a
// scaled amount. Tax/service/availability stay on the parent MenuItem.
const variationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Variation name is required.'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Variation price is required.'],
      min: [0, 'Price cannot be negative.'],
    },
    // Optional platform-specific selling price. Older/unconfigured variations
    // fall back to their standard price at checkout.
    foodPandaPrice: {
      type: Number,
      default: null,
      min: [0, 'Foodpanda price cannot be negative.'],
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    ingredients: {
      type: [ingredientSchema],
      default: [],
    },
  },
  { _id: true, timestamps: true }
);

// A deal may contain items that are always included, customer choice groups,
// or both. Components point at regular menu items so their recipes, kitchen
// category and availability continue to have a single source of truth.
const dealComponentSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: [true, 'Deal component item is required.'],
    },
    variationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    qty: {
      type: Number,
      required: true,
      min: [1, 'Deal component quantity must be at least 1.'],
      default: 1,
    },
    sortOrder: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const dealOptionSchema = new mongoose.Schema(
  {
    menuItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuItem',
      required: [true, 'Deal option item is required.'],
    },
    variationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    qty: {
      type: Number,
      required: true,
      min: [1, 'Deal option quantity must be at least 1.'],
      default: 1,
    },
    priceAdjustment: {
      type: Number,
      default: 0,
      min: [0, 'Deal option price adjustment cannot be negative.'],
    },
    sortOrder: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const dealChoiceGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Deal choice group name is required.'],
      trim: true,
    },
    minSelections: { type: Number, default: 1, min: 0, max: 50 },
    maxSelections: { type: Number, default: 1, min: 1, max: 50 },
    sortOrder: { type: Number, default: 0, min: 0 },
    options: { type: [dealOptionSchema], default: [] },
  },
  { _id: true }
);

const menuItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Item name is required.'],
      trim: true,
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: [true, 'Outlet is required.'],
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MenuCategory',
      required: [true, 'Category is required.'],
    },
    itemType: {
      type: String,
      enum: ['regular', 'deal'],
      default: 'regular',
    },
    dealConfig: {
      fixedItems: { type: [dealComponentSchema], default: [] },
      choiceGroups: { type: [dealChoiceGroupSchema], default: [] },
    },
    price: {
      type: Number,
      required: [true, 'Price is required.'],
      min: [0, 'Price cannot be negative.'],
    },
    // Combined treatment for both sales tax/GST and service charge. Legacy
    // records default to exclusive so their totals remain unchanged.
    priceMode: {
      type: String,
      enum: ['exclusive', 'inclusive'],
      default: 'exclusive',
    },
    // Used only when orderType=foodpanda. Null preserves the standard menu
    // price, which keeps existing menu items backward compatible.
    foodPandaPrice: {
      type: Number,
      default: null,
      min: [0, 'Foodpanda price cannot be negative.'],
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Per-item service charge percentage — applied to the line total like tax.
    serviceCharge: {
      type: Number,
      default: 0,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
    },
    imageUrl: {
      type: String,
      trim: true,
    },
    // Cloudinary public_id for the item image — used to delete/replace the
    // asset when the image is updated or the item is hard-deleted.
    imagePublicId: {
      type: String,
      trim: true,
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
    // Channel-level visibility for the public table QR menu. This is separate
    // from `isAvailable`, which controls the item across POS and other ordering
    // surfaces. Legacy documents without this field remain QR-visible.
    isAvailableForQrOrder: {
      type: Boolean,
      default: true,
    },
    // true iff ingredients.length > 0; managed exclusively by saveRecipe.
    trackInventory: {
      type: Boolean,
      default: false,
    },
    // When true, this item's recipe (item-level AND every variation's
    // ingredients) is password-protected: no endpoint returns its ingredient
    // composition without a valid recipe-unlock token. The password itself is
    // the single tenant-wide one in RecipeLockConfig.
    recipeLocked: {
      type: Boolean,
      default: false,
    },
    // Embedded recipe — each entry is one ingredient consumed per serving.
    // Used only when the item has NO variations; otherwise the chosen
    // variation's recipe applies.
    ingredients: {
      type: [ingredientSchema],
      default: [],
    },
    // Size variations. When non-empty, the item is ordered BY variation: price
    // and recipe come from the selected variation and the item-level price /
    // ingredients are ignored. Empty = single-price item (legacy behavior).
    variations: {
      type: [variationSchema],
      default: [],
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    // Legacy federal DI item metadata retained for existing documents.
    fbr: {
      hsCode: { type: String, trim: true },
      saleType: { type: String, trim: true },
      uoM: { type: String, trim: true },
    },
    // Optional PRA eIMS item metadata. ItemCode identifies the product in the
    // restaurant's own catalogue; PCTCode classifies the taxable service.
    // Missing values safely fall back to the menu item id and outlet default.
    pra: {
      itemCode: { type: String, trim: true, maxlength: 50 },
      pctCode: { type: String, trim: true, maxlength: 8 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

menuItemSchema.index({ outlet: 1, isAvailable: 1, isAvailableForQrOrder: 1 });
menuItemSchema.index({ outlet: 1, category: 1, sortOrder: 1 });
menuItemSchema.index({ 'ingredients.product': 1 }, { sparse: true });
menuItemSchema.index({ 'variations.ingredients.product': 1 }, { sparse: true });
menuItemSchema.index({ 'dealConfig.fixedItems.menuItem': 1 }, { sparse: true });
menuItemSchema.index({ 'dealConfig.choiceGroups.options.menuItem': 1 }, { sparse: true });

const MenuItem = defineModel('MenuItem', menuItemSchema);

export default MenuItem;
