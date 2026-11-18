const hasConfiguredPrice = (value) => value !== null && value !== undefined && value !== '';

// Server-authoritative menu pricing. Client-supplied unit prices are never used.
// Existing items without a platform price continue to use their standard price.
export const resolveMenuUnitPrice = (menuItem, variation, orderType = 'dine-in') => {
  const source = variation || menuItem;
  if (orderType === 'foodpanda' && hasConfiguredPrice(source?.foodPandaPrice)) {
    return Number(source.foodPandaPrice);
  }
  return Number(source?.price || 0);
};
