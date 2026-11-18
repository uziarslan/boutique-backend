import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

/**
 * RecipeIngredient — links a MenuItem to its raw ingredient (Product) with
 * the quantity consumed per serving and adaptive variance configuration.
 *
 * Adaptive Variance Logic:
 *  • varianceBaseline  — initial ±% tolerance set by the manager.
 *  • adaptiveVariance  — auto-updated by the moving-average engine each time
 *                        a new usage observation is recorded.
 *  • usageWindow       — ring buffer (max 30) of recent actual-usage values
 *                        used to compute the moving average and std-deviation.
 */
const recipeIngredientSchema = new mongoose.Schema(
    {
        menuItem: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'MenuItem',
            required: [true, 'menuItem is required.'],
            index: true,
        },
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'product is required.'],
        },
        // Quantity of the ingredient consumed per one sale of the menu item.
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
        // Absolute stock level below which an alert is raised (in product units).
        parLevel: {
            type: Number,
            default: 0,
            min: 0,
        },
        // Manager-defined starting variance tolerance (percentage, e.g. 5 → ±5 %).
        varianceBaseline: {
            type: Number,
            default: 5,
            min: 0,
        },
        // Current adaptive variance — updated by the moving-average engine.
        adaptiveVariance: {
            type: Number,
            default: 5,
            min: 0,
        },
        // Circular buffer of recent actual-usage observations (max 30 entries).
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
    { timestamps: true }
);

// One ingredient entry per menu-item/product pair.
recipeIngredientSchema.index({ menuItem: 1, product: 1 }, { unique: true });
recipeIngredientSchema.index({ product: 1 });

const RecipeIngredient = defineModel('RecipeIngredient', recipeIngredientSchema);

export default RecipeIngredient;
