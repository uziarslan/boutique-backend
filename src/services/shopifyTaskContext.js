import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const withShopifyTask = (check, work) => {
  const parent = context.getStore();
  return context.run(async () => {
    if (parent) await parent();
    await check();
  }, work);
};
export const checkShopifyTask = async () => {
  const check = context.getStore();
  if (check) await check();
};
