import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// ─── Prep Recipe ────────────────────────────────────────────────────────────
// A reusable in-house preparation (marination, sauce, base…) built from raw
// products and/or OTHER prep recipes. It is backed by a `kind:'prep'` Product
// so it behaves like any stockable item: it gets its own StockItem (on-hand
// quantity per outlet) and its computed cost-per-unit is mirrored onto the
// backing product's currentPrice/defaultPrice — letting the existing recipe
// costing & sale-deduction code treat a prep exactly like a raw ingredient.
//
//   • cost rollup is recursive (a prep can contain another prep) with a cycle
//     guard — see prepRecipe.controller.js.
//   • producing a batch deducts the IMMEDIATE ingredients' stock and adds the
//     finished prep to stock (flat, no recursive production).

const prepIngredientSchema = new mongoose.Schema(
  {
    // Raw product OR the backing product of another prep recipe.
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    qty: { type: Number, required: true, min: 0.0001 },
    unit: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const prepRecipeSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Prep recipe name is required.'], trim: true },
    category: { type: String, trim: true, default: 'Prep' },
    // The stockable product that represents this prep in inventory & recipes.
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    // One batch makes `yieldQty` of `yieldUnit` (e.g. 5 kg, 40 portions).
    yieldQty: { type: Number, required: true, min: 0.0001 },
    yieldUnit: { type: String, required: true, trim: true },
    ingredients: { type: [prepIngredientSchema], default: [] },
    // Auto-computed: total cost to make one batch, and per yield-unit.
    costPerBatch: { type: Number, default: 0, min: 0 },
    costPerUnit: { type: Number, default: 0, min: 0 },
    // When true, this prep's ingredient composition is password-protected — the
    // list and detail endpoints withhold `ingredients` without a valid unlock
    // token. Password lives in the tenant-wide RecipeLockConfig.
    locked: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

prepRecipeSchema.index({ isActive: 1, name: 1 });
prepRecipeSchema.index({ product: 1 });

const PrepRecipe = defineModel('PrepRecipe', prepRecipeSchema);

export default PrepRecipe;
