import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// One RecipeLockConfig document per tenant — the single source of truth for the
// restaurant-wide "recipe password". When passwordHash is set the feature is
// ON: any menu item recipe or prep recipe flagged locked=true refuses to expose
// its ingredient composition over the API unless the request carries a valid
// unlock token (issued only after the correct password is verified).
//
// The password is stored ONLY as a bcrypt hash — never in plaintext, never
// returned to any client. Removing it (owner-only) disables the feature and
// clears every recipe's locked flag so nothing is left silently protected by a
// password that no longer exists.
const recipeLockConfigSchema = new mongoose.Schema(
  {
    // bcrypt hash of the master recipe password. Absent ⇒ feature disabled.
    passwordHash: { type: String, default: null },
    // Audit: who last set / changed the password.
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const RecipeLockConfig = defineModel('RecipeLockConfig', recipeLockConfigSchema);
export default RecipeLockConfig;
