import { createHash } from 'crypto';

export const praJobId = (eventKey, attempt) => {
  const digest = createHash('sha256').update(String(eventKey)).digest('hex').slice(0, 32);
  return `pra-${digest}-${Math.max(1, Number(attempt) || 1)}`;
};
