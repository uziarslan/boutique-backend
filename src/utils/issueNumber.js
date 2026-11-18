import Counter from '../models/Counter.js';

const generateIssueNumber = async (prefix = 'ISS') => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `${prefix}-${today}`;
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `${key}-${String(doc.seq).padStart(4, '0')}`;
};

export default generateIssueNumber;
