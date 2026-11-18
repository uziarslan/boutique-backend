export const remainingLocationQueueDepth = (reportedQueueDepth, batchSize) => {
  const depth = Number(reportedQueueDepth);
  const sent = Number(batchSize);
  if (!Number.isFinite(depth) || depth < 0) return 0;
  if (!Number.isFinite(sent) || sent < 0) return Math.min(1000, Math.round(depth));
  return Math.min(1000, Math.max(0, Math.round(depth) - Math.round(sent)));
};

export default remainingLocationQueueDepth;
