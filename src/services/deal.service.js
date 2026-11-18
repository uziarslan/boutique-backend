import MenuItem from '../models/MenuItem.js';

const fail = (message, statusCode = 422) => {
  throw Object.assign(new Error(message), { statusCode });
};

const idOf = (value) => (value?._id ?? value)?.toString?.() ?? '';
const sorted = (values = []) => [...values].sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));

export const getDealComponentIds = (menuItems = []) => {
  const ids = new Set();
  for (const item of menuItems) {
    if (item?.itemType !== 'deal') continue;
    for (const component of item.dealConfig?.fixedItems ?? []) {
      if (idOf(component.menuItem)) ids.add(idOf(component.menuItem));
    }
    for (const group of item.dealConfig?.choiceGroups ?? []) {
      for (const option of group.options ?? []) {
        if (idOf(option.menuItem)) ids.add(idOf(option.menuItem));
      }
    }
  }
  return [...ids];
};

export const isDealCurrentlyAvailable = (item) => {
  if (item?.itemType !== 'deal') return true;
  const fixedItems = item.dealConfig?.fixedItems ?? [];
  const groups = item.dealConfig?.choiceGroups ?? [];
  const componentAvailable = (component) => {
    const componentItem = component.menuItem;
    if (!componentItem || componentItem.isAvailable === false) return false;
    const variations = componentItem.variations || [];
    if (variations.length) {
      return Boolean(component.variationId) && variations.some((variation) => (
        idOf(variation) === idOf(component.variationId)
      ));
    }
    return !component.variationId;
  };
  if (!fixedItems.length && !groups.length) return false;
  if (fixedItems.some((component) => !componentAvailable(component))) return false;
  return groups.every((group) => {
    const availableOptions = (group.options || []).filter(componentAvailable).length;
    return (Number(group.minSelections) || 0) === 0 || availableOptions > 0;
  });
};

export const loadDealComponentMap = async (menuItems = []) => {
  const ids = getDealComponentIds(menuItems);
  if (!ids.length) return new Map();

  const components = await MenuItem.find({ _id: { $in: ids } })
    .populate('category', 'name')
    .populate('ingredients.product', 'name unit')
    .populate('variations.ingredients.product', 'name unit')
    .lean();

  return new Map(components.map((component) => [idOf(component), component]));
};

const resolveConfiguredComponent = (configured, componentMap, context, allowUnavailable = false) => {
  const item = componentMap.get(idOf(configured.menuItem));
  if (!item) fail(`${context} references a menu item that no longer exists.`);
  if (item.itemType === 'deal') fail(`${context} cannot contain another deal.`);
  if (!allowUnavailable && !item.isAvailable) fail(`"${item.name}" in ${context.toLowerCase()} is currently unavailable.`);

  const variations = item.variations ?? [];
  let variation = null;
  if (variations.length) {
    if (!configured.variationId) fail(`${context}: choose a size for "${item.name}".`);
    variation = variations.find((candidate) => idOf(candidate) === idOf(configured.variationId));
    if (!variation) fail(`${context}: the selected size for "${item.name}" is no longer available.`);
  } else if (configured.variationId) {
    fail(`${context}: "${item.name}" no longer has the configured size.`);
  }

  return {
    menuItem: item._id,
    categoryId: item.category?._id ?? item.category ?? undefined,
    categoryName: item.category?.name ?? null,
    variation: variation ? { id: variation._id, name: variation.name } : undefined,
    name: item.name,
    qtyPerDeal: Number(configured.qty) || 1,
    _trackInventory: Boolean(item.trackInventory),
    _menuItemFull: item,
    _recipeIngredients: variation ? (variation.ingredients ?? []) : (item.ingredients ?? []),
  };
};

/**
 * Resolve a live deal against submitted customer selections. Option IDs and
 * price adjustments are read from the menu item, never trusted from a client.
 */
