import { beforeAll, describe, expect, it, vi } from 'vitest';
import { requireFeature } from '../middleware/feature.middleware.js';

let attendanceRoutes;
let employeeRoutes;
let posRoutes;
let salaryRoutes;

beforeAll(async () => {
  Object.assign(process.env, {
    MONGO_URI: 'mongodb://127.0.0.1:27017/test',
    JWT_SECRET: 'test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_REFRESH_EXPIRES_IN: '7d',
    PORT: '5000',
    CLIENT_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  });

  [
    { default: attendanceRoutes },
    { default: employeeRoutes },
    { default: posRoutes },
    { default: salaryRoutes },
  ] = await Promise.all([
    import('./attendance.routes.js'),
    import('./employee.routes.js'),
    import('./pos.routes.js'),
    import('./salary.routes.js'),
  ]);
}, 30000);

const routeLayers = (router) => router.stack.filter((layer) => layer.route);
const routePaths = (router) => routeLayers(router).map((layer) => layer.route.path);
const featureKeys = (layer) => layer.route.stack
  .map((middleware) => middleware.handle.featureKey)
  .filter(Boolean);

describe('independent employee and attendance feature routing', () => {
  it('gates every attendance route with Attendance instead of POS', () => {
    expect(routeLayers(attendanceRoutes)).not.toHaveLength(0);
    for (const layer of routeLayers(attendanceRoutes)) {
      expect(featureKeys(layer)).toEqual(['attendance']);
    }
    expect(routePaths(posRoutes).some((path) => String(path).startsWith('/attendance'))).toBe(false);
  });

  it('gates every employee route with Employees instead of Payroll', () => {
    expect(routeLayers(employeeRoutes)).not.toHaveLength(0);
    for (const layer of routeLayers(employeeRoutes)) {
      expect(featureKeys(layer)).toEqual(['employees']);
    }
    expect(routePaths(salaryRoutes).some((path) => String(path).startsWith('/employees'))).toBe(false);
  });

  it('allows Attendance and Employees when POS and Payroll are disabled', async () => {
    const next = vi.fn();
    const status = vi.fn();
    const tenant = {
      outletFeaturesMigratedAt: new Date(),
      outletFeatures: [{
        outletId: 'outlet-a',
        features: {
          pos: false,
          payroll: false,
          attendance: true,
          employees: true,
        },
      }],
    };
    const req = {
      tenant,
      user: { outletRef: 'outlet-a' },
      headers: {},
      query: {},
      body: {},
      params: {},
    };

    await requireFeature('attendance')(req, { status }, next);
    await requireFeature('employees')(req, { status }, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalled();
  });

  it('uses the paired attendance device outlet when checking its feature', async () => {
    const guard = requireFeature('attendance');
    const next = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const tenant = {
      outletFeaturesMigratedAt: new Date(),
      outletFeatures: [
        { outletId: 'outlet-a', features: { attendance: true } },
        { outletId: 'outlet-b', features: { attendance: false } },
      ],
    };

    await guard({
      tenant,
      attendanceDevice: { outletId: 'outlet-b' },
      headers: {},
      query: {},
      body: {},
      params: {},
    }, { status }, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });
});
