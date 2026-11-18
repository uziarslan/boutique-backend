import { describe, expect, it } from 'vitest';
import { remainingLocationQueueDepth } from './riderTrackingUpload.service.js';

describe('remainingLocationQueueDepth', () => {
  it('clears the dashboard queue when the complete phone queue was accepted', () => {
    expect(remainingLocationQueueDepth(3, 3)).toBe(0);
  });

  it('reports points that remain after a 100-point upload batch', () => {
    expect(remainingLocationQueueDepth(145, 100)).toBe(45);
  });

  it('never reports a negative or invalid queue depth', () => {
    expect(remainingLocationQueueDepth(2, 10)).toBe(0);
    expect(remainingLocationQueueDepth(undefined, 10)).toBe(0);
  });
});
