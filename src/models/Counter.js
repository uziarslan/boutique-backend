import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const counterSchema = new mongoose.Schema(
  { _id: { type: String }, seq: { type: Number, default: 0 } },
  { versionKey: false }
);

const Counter = defineModel('Counter', counterSchema);
export default Counter;
