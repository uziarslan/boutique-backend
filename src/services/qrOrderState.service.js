import Outlet from '../models/Outlet.js';

const DEFAULT_PREPARATION_MINUTES = 20;

const validDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
};

const boundedMinutes = (value, fallback = DEFAULT_PREPARATION_MINUTES) => {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.min(240, Math.max(0, minutes)) : fallback;
};

const idOf = (value) => (value ? String(value?._id || value) : '');

const uniqueIds = (values = []) => [...new Set(values.map(idOf).filter(Boolean))];

const stageData = (stage, now) => {
  const readyAt = validDate(stage?.readyAt);
  return {
    key: stage?.key || 'default',
    name: stage?.name || 'Kitchen',
    preparationMinutes: boundedMinutes(stage?.preparationMinutes),
    kitchenStartedAt: stage?.kitchenStartedAt || null,
    readyAt: stage?.readyAt || null,
    status: readyAt && readyAt.getTime() <= now.getTime() ? 'ready' : 'in-kitchen',
  };
};

const storedPreparationCategories = (order) => {
  const stored = order?.qrOrder?.preparationCategories;
  if (Array.isArray(stored) && stored.length > 0) return stored;

  // Existing QR orders created before preparation categories were introduced
  // retain their original single estimate and display as Kitchen.
  if (order?.qrOrder?.readyAt) {
    const startedAt = validDate(order.qrOrder.kitchenStartedAt);
    const readyAt = validDate(order.qrOrder.readyAt);
    const minutes = startedAt && readyAt
      ? Math.max(0, Math.round((readyAt.getTime() - startedAt.getTime()) / 60_000))
      : DEFAULT_PREPARATION_MINUTES;
    return [{
      key: 'default',
      name: 'Kitchen',
      preparationMinutes: minutes,
      kitchenStartedAt: order.qrOrder.kitchenStartedAt,
      readyAt: order.qrOrder.readyAt,
    }];
  }
  return [];
};

export const deriveQrFulfillmentStatus = (order, now = new Date()) => {
  if (order?.status === 'void') return 'declined';
  if (order?.status === 'completed' || order?.status === 'refunded') return 'settled';
  if (order?.status === 'pending-approval' || order?.qrOrder?.pendingAddOn?.items?.length) {
    return 'awaiting-confirmation';
  }
  if (!order?.kitchenPrintedAt) return 'confirmed';

  const stages = storedPreparationCategories(order);
  if (stages.length > 0) {
    const allReady = stages.every((stage) => {
      const readyAt = validDate(stage.readyAt);
      return readyAt && readyAt.getTime() <= now.getTime();
    });
    return allReady ? 'ready' : 'in-kitchen';
  }

  const readyAt = validDate(order?.qrOrder?.readyAt);
  if (readyAt && readyAt.getTime() <= now.getTime()) return 'ready';
  return 'in-kitchen';
};

export const qrOrderTimingData = (order, now = new Date()) => ({
  fulfillmentStatus: deriveQrFulfillmentStatus(order, now),
  kitchenStartedAt: order?.qrOrder?.kitchenStartedAt || null,
  readyAt: order?.qrOrder?.readyAt || null,
  preparationCategories: storedPreparationCategories(order).map((stage) => stageData(stage, now)),
  serverNow: now,
});

const categoryDefinitionsForOrder = (order, outlet, printedAt) => {
  const configured = Array.isArray(outlet?.qrOrdering?.preparationCategories)
    ? outlet.qrOrdering.preparationCategories
    : [];
  const orderCategoryIds = uniqueIds((order.items || []).map((item) => item.categoryId));
  const orderCategorySet = new Set(orderCategoryIds);
  const mappedIds = new Set();

  const definitions = configured.flatMap((category) => {
    const assignedIds = uniqueIds(category.menuCategoryIds);
    const matchedIds = assignedIds.filter((id) => orderCategorySet.has(id));
    matchedIds.forEach((id) => mappedIds.add(id));
    if (matchedIds.length === 0) return [];
    return [{
      key: idOf(category._id),
      name: category.name,
      preparationMinutes: boundedMinutes(category.preparationMinutes),
      menuCategoryIds: matchedIds,
    }];
  });

  const unmatchedIds = orderCategoryIds.filter((id) => !mappedIds.has(id));
  const hasUnassignedItem = (order.items || []).some((item) => !idOf(item.categoryId));
  if (unmatchedIds.length > 0 || hasUnassignedItem || definitions.length === 0) {
    const kitchenAlreadyDisplayed = definitions.some((definition) =>
      String(definition.name || '').trim().toLocaleLowerCase() === 'kitchen');
    definitions.push({
      key: 'default',
      name: kitchenAlreadyDisplayed ? 'Other' : 'Kitchen',
      preparationMinutes: boundedMinutes(outlet?.qrOrdering?.preparationMinutes),
      menuCategoryIds: unmatchedIds,
      isFallback: true,
    });
  }

  return definitions.map((definition) => ({
    ...definition,
    kitchenStartedAt: printedAt,
    readyAt: new Date(printedAt.getTime() + (definition.preparationMinutes * 60_000)),
  }));
};

// Called only after the print connector confirms that the kitchen ticket was
// accepted. Initial orders start every applicable area. Add-ons restart only
// the areas receiving new items, leaving all other countdowns untouched.
export const stampQrKitchenTiming = async (order, printedAt = new Date()) => {
  if (order?.source !== 'qr-self-order') return order;
  const outlet = await Outlet.findById(order.outlet)
    .select('qrOrdering.preparationMinutes qrOrdering.preparationCategories')
    .lean();

  order.qrOrder = order.qrOrder || {};
  const next = categoryDefinitionsForOrder(order, outlet, printedAt);
  const previous = new Map(
    (order.qrOrder.preparationCategories || []).map((category) => [String(category.key), category]),
  );
  const affectedIds = new Set(uniqueIds(order.qrOrder.pendingKitchenCategoryIds));
  const hasExplicitPendingScope = affectedIds.size > 0 || Boolean(order.qrOrder.pendingKitchenHasUnassigned);

  const merged = next.map((category) => {
    const old = previous.get(String(category.key));
    if (!old || !hasExplicitPendingScope) return category;
    const affectedById = category.menuCategoryIds.some((id) => affectedIds.has(String(id)));
    const affectedByUnassigned = Boolean(order.qrOrder.pendingKitchenHasUnassigned && category.isFallback);
    return affectedById || affectedByUnassigned ? category : {
      key: old.key,
      name: old.name,
      preparationMinutes: old.preparationMinutes,
      menuCategoryIds: old.menuCategoryIds,
      kitchenStartedAt: old.kitchenStartedAt,
      readyAt: old.readyAt,
    };
  });

  order.qrOrder.preparationCategories = merged.map(({ isFallback, ...category }) => category);
  const starts = merged.map((category) => validDate(category.kitchenStartedAt)).filter(Boolean);
  const finishes = merged.map((category) => validDate(category.readyAt)).filter(Boolean);
  order.qrOrder.kitchenStartedAt = starts.length > 0
    ? new Date(Math.min(...starts.map((date) => date.getTime())))
    : printedAt;
  order.qrOrder.readyAt = finishes.length > 0
    ? new Date(Math.max(...finishes.map((date) => date.getTime())))
    : printedAt;
  order.qrOrder.pendingKitchenCategoryIds = [];
  order.qrOrder.pendingKitchenHasUnassigned = false;
  return order;
};
