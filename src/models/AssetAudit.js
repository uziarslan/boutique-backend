import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import Counter from './Counter.js';

const nextAuditNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { _id: 'AAU' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `AAU-${String(counter.seq).padStart(6, '0')}`;
};

const assetAuditSchema = new mongoose.Schema(
  {
    auditNumber: { type: String, unique: true, trim: true },
    title: { type: String, trim: true, default: '' },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
    scope: {
      type: {
        type: String,
        enum: ['all', 'category', 'location', 'selected'],
        default: 'all',
      },
      category: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetCategory', default: null },
      location: { type: String, trim: true, default: '' },
      assetIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Asset' }],
    },
    blindCount: { type: Boolean, default: true },
    status: {
      type: String,
      enum: [
        'draft',
        'scheduled',
        'inProgress',
        'submitted',
        'underReview',
        'recountRequested',
        'approved',
        'rejected',
        'cancelled',
      ],
      default: 'draft',
    },
    scheduledFor: { type: Date, default: null },
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    snapshotAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    totalAssets: { type: Number, default: 0 },
    countedAssets: { type: Number, default: 0 },
    varianceLines: { type: Number, default: 0 },
    estimatedVarianceValue: { type: Number, default: 0 },
    ownerOverrideReason: { type: String, trim: true, default: '' },
    journalEntries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
    notes: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

assetAuditSchema.pre('save', async function () {
  if (this.isNew && !this.auditNumber) this.auditNumber = await nextAuditNumber();
});

assetAuditSchema.index({ outlet: 1, status: 1, scheduledFor: 1 });
assetAuditSchema.index({ createdAt: -1 });

const AssetAudit = defineModel('AssetAudit', assetAuditSchema);
export default AssetAudit;
