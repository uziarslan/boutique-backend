import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES, resolveTenantFeatures } from './features.js';
import {
  normalizeFeatureSnapshot,
  resolveOutletFeatures,
} from '../services/outletFeatures.service.js';

describe('KDS feature defaults', () => {
  it('defaults KDS off for newly created tenants and outlets', () => {
    expect(DEFAULT_FEATURES.kds).toBe(false);
    expect(normalizeFeatureSnapshot({}).kds).toBe(false);
  });

  it('defaults KDS off when legacy tenant and outlet snapshots lack the key', () => {
    expect(resolveTenantFeatures({ purchasing: true }).kds).toBe(false);
    expect(resolveOutletFeatures({
      features: { purchasing: true },
      outletFeatures: [],
      outletFeaturesMigratedAt: null,
    }, 'legacy-outlet').kds).toBe(false);
    expect(resolveOutletFeatures({
      outletFeatures: [{ outletId: 'existing-outlet', features: { purchasing: true } }],
      outletFeaturesMigratedAt: new Date(),
    }, 'existing-outlet').kds).toBe(false);
  });
});
