import Purchase          from '../models/Purchase.js';
import Payment           from '../models/Payment.js';
import Vendor            from '../models/Vendor.js';

// ─── Party resolution (shared by AP Aging + the party-filtered Ledger) ─────────
//
// A "party" is the vendor/counterparty behind an AP line. The SAME resolution is
// used by getPayablesAging and getAccountLedger so a party's aging total always
// reconciles with its ledger balance. Key scheme:
//
//   v:<vendorId>         vendor — from the source purchase/payment
//                        or any journal entry's explicit partyVendor tag. Both map to
//                        the same key so a tagged entry groups WITH that vendor's
//                        auto-posted lines.
//   n:<lowercased name>  explicit free-text party tag, else the legacy manual
//                        line-notes fallback. Legacy system receivables are also
//                        recognized from their source module/line description.
//   unspecified          no vendor / tag / note.
//
// Rows must carry entry-level { sourceModule, sourceId, party, partyVendor } and
// line-level { notes }.

/**
 * Batch-load the vendor of every referenced source document plus the names of all
 * referenced vendors, then return a synchronous partyOf(row) → { key, name }.
 * Async because it hits the DB once up-front; the returned function is pure.
 */
export const buildPartyResolver = async (rows) => {
  const purchaseIds = []; const payIds = []; const seenSrc = new Set();
  for (const row of rows) {
    if (!row.sourceId) continue;
    const k = `${row.sourceModule}:${row.sourceId}`;
    if (seenSrc.has(k)) continue;
    seenSrc.add(k);
    if (row.sourceModule === 'purchase') purchaseIds.push(row.sourceId);
    else if (row.sourceModule === 'payment') payIds.push(row.sourceId);
  }

  const [directPurchaseDocs, payDocs] = await Promise.all([
    purchaseIds.length ? Purchase.find({ _id: { $in: purchaseIds } }).select('vendor').lean() : [],
    payIds.length ? Payment.find({ _id: { $in: payIds } }).select('vendor purchase').lean() : [],
  ]);

  // Older payments may have been recorded before a vendor was assigned to their
  // purchase. Resolve those through the linked purchase as a compatibility
  // fallback, while newer synchronized payment.vendor values remain authoritative.
  const fallbackPurchaseIds = [...new Set(
    payDocs
      .filter((payment) => !payment.vendor && payment.purchase)
      .map((payment) => payment.purchase.toString()),
  )];
  const fallbackPurchaseDocs = fallbackPurchaseIds.length
    ? await Purchase.find({ _id: { $in: fallbackPurchaseIds } }).select('vendor').lean()
    : [];
  const purchaseDocs = [...directPurchaseDocs, ...fallbackPurchaseDocs];
  const purchaseVendor = new Map(
    purchaseDocs
      .filter((purchase) => purchase.vendor)
      .map((purchase) => [purchase._id.toString(), purchase.vendor.toString()]),
  );

  const srcVendor = new Map(); // sourceId(str) → vendorId(str)
  for (const purchase of directPurchaseDocs) {
    if (purchase.vendor) srcVendor.set(purchase._id.toString(), purchase.vendor.toString());
  }
  for (const payment of payDocs) {
    const vendor = payment.vendor?.toString()
      || purchaseVendor.get(payment.purchase?.toString());
    if (vendor) srcVendor.set(payment._id.toString(), vendor);
  }

  // Vendor names needed = source-doc vendors + explicit entry partyVendors.
  const taggedVendorIds = rows.filter((r) => r.partyVendor).map((r) => r.partyVendor.toString());
  const vendorIds = [...new Set([...srcVendor.values(), ...taggedVendorIds])];
  const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds } }).select('name').lean() : [];
  const vendorName = new Map(vendors.map((v) => [v._id.toString(), v.name]));

  return (row) => {
    // 1. Vendor from the source purchase/payment.
    const srcVid = row.sourceId ? srcVendor.get(row.sourceId.toString()) : null;
    if (srcVid) return { key: `v:${srcVid}`, name: vendorName.get(srcVid) || 'Unknown vendor' };

    // 2. Backward compatibility for system-generated receivables created before
    // party tags were added. Only the relevant AR line matches these descriptions,
    // so a salary journal that also recovers another receivable is not misgrouped.
    const systemText = `${row.description ?? ''} ${row.notes ?? ''}`;
    if (row.sourceModule === 'pos' && /food\s*panda\s+receivable/i.test(systemText)) {
      return { key: 'n:food panda sales', name: 'Food Panda Sales' };
    }
    if (
      row.sourceModule === 'salaryAdvance'
      || (row.sourceModule === 'salary' && /advance recovered/i.test(systemText))
    ) {
      return { key: 'n:salary advance', name: 'Salary Advance' };
    }

    // 3. An explicit PARTY tag on any module. A partyVendor groups the entry WITH
    //    that vendor's purchase/payment lines (same v:<id> key); a free-text party
    //    groups by its own name. Source-document vendors above remain authoritative.
    if (row.partyVendor) {
      const vid = row.partyVendor.toString();
      return { key: `v:${vid}`, name: vendorName.get(vid) || 'Unknown vendor' };
    }
    if ((row.party ?? '').trim()) {
      const p = row.party.trim();
      return { key: `n:${p.toLowerCase()}`, name: p };
    }
    // 4. Legacy fallback: line notes on a manual entry (system refs never qualify).
    const isManual = !row.sourceModule || row.sourceModule === 'manual';
    const note = (row.notes ?? '').trim();
    if (isManual && note) return { key: `n:${note.toLowerCase()}`, name: note };
    return { key: 'unspecified', name: 'Unspecified' };
  };
};

/**
 * Best-effort display name from a party key alone — only used when a party filter
 * yields zero matching rows (so the resolver produced no name). The real name is
 * always preferred: resolver name → caller-supplied partyName → this.
 */
export const derivePartyName = (key) => {
  if (!key || key === 'unspecified') return 'Unspecified';
  if (key.startsWith('n:')) return key.slice(2);
  if (key.startsWith('v:')) return 'Vendor';
  return key;
};
