import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

/**
 * CustomParty — a reusable, tenant-scoped list of free-text and protected system
 * party names used to tag manual journal entries when the party is NOT a known
 * vendor. A custom party typed on the Journal Entry form is upserted here so it
 * can be picked again from the party dropdown. `nameLower` is the case-insensitive
 * dedupe key (unique) and mirrors the aging group key `n:<lc>`.
 */
const customPartySchema = new mongoose.Schema(
  {
    name:      { type: String, required: [true, 'Party name is required.'], trim: true },
    nameLower: { type: String, required: true, trim: true, lowercase: true, unique: true },
    isSystem:  { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

const CustomParty = defineModel('CustomParty', customPartySchema);

export default CustomParty;
