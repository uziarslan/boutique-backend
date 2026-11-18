import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const consumedMaterialSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, required: true, trim: true },
  unitCost: { type: Number, min: 0, default: 0 },
  costingStatus: { type: String, enum: ['complete', 'review'], default: 'review' },
  totalCost: { type: Number, min: 0, default: 0 },
}, { _id: false });

const productionOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, trim: true, unique: true },
  billOfMaterials: { type: mongoose.Schema.Types.ObjectId, ref: 'BillOfMaterials', required: true },
  finishedVariant: { type: mongoose.Schema.Types.ObjectId, ref: 'RetailVariant', required: true },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
  shopifyLocationId: { type: String, trim: true, default: '' },
  plannedQuantity: { type: Number, required: true, min: 1 },
  producedQuantity: { type: Number, min: 0, default: 0 },
  rejectedQuantity: { type: Number, min: 0, default: 0 },
  materialUsage: { type: [consumedMaterialSchema], default: [] },
  laborCost: { type: Number, min: 0, default: 0 },
  overheadCost: { type: Number, min: 0, default: 0 },
  totalProductionCost: { type: Number, min: 0, default: 0 },
  unitCost: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['draft', 'released', 'completed', 'cancelled'], default: 'draft' },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  releasedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

productionOrderSchema.index({ outlet: 1, status: 1, createdAt: -1 });

export default defineModel('ProductionOrder', productionOrderSchema);
