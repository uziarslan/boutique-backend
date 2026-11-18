import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const menuCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required.'],
      trim: true,
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: [true, 'Outlet is required.'],
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    color: {
      type: String,
      trim: true,
      default: '#4F46E5',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

menuCategorySchema.index({ outlet: 1, sortOrder: 1 });
menuCategorySchema.index({ outlet: 1, isActive: 1 });

const MenuCategory = defineModel('MenuCategory', menuCategorySchema);

export default MenuCategory;
