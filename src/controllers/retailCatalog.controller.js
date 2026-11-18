import mongoose from 'mongoose';
import Outlet from '../models/Outlet.js';
import RetailProduct from '../models/RetailProduct.js';
import RetailVariant from '../models/RetailVariant.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export const createManualRetailProduct = async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const productType = String(req.body?.productType || '').trim();
  const outletId = String(req.body?.outletId || '').trim();
  const inputVariants = Array.isArray(req.body?.variants) ? req.body.variants : [];
  if (!title || title.length > 150) throw fail('Enter a product name (up to 150 characters).');
  if (productType.length > 80) throw fail('Product type must be 80 characters or fewer.');
  if (!mongoose.isValidObjectId(outletId) || !(await Outlet.exists({ _id: outletId, isActive: { $ne: false } }))) {
    throw fail('Choose an active outlet so the product can be stocked and sold there.', 422);
  }
  if (!inputVariants.length || inputVariants.length > 100) throw fail('Add between 1 and 100 variants.');

  const variants = inputVariants.map((item) => ({
    title: String(item?.title || '').trim().slice(0, 100),
    sku: String(item?.sku || '').trim().slice(0, 100),
    barcode: String(item?.barcode || '').trim().slice(0, 80),
    price: Number(item?.price),
  }));
  if (variants.some((item) => !item.title || !Number.isFinite(item.price) || item.price < 0)) {
    throw fail('Each variant needs a name and a valid PKR selling price.');
  }
  const skus = variants.map((item) => item.sku).filter(Boolean);
  const barcodes = variants.map((item) => item.barcode).filter(Boolean);
  if (new Set(skus).size !== skus.length) throw fail('Each variant SKU must be unique within this product.');
  if (new Set(barcodes).size !== barcodes.length) throw fail('Each variant barcode must be unique within this product.');
  if (skus.length && await RetailVariant.exists({ sku: { $in: skus } })) throw fail('A SKU is already used by another catalog variant.', 409);
  if (barcodes.length && await RetailVariant.exists({ barcode: { $in: barcodes } })) throw fail('A barcode is already used by another catalog variant.', 409);

  const product = await RetailProduct.create({
    title,
    productType,
    catalogSource: 'manual',
    status: 'active',
    isActive: true,
  });
  try {
    const createdVariants = await RetailVariant.create(variants.map((item) => ({
      product: product._id,
      catalogSource: 'manual',
      title: item.title,
      sku: item.sku,
      barcode: item.barcode,
      price: item.price,
      unitCost: null,
      unitCostSource: 'manual',
      unitCostStatus: 'review',
      tracked: true,
      isActive: true,
      inventoryByLocation: [{ shopifyLocationId: '', outlet: outletId, available: 0, onHand: 0 }],
    })));
    return res.status(201).json({ success: true, data: { product, variants: createdVariants } });
  } catch (error) {
    await Promise.all([
      RetailVariant.deleteMany({ product: product._id }),
      RetailProduct.deleteOne({ _id: product._id }),
    ]);
    throw error;
  }
};
