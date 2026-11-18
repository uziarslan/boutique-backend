import { coordinatesFromGeoPoint, metersBetween } from './riderTracking.service.js';

const idString = (value) => {
  const id = value?._id || value;
  return id == null ? '' : String(id);
};

const timeValue = (value) => {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
};

export const assignmentForRecordedAt = (assignments = [], recordedAt) => {
  const pointTime = timeValue(recordedAt);
  if (!pointTime) return null;
  return assignments
    .filter((assignment) => {
      const start = timeValue(assignment.assignedAt);
      const end = assignment.completedAt ? timeValue(assignment.completedAt) : Number.POSITIVE_INFINITY;
      return start && start <= pointTime && pointTime <= end;
    })
    .sort((a, b) => timeValue(b.assignedAt) - timeValue(a.assignedAt))[0] || null;
};

export const routeDistanceMeters = (points = []) => {
  let total = 0;
  let previous = null;
  for (const point of points) {
    const current = point.latitude != null && point.longitude != null
      ? { latitude: point.latitude, longitude: point.longitude }
      : coordinatesFromGeoPoint(point.location);
    if (!current) continue;
    const segment = previous ? metersBetween(previous, current) : 0;
    // Match the ingestion rules: ignore GPS jitter and impossible jumps.
    if (Number.isFinite(segment) && segment >= 2 && segment <= 5000) total += segment;
    previous = current;
  }
  return total;
};

export const groupAssignmentsByOrder = (assignments = [], routeStats = []) => {
  const statsByAssignment = new Map(routeStats.map((stat) => [idString(stat._id), stat]));
  const groups = new Map();

  for (const assignment of assignments) {
    const orderId = idString(assignment.saleTransaction);
    if (!orderId) continue;
    if (!groups.has(orderId)) groups.set(orderId, []);
    groups.get(orderId).push(assignment);
  }

  return [...groups.entries()].map(([orderId, rows]) => {
    const ordered = [...rows].sort((a, b) => timeValue(a.assignedAt) - timeValue(b.assignedAt));
    const first = ordered[0];
    const latest = ordered[ordered.length - 1];
    const pointStats = ordered.map((assignment) => statsByAssignment.get(idString(assignment._id))).filter(Boolean);
    const routeStartTimes = [
      ...pointStats.map((stat) => timeValue(stat.firstRecordedAt)),
      ...ordered.map((assignment) => timeValue(assignment.routeStartedAt)),
    ].filter(Boolean);
    const routeEndTimes = [
      ...pointStats.map((stat) => timeValue(stat.lastRecordedAt)),
      ...ordered.map((assignment) => timeValue(assignment.routeEndedAt)),
    ].filter(Boolean);
    const active = ordered.some((assignment) => assignment.active === true);
    const completedTimes = ordered.map((assignment) => timeValue(assignment.completedAt)).filter(Boolean);
    return {
      _id: orderId,
      saleTransaction: orderId,
      orderNumber: latest.orderNumber || first.orderNumber,
      customerName: latest.customerName || first.customerName || '',
      customerPhone: latest.customerPhone || first.customerPhone || '',
      deliveryAddress: latest.deliveryAddress || first.deliveryAddress || null,
      totalAmount: latest.totalAmount ?? first.totalAmount ?? 0,
      deliveryRunId: latest.deliveryRunId || first.deliveryRunId || '',
      routeSequence: Number(latest.routeSequence || first.routeSequence || 0),
      pickupState: latest.pickupState || first.pickupState || 'queued_at_restaurant',
      status: latest.deliveryOutcome || latest.status,
      active,
      assignedAt: first.assignedAt,
      completedAt: active || !completedTimes.length ? null : new Date(Math.max(...completedTimes)),
      latestAssignedAt: latest.assignedAt,
      assignments: ordered,
      routePointCount: pointStats.reduce((sum, stat) => sum + Number(stat.pointCount || 0), 0)
        || ordered.reduce((sum, assignment) => sum + Number(assignment.routePointCount || 0), 0),
      routeStartedAt: routeStartTimes.length ? new Date(Math.min(...routeStartTimes)) : null,
      routeEndedAt: routeEndTimes.length ? new Date(Math.max(...routeEndTimes)) : null,
    };
  }).sort((a, b) => timeValue(b.latestAssignedAt) - timeValue(a.latestAssignedAt));
};

export default {
  assignmentForRecordedAt,
  groupAssignmentsByOrder,
  routeDistanceMeters,
};
