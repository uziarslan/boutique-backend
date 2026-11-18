/**
 * Migration: fix the Customer.membershipCardNumber unique index.
 *
 * The old index was `{ membershipCardNumber: 1 }, { unique: true, sparse: true }`.
 * Sparse only excludes documents where the field is ABSENT — but cardless
 * customers store `null` (schema default) or '', so the field is present and a
 * second cardless customer collides ("Duplicate value '' ... membershipCardNumber").
 *
 * This script, for every tenant database:
 *   1. Normalizes any '' card numbers to null (tidy data).
 *   2. Drops the old `membershipCardNumber_1` index if present.
 *   3. Recreates it as a PARTIAL unique index that only applies to non-empty
 *      card numbers ({ $gt: '' }) — so cardless customers never collide while
 *      real card numbers stay unique.
 *
 * Run once:  node src/scripts/migrateMembershipCardIndex.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { buildUri, connectPlatform } from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';

dotenv.config();

const INDEX_NAME = 'membershipCardNumber_1';
const INDEX_OPTIONS = {
    name: INDEX_NAME,
    unique: true,
    partialFilterExpression: { membershipCardNumber: { $gt: '' } },
};

async function fixCollection(coll, label) {
    // 1. Normalize empty-string card numbers to null.
    const norm = await coll.updateMany(
        { membershipCardNumber: '' },
        { $set: { membershipCardNumber: null } },
    );

    // 2. Drop the old index (ignore "not found").
    let dropped = false;
    try {
        await coll.dropIndex(INDEX_NAME);
        dropped = true;
    } catch (err) {
        // 27 / IndexNotFound — the index simply isn't there yet. Anything else is real.
        if (err.code !== 27 && err.codeName !== 'IndexNotFound') throw err;
    }

    // 3. Create the partial unique index.
    await coll.createIndex({ membershipCardNumber: 1 }, INDEX_OPTIONS);

    console.log(`  [${label}] normalized='' → null: ${norm.modifiedCount}, oldIndexDropped: ${dropped}, partialIndexCreated: yes`);
}

async function run() {
    if (!process.env.MONGO_URI) {
        console.error('Missing MONGO_URI in environment (.env).');
        process.exit(1);
    }

    await connectPlatform();
    const tenants = await TenantModel().find().select('slug').lean();
    console.log(`Found ${tenants.length} tenant(s).`);

    let ok = 0;
    let failed = 0;
    for (const t of tenants) {
        const conn = await mongoose.createConnection(buildUri(t.slug)).asPromise();
        try {
            await fixCollection(conn.collection('customers'), t.slug);
            ok += 1;
        } catch (err) {
            failed += 1;
            console.error(`  [${t.slug}] FAILED: ${err.message}`);
        } finally {
            await conn.close();
        }
    }

    console.log(`\nDone. Success: ${ok}, Failed: ${failed}.`);
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
