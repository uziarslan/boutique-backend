import { describe, expect, it } from 'vitest';
import { riderTrackingHealth, riderTrackingThresholds } from './riderTrackingHealth.service.js';

const secondsAgo = (seconds) => new Date(Date.now() - seconds * 1000);

describe('riderTrackingHealth', () => {
  it('keeps GPS delay distinct from a fully offline phone', () => {
    const shift = {
      lastLocation: { recordedAt: secondsAgo(450) },
      lastLocationReceivedAt: secondsAgo(450),
    };
    const device = { lastSeenAt: secondsAgo(10), trackingEnabled: true };
    const health = riderTrackingHealth({ shift, device, staleAfterSeconds: 120 });

    expect(health.trackingState).toBe('delayed');
    expect(health.trackingOnline).toBe(true);
    expect(health.locationUsable).toBe(false);
  });

  it('reports the service online but GPS unavailable when heartbeats continue without locations', () => {
    const shift = {
      lastLocation: { recordedAt: secondsAgo(1000) },
      lastLocationReceivedAt: secondsAgo(1000),
    };
    const device = { lastSeenAt: secondsAgo(10), trackingEnabled: true };
    const health = riderTrackingHealth({ shift, device, staleAfterSeconds: 120 });

    expect(health.trackingState).toBe('gps_unavailable');
    expect(health.deviceOnline).toBe(true);
    expect(health.trackingOnline).toBe(true);
    expect(health.locationUsable).toBe(false);
  });

  it('reports offline only after both device and GPS signals expire', () => {
    const shift = {
      lastLocation: { recordedAt: secondsAgo(2000) },
      lastLocationReceivedAt: secondsAgo(2000),
    };
    const device = { lastSeenAt: secondsAgo(2000), trackingEnabled: true };
    const health = riderTrackingHealth({ shift, device, staleAfterSeconds: 120 });

    expect(health.trackingState).toBe('offline');
    expect(health.trackingOnline).toBe(false);
  });

  it('uses a strict location window for nearest-rider assignment', () => {
    expect(riderTrackingThresholds(120)).toEqual({
      delayedAfterSeconds: 120,
      offlineAfterSeconds: 900,
      usableLocationAfterSeconds: 300,
    });
  });
});
