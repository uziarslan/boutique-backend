import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import Counter from './Counter.js';

const generateEntryNumber = async () => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `JE-${today}`;
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `${key}-${String(doc.seq).padStart(4, '0')}`;
};

// ─── Journal line sub-schema ──────────────────────────────────────────────────

const jeLineSchema = new mongoose.Schema(
  {
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccounts',
      required: [true, 'Account is required on each journal line.'],
    },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true },
  },
  { _id: true }
);

// ─── JournalEntry schema ──────────────────────────────────────────────────────

const journalEntrySchema = new mongoose.Schema(
  {
    entryNumber: {
      type: String,
      unique: true,
      trim: true,
    },
    date: {
      type: Date,
      required: [true, 'Entry date is required.'],
    },
    description: {
      type: String,
      required: [true, 'Description is required.'],
      trim: true,
    },
    lines: {
      type: [jeLineSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length >= 2,
        message: 'A journal entry must have at least two lines.',
      },
    },
    isBalanced: {
      type: Boolean,
      default: false,
    },
    sourceModule: {
      type: String,
      enum: [
        'purchase',
        'purchaseAdjustment',
        'payment',
        'manual',
        'inventory',
        'waste',
        'pos',
        'stockCount',
        'salary',
        'salaryAdvance',
        'allowance',
        'loyalty',
        'cashDrawer',
        'assetAcquisition',
        'assetDepreciation',
        'assetAuditAdjustment',
        'assetDisposal',
      ],
      required: [true, 'Source module is required.'],
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    // An existing POS journal reclassified to payroll retains its order source.
    salaryAdvance: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryAdvance' },
    // Optional outlet accounting dimension. Existing tenant-wide journals stay
    // valid with a null outlet; new asset journals always carry this value.
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      default: null,
    },
    // Human-facing source metadata is snapshotted so journals stay clear even
    // after products/vendors are renamed. The UI renders description as a real
    // anchor to sourcePath; legacyDescription preserves pre-migration wording.
    sourcePath: { type: String, trim: true },
    itemSummary: { type: String, trim: true },
    sourceNumber: { type: String, trim: true },
    legacyDescription: { type: String, trim: true },
    // Optional PARTY tag for manual entries so AP aging can group them by vendor.
    // `partyVendor` links to a Vendor when the party is a known vendor (then it
    // groups WITH that vendor's invoice/payment lines under the same key);
    // `party` holds the display name (vendor's name, or a free-text party).
    party: {
      type: String,
      trim: true,
    },
    partyVendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
    },
    status: {
      type: String,
      enum: ['draft', 'posted'],
      default: 'posted',
    },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

journalEntrySchema.index({ sourceModule: 1, sourceId: 1 });
journalEntrySchema.index({ outlet: 1, date: -1 });
journalEntrySchema.index({ date: -1 });
journalEntrySchema.index({ status: 1 });

// ─── Pre-save: auto-generate entryNumber ─────────────────────────────────────

journalEntrySchema.pre('save', async function () {
  if (!this.isNew || this.entryNumber) return;
  this.entryNumber = await generateEntryNumber();
});

// ─── Pre-save: validate balance (sum debits === sum credits) ──────────────────

journalEntrySchema.pre('save', function () {
  const totalDebits = this.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredits = this.lines.reduce((s, l) => s + (l.credit ?? 0), 0);

  // Use epsilon comparison to handle floating-point arithmetic
  const balanced = Math.abs(totalDebits - totalCredits) < 0.001;
  this.isBalanced = balanced;

  if (!balanced) {
    throw new Error(
      `Journal entry does not balance: debits ${totalDebits.toFixed(2)}, credits ${totalCredits.toFixed(2)}.`
    );
  }
});

const JournalEntry = defineModel('JournalEntry', journalEntrySchema);

export default JournalEntry;
