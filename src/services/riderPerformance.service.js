const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const eventAt = (assignment, status) => {
  const events = Array.isArray(assignment?.statusHistory) ? assignment.statusHistory : [];
  const match = [...events].reverse().find((event) => event?.status === status && event?.at);
  if (!match) return null;
  const value = new Date(match.at);
  return Number.isFinite(value.getTime()) ? value : null;
};

export const deliveryTimingFromAssignment = (assignment) => {
  const pickedUpAt = eventAt(assignment, 'picked_up');
  const customerDeliveredAt = eventAt(assignment, 'delivered');
  const returnedEventAt = eventAt(assignment, 'returned_to_restaurant');
  const completedAt = assignment?.completedAt ? new Date(assignment.completedAt) : null;
  const returnedAt = returnedEventAt
    || (completedAt && Number.isFinite(completedAt.getTime()) ? completedAt : null);
  const duration = pickedUpAt && returnedAt
    ? Math.max(0, Math.round((returnedAt.getTime() - pickedUpAt.getTime()) / 1000))
    : null;
  return { pickedUpAt, customerDeliveredAt, returnedAt, deliveryDurationSeconds: duration };
};

const scoreLowerIsBetter = (value, values) => {
  if (value == null) return null;
  const numeric = values.filter((item) => item != null && Number.isFinite(item));
  if (!numeric.length) return null;
  if (value === 0) return 100;
  const positive = numeric.filter((item) => item > 0);
  if (!positive.length) return 100;
  return Math.min(100, (Math.min(...positive) / value) * 100);
};

export const buildRiderPerformance = (deliveries = []) => {
  const grouped = new Map();
  for (const delivery of deliveries) {
    const riderId = String(delivery?.rider?._id || delivery?.rider || '');
    if (!riderId) continue;
    if (!grouped.has(riderId)) {
      grouped.set(riderId, {
        rider: {
          _id: riderId,
          name: delivery?.rider?.name || delivery?.riderName || 'Rider',
          email: delivery?.rider?.email || '',
        },
        deliveries: 0,
        ratedDeliveries: 0,
        chargedDeliveries: 0,
        durationTotal: 0,
        durationCount: 0,
        behaviorTotal: 0,
        totalRiderChargeAmount: 0,
      });
    }
    const row = grouped.get(riderId);
    row.deliveries += 1;
    const duration = numberOrNull(delivery.deliveryDurationSeconds);
    if (duration != null && duration >= 0) {
      row.durationTotal += duration;
      row.durationCount += 1;
    }
    const rating = numberOrNull(delivery.review?.behaviorRating);
    if (rating != null) {
      row.behaviorTotal += rating;
      row.ratedDeliveries += 1;
    }
    const charge = numberOrNull(delivery.review?.riderChargeAmount);
    if (charge != null) {
      row.totalRiderChargeAmount += Math.max(0, charge);
      row.chargedDeliveries += 1;
    }
  }

  const rows = [...grouped.values()].map((row) => ({
    rider: row.rider,
    deliveries: row.deliveries,
    ratedDeliveries: row.ratedDeliveries,
    chargedDeliveries: row.chargedDeliveries,
    averageDeliverySeconds: row.durationCount ? Math.round(row.durationTotal / row.durationCount) : null,
    averageBehaviorRating: row.ratedDeliveries
      ? Math.round((row.behaviorTotal / row.ratedDeliveries) * 100) / 100
      : null,
    totalRiderChargeAmount: Math.round(row.totalRiderChargeAmount * 100) / 100,
    averageRiderChargeAmount: row.chargedDeliveries
      ? Math.round((row.totalRiderChargeAmount / row.chargedDeliveries) * 100) / 100
      : null,
    eligible: row.ratedDeliveries > 0 || row.chargedDeliveries > 0,
  }));

  const maximumDeliveries = Math.max(0, ...rows.map((row) => row.deliveries));
  const durations = rows.map((row) => row.averageDeliverySeconds);
  const expenses = rows
    .filter((row) => row.chargedDeliveries > 0)
    .map((row) => row.totalRiderChargeAmount);

  for (const row of rows) {
    if (!row.eligible) {
      row.score = null;
      continue;
    }
    const components = [
      { weight: 30, value: maximumDeliveries ? (row.deliveries / maximumDeliveries) * 100 : null },
      { weight: 30, value: scoreLowerIsBetter(row.averageDeliverySeconds, durations) },
      { weight: 20, value: row.chargedDeliveries ? scoreLowerIsBetter(row.totalRiderChargeAmount, expenses) : null },
      { weight: 20, value: row.averageBehaviorRating == null ? null : (row.averageBehaviorRating / 5) * 100 },
    ].filter((component) => component.value != null);
    const weight = components.reduce((sum, component) => sum + component.weight, 0);
    row.score = weight
      ? Math.round((components.reduce((sum, component) => sum + (component.value * component.weight), 0) / weight) * 10) / 10
      : null;
  }

  rows.sort((a, b) => {
    if (a.score == null && b.score != null) return 1;
    if (a.score != null && b.score == null) return -1;
    if (a.score !== b.score) return Number(b.score || 0) - Number(a.score || 0);
    if (a.deliveries !== b.deliveries) return b.deliveries - a.deliveries;
    return a.rider.name.localeCompare(b.rider.name);
  });
  return rows.map((row, index) => ({ ...row, rank: row.score == null ? null : index + 1 }));
};

export default { deliveryTimingFromAssignment, buildRiderPerformance };
