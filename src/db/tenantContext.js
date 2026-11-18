import { AsyncLocalStorage } from 'async_hooks';

// Per-request store. Whatever runs inside `als.run(store, fn)` (and any
// promise/callback descended from it) can read the same store via getStore().
// Used to thread the active tenant's mongoose Connection through controllers
// without changing call sites — the model proxy looks here on every method
// access.
export const tenantContext = new AsyncLocalStorage();

export const runWithTenant = (store, fn) => tenantContext.run(store, fn);

export const getTenantStore = () => tenantContext.getStore();

export const getTenantConnection = () => {
  const store = tenantContext.getStore();
  if (!store?.conn) {
    throw new Error(
      'No tenant connection in context. attachTenant middleware must run before model access.'
    );
  }
  return store.conn;
};
