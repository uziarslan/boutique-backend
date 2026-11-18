// stockLedger.js — the single writer for the StockMovement ledger.
//
// Every place that mutates StockItem.qtyOnHand also records one (or more) ledger
// rows here so the Store/Kitchen reports and audit trail have an immutable
// history. `qty` is SIGNED, in the product's base stock unit (+ in, − out).
//
// Best-effort by design: a ledger hiccup must never break the sale/receipt/waste
// it is recording, so failures are logged and swallowed.

import StockMovement from '../models/StockMovement.js';
import logger from '../utils/logger.js';

const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));

const toDoc = (e) => ({
  product:  e.product,
  outlet:   e.outlet,
  area:     e.area ?? 'kitchen',
  qty:      e.qty,
  unit:     e.unit,
  type:     e.type,
  unitCost: round2(e.unitCost ?? 0),
  value:    round2((Number(e.qty) || 0) * (Number(e.unitCost) || 0)),
  ref:      e.ref ? { kind: e.ref.kind ?? null, id: e.ref.id ?? null } : undefined,
  note:     e.note,
  user:     e.user,
  at:       e.at ?? new Date(),
});

/** Record one stock movement. Never throws. */
export const recordStockMovement = async (entry) => {
  try {
    await StockMovement.create(toDoc(entry));
  } catch (err) {
    logger.error(`[LEDGER] Failed to record ${entry?.type} movement for product ${entry?.product}: ${err.message}`);
  }
};

/** Record many movements. Transactional callers must roll back on failure. */
export const recordStockMovements = async (entries, { session = null } = {}) => {
  const list = (entries || []).filter(Boolean);
  if (list.length === 0) return;
  try {
    await StockMovement.insertMany(list.map(toDoc), { ordered: Boolean(session), ...(session ? { session } : {}) });
  } catch (err) {
    if (session) throw err;
    logger.error(`[LEDGER] Failed to batch-record ${list.length} movement(s): ${err.message}`);
  }
};
