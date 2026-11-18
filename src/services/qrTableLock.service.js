import crypto from 'node:crypto';
import Table from '../models/Table.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mongo-backed rather than process-local so the invariant survives multiple
// Heroku web dynos. The lock expires after a crash and serialises only work for
// the same physical table.
export const withQrTableLock = async (tableId, work) => {
  const token = crypto.randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = new Date();
    const locked = await Table.findOneAndUpdate(
      {
        _id: tableId,
        $or: [
          { '_qrOrderLock.expiresAt': { $lte: now } },
          { _qrOrderLock: { $exists: false } },
          { '_qrOrderLock.token': token },
        ],
      },
      {
        $set: {
          _qrOrderLock: {
            token,
            expiresAt: new Date(now.getTime() + 120_000),
          },
        },
      },
      { returnDocument: 'after' },
    ).select('+_qrOrderLock').lean();
    acquired = locked?._qrOrderLock?.token === token;
    if (acquired) break;
    await wait(40 + attempt * 10);
  }

  if (!acquired) {
    throw Object.assign(
      new Error('Another order is being updated for this table. Please try again.'),
      { statusCode: 409, code: 'QR_TABLE_BUSY' },
    );
  }

  try {
    return await work();
  } finally {
    await Table.updateOne(
      { _id: tableId, '_qrOrderLock.token': token },
      { $unset: { _qrOrderLock: '' } },
    ).catch(() => {});
  }
};
