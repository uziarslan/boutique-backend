import { getTenantConnection } from './tenantContext.js';

// Registry of every tenant-scoped schema, keyed by model name. The tenant
// connection registry walks this on first use of a connection and registers
// every schema so populate/refs work across models.
export const tenantSchemas = new Map();

/**
 * Replaces `mongoose.model('Name', schema)` for tenant-scoped models.
 *
 * Returns a Proxy that, on every property access, looks up the active tenant
 * connection from AsyncLocalStorage and forwards to the connection-bound
 * model. Existing call sites like `Vendor.find(...)` keep working unchanged.
 *
 * Statics, hooks, virtuals, and middleware all live on the schema, so they
 * work on every connection that registers the schema.
 */
export const defineModel = (name, schema) => {
  if (tenantSchemas.has(name) && tenantSchemas.get(name) !== schema) {
    throw new Error(`Duplicate tenant model registration for "${name}".`);
  }
  tenantSchemas.set(name, schema);

  const resolve = () => {
    const conn = getTenantConnection();
    return conn.models[name] || conn.model(name, schema);
  };

  return new Proxy(function () {}, {
    get(_target, prop) {
      const model = resolve();
      const value = model[prop];
      return typeof value === 'function' ? value.bind(model) : value;
    },
    set(_target, prop, value) {
      const model = resolve();
      model[prop] = value;
      return true;
    },
    construct(_target, args) {
      const model = resolve();
      // eslint-disable-next-line new-cap
      return new model(...args);
    },
    apply(_target, _thisArg, args) {
      const model = resolve();
      return model(...args);
    },
    has(_target, prop) {
      return prop in resolve();
    },
  });
};
