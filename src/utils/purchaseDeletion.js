export const buildPurchaseJournalDeletionIds = (primaryJournals = [], reversalJournals = []) => {
  const expectedReversals = new Set(
    primaryJournals.map((entry) => entry.reversedBy).filter(Boolean).map(String),
  );
  const foundReversals = new Set(reversalJournals.map((entry) => String(entry._id)));
  if (
    expectedReversals.size !== foundReversals.size
    || [...expectedReversals].some((id) => !foundReversals.has(id))
  ) {
    const error = new Error('A linked journal has incomplete reversal history and cannot be deleted safely.');
    error.statusCode = 409;
    throw error;
  }
  return [...new Set([...primaryJournals, ...reversalJournals].map((entry) => String(entry._id)))];
};

export const runPurchaseDeletionRollback = async (steps = []) => {
  const errors = [];
  for (const step of [...steps].reverse()) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
};
