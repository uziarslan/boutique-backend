import StockItem from '../models/StockItem.js';
import logger from './logger.js';

// Best-effort self-heal: drop the legacy { product, outlet } unique index if it
// is present on the current tenant's stockitems collection. It forbids a product
// having both a store row and a kitchen row, so it makes every store↔kitchen
// move and every first receipt into a new area fail with E11000. The connection
// safeguard drops it on connect, but a LIVE DB restore (without a process
// restart) can reintroduce it — so the E11000 catch paths call this too, then
// retry. Returns true if it actually dropped the index.
export const dropLegacyStockIndexIfPresent = async () => {
  try {
    const col = StockItem.collection; // resolves the active tenant's collection
    const indexes = await col.indexes();
    if (indexes.some((i) => i.name === 'product_1_outlet_1')) {
      await col.dropIndex('product_1_outlet_1');
      logger.warn('[stock] self-heal: dropped legacy product_1_outlet_1 index after an E11000');
      return true;
    }
  } catch (err) {
    logger.warn(`[stock] legacy index self-heal skipped: ${err.message}`);
  }
  return false;
};

export default dropLegacyStockIndexIfPresent;
