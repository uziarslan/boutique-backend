import { randomUUID } from 'node:crypto';
import DeliveryAssignment from '../models/DeliveryAssignment.js';
import { coordinatesFromGeoPoint } from './riderTracking.service.js';

const idString = (value) => String(value?._id || value || '');

const locationValue = (value) => {
  const coordinates = value?.latitude != null && value?.longitude != null
    ? value
    : coordinatesFromGeoPoint(value?.location || value);
  if (!coordinates) return undefined;
  return { latitude: coordinates.latitude, longitude: coordinates.longitude };
};

export const assignmentRunDefaults = async ({ riderId, shift, now = new Date() }) => {
  if (!shift?.inOutletGeofence) {
    return {
      deliveryRunId: '',
      pickupState: 'queued_at_restaurant',
      queuedAtRestaurantAt: now,
      readyForPickupAt: null,
      runStartedAt: null,
    };
  }

  const currentRun = await DeliveryAssignment.findOne({
    rider: riderId,
    active: true,
    status: { $in: ['assigned', 'accepted', 'picked_up'] },
    pickupState: { $in: ['ready_for_pickup', 'with_rider'] },
    deliveryRunId: { $ne: '' },
  }).select('deliveryRunId pickupState readyForPickupAt runStartedAt').sort({ assignedAt: -1 }).lean();

  return {
    deliveryRunId: currentRun?.deliveryRunId || randomUUID(),
    pickupState: currentRun?.pickupState === 'with_rider' ? 'with_rider' : 'ready_for_pickup',
    queuedAtRestaurantAt: null,
    readyForPickupAt: currentRun?.readyForPickupAt || now,
    runStartedAt: currentRun?.runStartedAt || null,
  };
};

export const prepareQueuedAssignmentsAtOutlet = async ({ riderId, at = new Date() }) => {
  const queued = await DeliveryAssignment.find({
    rider: riderId,
    active: true,
    $or: [
      { pickupState: 'queued_at_restaurant' },
      { pickupState: { $exists: false } },
      { pickupState: '' },
    ],
    status: { $in: ['assigned', 'accepted', 'picked_up'] },
  }).select('_id').lean();
  if (!queued.length) return { changed: 0, deliveryRunId: '' };
  const deliveryRunId = randomUUID();
  await DeliveryAssignment.updateMany(
    { _id: { $in: queued.map((row) => row._id) } },
    { $set: { deliveryRunId, pickupState: 'ready_for_pickup', readyForPickupAt: at } },
  );
  return { changed: queued.length, deliveryRunId };
};

export const departWithReadyAssignments = async ({ riderId, at = new Date() }) => {
  const result = await DeliveryAssignment.updateMany(
    {
      rider: riderId,
      active: true,
      pickupState: 'ready_for_pickup',
      status: { $in: ['assigned', 'accepted', 'picked_up'] },
    },
    { $set: { pickupState: 'with_rider', runStartedAt: at } },
  );
  return Number(result.modifiedCount || 0);
};

export const startAssignmentRun = async ({ assignment, at = new Date() }) => {
  let deliveryRunId = assignment.deliveryRunId;
  if (!deliveryRunId) {
    deliveryRunId = randomUUID();
    assignment.deliveryRunId = deliveryRunId;
  }
  const runStartedAt = assignment.runStartedAt || at;
  await DeliveryAssignment.updateMany(
    {
      rider: assignment.rider,
      active: true,
      deliveryRunId,
      pickupState: { $in: ['ready_for_pickup', 'with_rider'] },
    },
    { $set: { pickupState: 'with_rider', runStartedAt } },
  );
  assignment.pickupState = 'with_rider';
  assignment.runStartedAt = runStartedAt;
  return { deliveryRunId, runStartedAt };
};

export const completeAssignmentRouteLeg = async ({ assignment, at = new Date(), location }) => {
  if (!assignment.deliveryRunId) assignment.deliveryRunId = randomUUID();
  const priorStops = await DeliveryAssignment.find({
    rider: assignment.rider,
    deliveryRunId: assignment.deliveryRunId,
    _id: { $ne: assignment._id },
    routeEndedAt: { $ne: null },
  }).select('routeSequence routeEndedAt routeEndLocation').sort({ routeSequence: -1, routeEndedAt: -1 }).lean();
  const previous = priorStops[0] || null;
  assignment.routeSequence = Math.max(0, Number(previous?.routeSequence || 0)) + 1;
  assignment.routeStartedAt = previous?.routeEndedAt || assignment.runStartedAt || at;
  assignment.routeEndedAt = at;
  assignment.pickupState = 'delivery_stop_completed';
  const start = locationValue(previous?.routeEndLocation);
  const end = locationValue(location);
  if (start) assignment.routeStartLocation = start;
  if (end) assignment.routeEndLocation = end;
  return assignment;
};

export const connectedRunPublic = (assignments = []) => {
  const grouped = new Map();
  for (const assignment of assignments) {
    const runId = String(assignment.deliveryRunId || '');
    if (!runId) continue;
    if (!grouped.has(runId)) grouped.set(runId, []);
    grouped.get(runId).push(assignment);
  }
  return [...grouped.entries()].map(([deliveryRunId, rows]) => ({
    deliveryRunId,
    riderId: idString(rows[0]?.rider),
    state: rows.some((row) => row.pickupState === 'with_rider')
      ? 'out_for_delivery'
      : rows.some((row) => row.pickupState === 'ready_for_pickup')
        ? 'ready_for_pickup'
        : rows.every((row) => row.pickupState === 'completed') ? 'completed' : 'in_progress',
    orderCount: rows.length,
    orders: [...rows].sort((a, b) => Number(a.routeSequence || 0) - Number(b.routeSequence || 0)),
  }));
};

export default {
  assignmentRunDefaults,
  completeAssignmentRouteLeg,
  connectedRunPublic,
  departWithReadyAssignments,
  prepareQueuedAssignmentsAtOutlet,
  startAssignmentRun,
};
