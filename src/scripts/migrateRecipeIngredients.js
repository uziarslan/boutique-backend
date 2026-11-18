/**
 * One-time migration: copy RecipeIngredient documents into the embedded
 * MenuItem.ingredients array and retire the separate collection.
 *
 * Run once:
 *   node --experimental-vm-modules src/scripts/migrateRecipeIngredients.js
 *   (or via your standard "node -r dotenv/config src/scripts/..." pattern)
 *
 * Safe to re-run: uses $set so existing embedded data is overwritten with
 * the canonical RecipeIngredient values. After confirming success, you can
 * drop the recipeingredients collection from Mongo.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

// Minimal inline model for the OLD collection — avoids importing the now-removed
// RecipeIngredient model file.
const legacySchema = new mongoose.Schema(
    {
        menuItem:          { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
        product:           { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        qty:               Number,
        unit:              String,
        parLevel:          { type: Number, default: 0 },
        varianceBaseline:  { type: Number, default: 5 },
        adaptiveVariance:  { type: Number, default: 5 },
        usageWindow:       { type: [Number], default: [] },
        notes:             String,
        createdBy:         mongoose.Schema.Types.ObjectId,
    },
    { collection: 'recipeingredients', timestamps: true }
);

const LegacyRecipeIngredient = mongoose.model('LegacyRecipeIngredient', legacySchema);

// Import after models are defined
import MenuItem from '../models/MenuItem.js';

async function run() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Group legacy records by menuItem
    const all = await LegacyRecipeIngredient.find({}).lean();
    console.log(`Found ${all.length} legacy RecipeIngredient documents to migrate`);

    const byMenuItem = {};
    for (const rec of all) {
        const miId = rec.menuItem?.toString();
        if (!miId) continue;
        if (!byMenuItem[miId]) byMenuItem[miId] = [];
        byMenuItem[miId].push(rec);
    }

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const [miId, recs] of Object.entries(byMenuItem)) {
        try {
            const menuItem = await MenuItem.findById(miId);
            if (!menuItem) {
                console.warn(`  MenuItem ${miId} not found — skipping ${recs.length} ingredient(s)`);
                skipped += recs.length;
                continue;
            }

            // Build the embedded ingredients array from legacy records.
            // Only add ingredients not already present (by product ID) to avoid
            // overwriting adaptive variance data if the migration was partially run.
            const existingProductIds = new Set(
                (menuItem.ingredients || []).map((i) => i.product?.toString())
            );

            let added = 0;
            for (const rec of recs) {
                const pid = rec.product?.toString();
                if (!pid || existingProductIds.has(pid)) continue;
                menuItem.ingredients.push({
                    product:           rec.product,
                    qty:               rec.qty,
                    unit:              rec.unit,
                    parLevel:          rec.parLevel ?? 0,
                    varianceBaseline:  rec.varianceBaseline ?? 5,
                    adaptiveVariance:  rec.adaptiveVariance ?? 5,
                    usageWindow:       rec.usageWindow ?? [],
                    notes:             rec.notes ?? '',
                    createdBy:         rec.createdBy,
                });
                existingProductIds.add(pid);
                added++;
            }

            menuItem.trackInventory = menuItem.ingredients.length > 0;
            await menuItem.save();

            migrated += added;
            console.log(`  MenuItem ${miId} (${menuItem.name}): +${added} ingredient(s)`);
        } catch (err) {
            console.error(`  Error migrating MenuItem ${miId}: ${err.message}`);
            errors++;
        }
    }

    console.log(`\nMigration complete: ${migrated} ingredients migrated, ${skipped} skipped, ${errors} errors`);
    console.log('You can now drop the "recipeingredients" collection from MongoDB.');

    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
