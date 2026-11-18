/**
 * Migration: rename RecipeIngredient.threshold → parLevel
 *
 * Run once: node src/scripts/migrateThresholdToParLevel.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const mongoUri = process.env.MONGO_URI || process.argv[2];

if (!mongoUri) {
    console.error('Missing MONGO_URI. Provide it in a .env file or pass as first argument:');
    console.error('  node src/scripts/migrateThresholdToParLevel.js "<MONGO_URI>"');
    process.exit(1);
}

async function migrate() {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB.');

    const result = await mongoose.connection.collection('recipeingredients').updateMany(
        { threshold: { $exists: true } },
        [{ $set: { parLevel: '$threshold' } }, { $unset: 'threshold' }]
    );

    console.log(`Migrated ${result.modifiedCount} document(s): threshold → parLevel`);
    await mongoose.disconnect();
    console.log('Done.');
}

migrate().catch((err) => { console.error(err); process.exit(1); });
