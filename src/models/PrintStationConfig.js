import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const printerRouteSchema = new mongoose.Schema(
  {
    printerName: { type: String, required: true, trim: true },
    displayName: { type: String, trim: true, default: '' },
    role: { type: String, enum: ['kitchen', 'dispatch'], default: 'kitchen' },
    categoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' }],
    allCategories: { type: Boolean, default: false },
    copies: { type: Number, min: 1, max: 5, default: 1 },
    enabled: { type: Boolean, default: true },
  },
  { _id: true },
);

const printStationConfigSchema = new mongoose.Schema(
  {
    stationId: { type: String, required: true, trim: true, unique: true },
    stationLabel: { type: String, trim: true, default: '' },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: true,
      index: true,
    },
    printers: { type: [printerRouteSchema], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

printStationConfigSchema.index({ outlet: 1, stationId: 1 });

export default defineModel('PrintStationConfig', printStationConfigSchema);
