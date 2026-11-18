import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

/**
 * IngredientUsageLog — one record per product per outlet per day.
 *
 * Computed fields:
 *  • expectedUsage     = Σ (recipeQty × unitsSold) across all menu items that
 *                        use this ingredient, for the given day.
 *  • actualUsage       = opening stock − closing stock (from stock-count data)
 *                        OR derived from GRN + waste adjustments.
 *  • variance          = actualUsage − expectedUsage
 *  • variancePct       = variance / expectedUsage × 100  (0 when expected = 0)
 *  • movingAvgVariance = rolling mean of the last N variancePct values.
 */
const ingredientUsageLogSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'product is required.'],
        },
        outlet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Outlet',
        },
        // Truncated to midnight UTC so aggregations group cleanly by calendar day.
        date: {
            type: Date,
            required: [true, 'date is required.'],
        },
        expectedUsage: { type: Number, default: 0 },
        actualUsage: { type: Number, default: 0 },
        variance: { type: Number, default: 0 },
        // Positive → over-consumed; Negative → under-consumed.
        variancePct: { type: Number, default: 0 },
        // Moving average variance percentage across the recent window.
        movingAvgVariance: { type: Number, default: 0 },
        unit: {
            type: String,
            trim: true,
        },
        notes: {
            type: String,
            trim: true,
        },
    },
    { timestamps: true }
);

// One log entry per product/outlet/day.
ingredientUsageLogSchema.index({ product: 1, outlet: 1, date: -1 }, { unique: true });
ingredientUsageLogSchema.index({ outlet: 1, date: -1 });

const IngredientUsageLog = defineModel('IngredientUsageLog', ingredientUsageLogSchema);

export default IngredientUsageLog;
