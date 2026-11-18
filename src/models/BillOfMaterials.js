import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const materialLineSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 0.0001 },
  unit: { type: String, required: true, trim: true },
  notes: { type: String, trim: true, default: '' },
}, { _id: true });

const billOfMaterialsSchema = new mongoose.Schema({
  finishedVariant: { type: mongoose.Schema.Types.ObjectId, ref: 'RetailVariant', required: true },
  name: { type: String, required: true, trim: true },
  batchSize: { type: Number, min: 1, default: 1 },
  materials: { type: [materialLineSchema], default: [] },
  standardLaborCost: { type: Number, min: 0, default: 0 },
  standardOverheadCost: { type: Number, min: 0, default: 0 },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

billOfMaterialsSchema.index({ finishedVariant: 1, isActive: 1 });

export default defineModel('BillOfMaterials', billOfMaterialsSchema);
