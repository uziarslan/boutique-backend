import Counter from '../models/Counter.js';

export const transactionBusinessDateKey = (businessDate) => {
  const value = String(businessDate || '').trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('A valid YYYY-MM-DD business date is required to generate a transaction number.');
  }
  return value.replace(/-/g, '');
};

const generateTransactionNumber = async (businessDate) => {
  const key = `TXN-${transactionBusinessDateKey(businessDate)}`;
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `${key}-${String(doc.seq).padStart(4, '0')}`;
};

export default generateTransactionNumber;