export const resolveDeal = (menuItem, rawSelections, componentMap, { allowUnavailable = false } = {}) => {
  if (menuItem?.itemType !== 'deal') {
    if ((rawSelections ?? []).length) fail(`"${menuItem?.name ?? 'This item'}" is not a deal.`);
    return { priceAdjustment: 0, dealSelections: [], dealComponents: [] };
  }

  const fixedItems = sorted(menuItem.dealConfig?.fixedItems ?? []);
  const groups = sorted(menuItem.dealConfig?.choiceGroups ?? []);
  if (!fixedItems.length && !groups.length) fail(`"${menuItem.name}" has no deal components configured.`);

  const supplied = Array.isArray(rawSelections) ? rawSelections : [];
  const suppliedByGroup = new Map();
  for (const selection of supplied) {
    const groupId = idOf(selection.groupId);
    if (!groupId || suppliedByGroup.has(groupId)) fail(`Invalid duplicate choice group for "${menuItem.name}".`);
    suppliedByGroup.set(groupId, selection.optionIds ?? []);
  }

  const validGroupIds = new Set(groups.map(idOf));
  for (const groupId of suppliedByGroup.keys()) {
    if (!validGroupIds.has(groupId)) fail(`A selected choice for "${menuItem.name}" is no longer available.`);
  }

  const dealComponents = fixedItems.map((configured) => ({
    ...resolveConfiguredComponent(configured, componentMap, `Deal "${menuItem.name}"`, allowUnavailable),
    source: 'fixed',
    groupId: null,
    groupName: null,
    optionId: null,
    priceAdjustment: 0,
  }));
  const dealSelections = [];
  let priceAdjustment = 0;

  for (const group of groups) {
    const groupId = idOf(group);
    const selectedIds = (suppliedByGroup.get(groupId) ?? []).map(idOf).filter(Boolean);

    const min = Number(group.minSelections) || 0;
    const max = Number(group.maxSelections) || 1;
    if (selectedIds.length < min || selectedIds.length > max) {
      const requirement = min === max
        ? `choose ${min}`
        : `choose between ${min} and ${max}`;
      fail(`For "${group.name}", ${requirement} option${max === 1 ? '' : 's'}.`);
    }

    const optionById = new Map((group.options ?? []).map((option) => [idOf(option), option]));
    const optionCounts = new Map();
    for (const optionId of selectedIds) optionCounts.set(optionId, (optionCounts.get(optionId) || 0) + 1);
    for (const [optionId, selectionCount] of optionCounts) {
      const option = optionById.get(optionId);
      if (!option) fail(`An option in "${group.name}" is no longer available.`);
      const adjustment = (Number(option.priceAdjustment) || 0) * selectionCount;
      const resolvedComponent = resolveConfiguredComponent(option, componentMap, `Choice group "${group.name}"`, allowUnavailable);
      priceAdjustment += adjustment;
      dealComponents.push({
        ...resolvedComponent,
        qtyPerDeal: resolvedComponent.qtyPerDeal * selectionCount,
        source: 'choice',
        groupId: group._id,
        groupName: group.name,
        optionId: option._id,
        priceAdjustment: adjustment,
      });
    }

    dealSelections.push({
      groupId: group._id,
      groupName: group.name,
      optionIds: selectedIds,
    });
  }

  return {
    priceAdjustment,
    dealSelections,
    dealComponents,
  };
};

/** Validate references when a menu deal is authored or edited. */
export const validateDealConfiguration = async ({ dealConfig, outletId, itemId = null }) => {
  const fixedItems = dealConfig?.fixedItems ?? [];
  const groups = dealConfig?.choiceGroups ?? [];
  if (!fixedItems.length && !groups.length) fail('A deal needs at least one fixed item or choice group.');

  for (const group of groups) {
    const min = Number(group.minSelections) || 0;
    const max = Number(group.maxSelections) || 1;
    if (min > max) fail(`"${group.name}": minimum choices cannot exceed maximum choices.`);
    if (max > 50) fail(`"${group.name}": maximum choices cannot exceed 50.`);
  }

  const ids = getDealComponentIds([{ itemType: 'deal', dealConfig }]);
  if (itemId && ids.includes(itemId.toString())) fail('A deal cannot contain itself.');
  const components = ids.length
    ? await MenuItem.find({ _id: { $in: ids } }).select('name outlet itemType variations').lean()
    : [];
  const byId = new Map(components.map((item) => [idOf(item), item]));

  const allConfigured = [
    ...fixedItems.map((component) => ({ component, label: 'Fixed item' })),
    ...groups.flatMap((group) => (group.options ?? []).map((component) => ({
      component,
      label: `Choice group "${group.name}"`,
    }))),
  ];

  for (const { component, label } of allConfigured) {
    const item = byId.get(idOf(component.menuItem));
    if (!item) fail(`${label} references a menu item that does not exist.`);
    if (idOf(item.outlet) !== idOf(outletId)) fail(`${label} item "${item.name}" belongs to another outlet.`);
    if (item.itemType === 'deal') fail(`${label} cannot contain another deal ("${item.name}").`);
    const variations = item.variations ?? [];
    if (variations.length && !component.variationId) fail(`${label}: choose a size for "${item.name}".`);
    if (component.variationId && !variations.some((variation) => idOf(variation) === idOf(component.variationId))) {
      fail(`${label}: the chosen size for "${item.name}" is invalid.`);
    }
  }
};

// Kitchen/KDS consumers route deal components by the component categories. The
// commercial receipt still keeps the single parent deal line and price.
export const expandDealItemsForKitchen = (items = []) => items.flatMap((item) => {
  if (!Array.isArray(item.dealComponents) || !item.dealComponents.length) return [item];
  return item.dealComponents.map((component) => ({
    menuItem: component.menuItem,
    categoryId: component.categoryId,
    categoryName: component.categoryName,
    variation: component.variation,
    name: `${component.name} [${item.name}]`,
    qty: (Number(item.qty) || 0) * (Number(component.qtyPerDeal) || 1),
    notes: item.notes || '',
    dealName: item.name,
    dealGroupName: component.groupName || null,
  }));
});
