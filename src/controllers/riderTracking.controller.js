import mongoose from 'mongoose';
import { env } from '../config/env.js';
import DeliveryAssignment from '../models/DeliveryAssignment.js';
import Outlet from '../models/Outlet.js';
import RiderDevice from '../models/RiderDevice.js';
import RiderEvent from '../models/RiderEvent.js';
import RiderLocationPoint from '../models/RiderLocationPoint.js';
import RiderShift from '../models/RiderShift.js';
import RiderDeliveryReview from '../models/RiderDeliveryReview.js';
import SaleTransaction from '../models/SaleTransaction.js';
import User from '../models/User.js';
import {
  DELIVERY_ASSIGNMENT_SALE_POPULATE,
  deliveryAssignmentPublic as assignmentPublic,
} from '../services/deliveryAssignment.service.js';
import {
  coordinatesFrom,
  coordinatesFromGeoPoint,
  emitRiderEvent,
  locationSnapshot,
  metersBetween,
} from '../services/riderTracking.service.js';
import {
  groupAssignmentsByOrder,
  routeDistanceMeters,
} from '../services/riderOrderRoute.service.js';
import {
  buildRiderPerformance,
  deliveryTimingFromAssignment,
} from '../services/riderPerformance.service.js';
import {
  riderBusinessDateForOutlet,
  riderOrdersFilter,
} from '../services/riderBusinessDay.service.js';
import { riderTrackingHealth } from '../services/riderTrackingHealth.service.js';
import { remainingLocationQueueDepth } from '../services/riderTrackingUpload.service.js';
import {
  processRiderLocationBatch,
  RiderLocationIngestionError,
  touchRiderDevice,
  trackingDeviceUpdate,
} from '../services/riderLocationIngestion.service.js';
import { enqueueRiderTrackingBatch } from '../queues/riderTracking.queue.js';
import {
  claimRiderTrackingBatch,
  completeRiderTrackingBatch,
  ensureRiderTrackingBatch,
  releaseRiderTrackingBatch,
} from '../services/riderTrackingInbox.service.js';
import { sendRiderAssignmentPush } from '../services/riderPush.service.js';
import {
  completeAssignmentRouteLeg,
  connectedRunPublic,
  startAssignmentRun,
} from '../services/riderDeliveryRun.service.js';
import logger from '../utils/logger.js';

const ACTIVE_DELIVERY_STATUSES = ['assigned', 'accepted', 'picked_up', 'delivered', 'delivery_failed'];
const ACTION_TRANSITIONS = {
  accept: { from: ['assigned'], to: 'accepted' },
  picked_up: { from: ['accepted'], to: 'picked_up' },
  delivered: { from: ['picked_up'], to: 'delivered' },
  delivery_failed: { from: ['picked_up'], to: 'delivery_failed' },
  returned_to_restaurant: { from: ['delivered', 'delivery_failed'], to: 'returned_to_restaurant' },
};

const idOf = (value) => value?._id || value || null;
const riderPublic = (rider) => ({
  _id: String(rider._id),
  name: rider.name,
  email: rider.email,
  outlet: rider.outlet,
  outletRef: rider.outletRef,
});

const requireRider = (req, res) => {
  if (req.user?.role === 'rider') return true;
  res.status(403).json({ success: false, message: 'A rider account is required.' });
  return false;
};

const resolveOutletId = async (req, requested) => {
  const assigned = idOf(req.user?.outletRef);
  if (req.user?.role !== 'owner') {
    if (!assigned) return null;
    if (requested && String(requested) !== String(assigned) && String(requested).toUpperCase() !== String(req.user?.outletCode || '').toUpperCase()) return null;
    return assigned;
  }
  if (!requested) return assigned || null;
  if (mongoose.isValidObjectId(requested)) return requested;
  return (await Outlet.findOne({ code: String(requested).toUpperCase() }).select('_id').lean())?._id || null;
};

const outletForRider = async (req) => {
  const outletId = idOf(req.user?.outletRef);
  if (outletId) return Outlet.findById(outletId);
  if (req.user?.outletCode) return Outlet.findOne({ code: String(req.user.outletCode).toUpperCase() });
  return null;
};

const activeRunAssignmentsFor = async (assignment) => DeliveryAssignment.find(
  assignment.deliveryRunId
    ? {
        rider: assignment.rider,
        deliveryRunId: assignment.deliveryRunId,
        active: true,
      }
    : { _id: assignment._id, active: true },
).sort({ assignedAt: 1 });

const validateRiderReturnLocation = async ({ assignment, riderId, requestLocation }) => {
  const [outlet, shift] = await Promise.all([
    Outlet.findById(assignment.outlet)
      .select('riderTracking.location riderTracking.geofenceRadiusMeters riderTracking.staleAfterSeconds')
      .lean(),
    RiderShift.findOne({ rider: riderId, status: 'active' })
      .select('lastLocation lastLocationReceivedAt')
      .lean(),
  ]);
  const outletCoordinates = coordinatesFromGeoPoint(outlet?.riderTracking?.location);
  const returnCoordinates = coordinatesFromGeoPoint(shift?.lastLocation?.location);
  const mockLocation = requestLocation?.isMock === true || shift?.lastLocation?.isMock === true;
  const lastReceivedAt = shift?.lastLocationReceivedAt ? new Date(shift.lastLocationReceivedAt).getTime() : 0;
  const staleAfterMs = Number(outlet?.riderTracking?.staleAfterSeconds || 120) * 1000;
  const staleLocation = !lastReceivedAt || Date.now() - lastReceivedAt > staleAfterMs;
  if (!outletCoordinates || !returnCoordinates) {
    return {
      valid: false,
      status: 409,
      code: 'RETURN_LOCATION_REQUIRED',
      message: 'A current restaurant return location is required. Ask the cashier to confirm the return if GPS is unavailable.',
    };
  }
  const distanceFromOutletMeters = metersBetween(outletCoordinates, returnCoordinates);
  const geofenceRadiusMeters = Number(outlet?.riderTracking?.geofenceRadiusMeters || 150);
  if (mockLocation || staleLocation || distanceFromOutletMeters == null || distanceFromOutletMeters > geofenceRadiusMeters) {
    return {
      valid: false,
      status: 409,
      code: 'RETURN_OUTSIDE_GEOFENCE',
      message: 'You must be inside the restaurant geofence before completing this delivery run. Ask the cashier to confirm your return if needed.',
      distanceFromOutletMeters,
      geofenceRadiusMeters,
      locationStale: staleLocation,
    };
  }
  return { valid: true, distanceFromOutletMeters, geofenceRadiusMeters };
};

const populateAssignmentPayloads = async (ids) => {
  const rows = await DeliveryAssignment.find({ _id: { $in: ids } })
    .populate('rider', 'name email')
    .populate(DELIVERY_ASSIGNMENT_SALE_POPULATE)
    .lean();
  const byId = new Map(rows.map((row) => [String(row._id), assignmentPublic(row)]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
};

const markDeliveryRunReturned = async ({ assignments, actor, actorName, reason, clientEventId = '' }) => {
  const now = new Date();
  for (const assignment of assignments) {
    assignment.status = 'returned_to_restaurant';
    assignment.active = false;
    assignment.completedAt = now;
    assignment.pickupState = 'completed';
    assignment.runReturnedAt = now;
    assignment.statusHistory.push({
      status: 'returned_to_restaurant',
      at: now,
      actor,
      actorName,
      reason,
      clientEventId,
    });
  }
  await Promise.all(assignments.map((assignment) => assignment.save()));
  await Promise.all([
    SaleTransaction.bulkWrite(assignments.map((assignment) => ({
      updateOne: {
        filter: { _id: assignment.saleTransaction, assignedRiderUser: assignment.rider },
        update: { $set: { riderDeliveryStatus: 'returned_to_restaurant' } },
      },
    }))),
    RiderEvent.insertMany(assignments.map((assignment) => ({
      rider: assignment.rider,
      outlet: assignment.outlet,
      assignment: assignment._id,
      type: 'delivery_status',
      metadata: {
        status: 'returned_to_restaurant',
        orderNumber: assignment.orderNumber,
        deliveryRunId: assignment.deliveryRunId || '',
        reason,
      },
    }))),
  ]);
  return {
    at: now,
    payloads: await populateAssignmentPayloads(assignments.map((assignment) => assignment._id)),
  };
};

const emitDeliveryRunAssignments = ({ tenantSlug, assignments, state }) => {
  if (!assignments.length) return;
  const first = assignments[0];
  for (const payload of assignments) {
    emitRiderEvent({
      tenantSlug,
      outletId: payload.outlet,
      riderId: payload.rider?._id || payload.rider,
      event: 'rider-assignment:updated',
      payload,
    });
  }
  emitRiderEvent({
    tenantSlug,
    outletId: first.outlet,
    riderId: first.rider?._id || first.rider,
    event: 'rider-run:updated',
    payload: {
      riderId: String(first.rider?._id || first.rider),
      deliveryRunId: first.deliveryRunId || '',
      state,
      orderCount: assignments.length,
      assignments,
    },
  });
};

export const riderBootstrap = async (req, res) => {
  if (!requireRider(req, res)) return;
  const outlet = await outletForRider(req);
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const [rider, shift, assignments] = await Promise.all([
    User.findById(req.user.id).select('name email role outlet outletRef isActive').lean(),
    RiderShift.findOne({ rider: req.user.id, status: 'active' }).lean(),
    DeliveryAssignment.find({ rider: req.user.id, active: true })
      .sort({ assignedAt: -1 })
      .populate(DELIVERY_ASSIGNMENT_SALE_POPULATE)
      .lean(),
  ]);
  const businessDate = riderBusinessDateForOutlet(outlet);
  return res.json({
    success: true,
    data: {
      rider: riderPublic(rider),
      outlet: {
        _id: outlet._id,
        name: outlet.name,
        code: outlet.code,
        address: outlet.address,
        tracking: outlet.riderTracking || {},
      },
      shift,
      assignments: assignments.map(assignmentPublic),
      businessDate,
      trackingRequired: Boolean(shift),
      serverTime: new Date(),
    },
  });
};

export const registerRiderDevice = async (req, res) => {
  if (!requireRider(req, res)) return;
  const outlet = await outletForRider(req);
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!deviceId || deviceId.length > 200) return res.status(422).json({ success: false, message: 'A valid deviceId is required.' });
  const allowed = ['manufacturer', 'model', 'osVersion', 'appVersion', 'pushToken', 'pushRegistrationError', 'locationPermission', 'notificationsEnabled'];
  const values = Object.fromEntries(allowed
    .filter((key) => req.body?.[key] !== undefined)
    .map((key) => [key, req.body[key]]));
  const now = new Date();
  await RiderDevice.updateMany(
    { rider: req.user.id, deviceId: { $ne: deviceId }, isActive: true },
    { $set: { isActive: false, trackingEnabled: false } },
  );
  const receivedPushToken = typeof req.body?.pushToken === 'string' && req.body.pushToken.trim().length > 0;
  const device = await RiderDevice.findOneAndUpdate(
    { rider: req.user.id, deviceId },
    { $set: {
      ...values,
      ...trackingDeviceUpdate({ body: req.body, now }),
      outlet: outlet._id,
      platform: 'android',
      isActive: true,
      ...(receivedPushToken ? { pushTokenUpdatedAt: now, pushRegistrationError: '' } : {}),
    } },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
  await RiderEvent.create({ rider: req.user.id, outlet: outlet._id, type: 'device_registered', metadata: { deviceId, appVersion: device.appVersion } });
  return res.json({ success: true, data: device });
};

export const riderHeartbeat = async (req, res) => {
  if (!requireRider(req, res)) return;
  const outlet = await outletForRider(req);
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const batteryLevel = Number(req.body?.batteryLevel);
  const now = new Date();
  await touchRiderDevice({ riderId: req.user.id, outletId: outlet._id, body: req.body, now });
  const shift = await RiderShift.findOne({ rider: req.user.id, status: 'active' }).select('_id lastLocation').lean();
  emitRiderEvent({
    tenantSlug: req.tenantSlug,
    outletId: outlet._id,
    riderId: req.user.id,
    event: 'rider:heartbeat',
    payload: { riderId: String(req.user.id), at: now, batteryLevel: Number.isFinite(batteryLevel) ? batteryLevel : null, trackingEnabled: req.body?.trackingEnabled === true },
  });
  return res.json({ success: true, data: { shiftId: shift?._id || null, serverTime: now } });
};

export const startRiderShift = async (req, res) => {
  if (!requireRider(req, res)) return;
  const outlet = await outletForRider(req);
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const existing = await RiderShift.findOne({ rider: req.user.id, status: 'active' });
  if (existing) return res.json({ success: true, data: existing, alreadyActive: true });
  const outletCoords = coordinatesFromGeoPoint(outlet.riderTracking?.location);
  if (!outletCoords) {
    return res.status(409).json({ success: false, code: 'OUTLET_LOCATION_REQUIRED', message: 'The outlet tracking location is not configured. Ask the owner to set it in Rider Operations.' });
  }
  const snapshot = locationSnapshot(req.body?.location || req.body);
  if (!snapshot) return res.status(422).json({ success: false, message: 'A valid precise starting location is required.' });
  const startCoords = coordinatesFromGeoPoint(snapshot.location);
  const distance = outletCoords ? metersBetween(outletCoords, startCoords) : null;
  const radius = Number(outlet.riderTracking?.geofenceRadiusMeters || 150);
  const inOutletGeofence = distance == null ? null : distance <= radius;
  const now = new Date();
  const shift = await RiderShift.create({
    rider: req.user.id,
    outlet: outlet._id,
    startedAt: now,
    startLocation: snapshot,
    lastLocation: snapshot,
    lastLocationReceivedAt: now,
    inOutletGeofence,
  });
  await RiderEvent.create({ rider: req.user.id, outlet: outlet._id, shift: shift._id, type: 'shift_started', metadata: { inOutletGeofence, distanceFromOutletMeters: distance } });
  emitRiderEvent({ tenantSlug: req.tenantSlug, outletId: outlet._id, riderId: req.user.id, event: 'rider-shift:started', payload: { riderId: String(req.user.id), shift, inOutletGeofence } });
  return res.status(201).json({ success: true, data: shift });
};

export const endRiderShift = async (req, res) => {
  if (!requireRider(req, res)) return;
  const outlet = await outletForRider(req);
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const activeAssignments = await DeliveryAssignment.find({ rider: req.user.id, active: true }).select('orderNumber status').lean();
  if (activeAssignments.length) {
    const orderNumbers = activeAssignments.slice(0, 3).map((assignment) => assignment.orderNumber).join(', ');
    const more = activeAssignments.length > 3 ? ` and ${activeAssignments.length - 3} more` : '';
    return res.status(409).json({ success: false, code: 'ACTIVE_DELIVERY', message: `Complete or return active orders ${orderNumbers}${more} before ending duty.` });
  }
  const shift = await RiderShift.findOne({ rider: req.user.id, status: 'active' });
  if (!shift) return res.status(404).json({ success: false, message: 'No active rider shift was found.' });
  const snapshot = locationSnapshot(req.body?.location || req.body);
  if (snapshot) shift.endLocation = snapshot;
  shift.endedAt = new Date();
  shift.status = 'ended';
  shift.endReason = String(req.body?.reason || 'Rider ended duty').slice(0, 200);
  await shift.save();
  await RiderDevice.updateMany({ rider: req.user.id }, { $set: { trackingEnabled: false, lastSeenAt: new Date() } });
  await RiderEvent.create({ rider: req.user.id, outlet: outlet._id, shift: shift._id, type: 'shift_ended', metadata: { reason: shift.endReason } });
  emitRiderEvent({ tenantSlug: req.tenantSlug, outletId: outlet._id, riderId: req.user.id, event: 'rider-shift:ended', payload: { riderId: String(req.user.id), shiftId: String(shift._id), endedAt: shift.endedAt } });
  return res.json({ success: true, data: shift });
};

export const listRiderOrders = async (req, res) => {
  if (!requireRider(req, res)) return;
  const outlet = await outletForRider(req);
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const historyLimit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const history = req.query.history === 'true';
  const businessDate = riderBusinessDateForOutlet(outlet);
  const currentSaleIds = history
    ? await SaleTransaction.distinct('_id', { outlet: outlet._id, businessDate })
    : [];
  let assignmentsQuery = DeliveryAssignment.find(riderOrdersFilter({
    riderId: req.user.id,
    history,
    businessDate,
    currentSaleIds,
  }))
    .sort({ active: -1, assignedAt: -1 })
    .populate(DELIVERY_ASSIGNMENT_SALE_POPULATE);
  // The history query is already bounded to one business day, so return every
  // delivery for that day. The non-history endpoint retains a defensive cap.
  if (!history) assignmentsQuery = assignmentsQuery.limit(historyLimit);
  const assignments = await assignmentsQuery.lean();
  return res.json({ success: true, businessDate, data: assignments.map(assignmentPublic) });
};

export const getRiderOrder = async (req, res) => {
  if (!requireRider(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid assignment.' });
  }
  const [assignment, outlet] = await Promise.all([DeliveryAssignment.findOne({
    _id: req.params.id,
    rider: req.user.id,
  })
    .populate(DELIVERY_ASSIGNMENT_SALE_POPULATE)
    .lean(), outletForRider(req)]);
  if (!assignment) {
    return res.status(404).json({ success: false, message: 'Assigned delivery not found.' });
  }
  if (!outlet) return res.status(422).json({ success: false, message: 'The rider account has no valid outlet.' });
  const businessDate = riderBusinessDateForOutlet(outlet);
  const assignmentBusinessDate = assignment.businessDate || assignment.saleTransaction?.businessDate;
  if (!assignment.active && assignmentBusinessDate !== businessDate) {
    return res.status(404).json({ success: false, message: 'This delivery is no longer available in the current business day.' });
  }
  return res.json({ success: true, data: assignmentPublic(assignment) });
};

export const updateRiderOrder = async (req, res) => {
  if (!requireRider(req, res)) return;
  const transition = ACTION_TRANSITIONS[req.body?.action];
  if (!transition) return res.status(422).json({ success: false, message: 'Unsupported rider action.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid assignment.' });
  const clientEventId = String(req.body?.clientEventId || '').trim();
  const current = await DeliveryAssignment.findOne({ _id: req.params.id, rider: req.user.id });
  if (!current) return res.status(404).json({ success: false, message: 'Assigned delivery not found.' });
  if (clientEventId && current.statusHistory.some((event) => event.clientEventId === clientEventId)) {
    return res.json({ success: true, data: assignmentPublic(current), duplicate: true });
  }
  if (!transition.from.includes(current.status)) {
    return res.status(409).json({ success: false, message: `Order must be ${transition.from.join(' or ')} before ${transition.to}.`, currentStatus: current.status });
  }
  const now = new Date();
  const coordinates = coordinatesFrom(req.body?.location);
  if (transition.to === 'picked_up' && current.pickupState === 'queued_at_restaurant') {
    return res.status(409).json({
      success: false,
      code: 'ORDER_WAITING_AT_RESTAURANT',
      message: 'This order was assigned while you were away. Return to the restaurant before marking it picked up.',
    });
  }
  if (transition.to === 'returned_to_restaurant') {
    const runAssignments = await activeRunAssignmentsFor(current);
    const unfinished = runAssignments.filter((assignment) => !['delivered', 'delivery_failed'].includes(assignment.status));
    if (unfinished.length) {
      return res.status(409).json({
        success: false,
        code: 'RUN_STOPS_REMAINING',
        message: `Complete the remaining ${unfinished.length} delivery stop${unfinished.length === 1 ? '' : 's'} before returning to the restaurant.`,
        remainingOrders: unfinished.map((assignment) => ({
          assignmentId: String(assignment._id),
          orderNumber: assignment.orderNumber,
          status: assignment.status,
        })),
      });
    }
    const locationCheck = await validateRiderReturnLocation({
      assignment: current,
      riderId: req.user.id,
      requestLocation: req.body?.location,
    });
    if (!locationCheck.valid) {
      const { status, ...errorBody } = locationCheck;
      return res.status(status).json({ success: false, ...errorBody });
    }
    const returned = await markDeliveryRunReturned({
      assignments: runAssignments,
      actor: req.user.id,
      actorName: req.user.name || req.user.email || 'Rider',
      reason: String(req.body?.reason || 'Rider confirmed the delivery run return.').slice(0, 500),
      clientEventId,
    });
    emitDeliveryRunAssignments({
      tenantSlug: req.tenantSlug,
      assignments: returned.payloads,
      state: 'completed',
    });
    return res.json({
      success: true,
      data: returned.payloads.find((assignment) => assignment._id === String(current._id)) || returned.payloads[0],
      assignments: returned.payloads,
      deliveryRunId: current.deliveryRunId || '',
    });
  }
  if (transition.to === 'picked_up') {
    await startAssignmentRun({ assignment: current, at: now });
  }
  if (['delivered', 'delivery_failed'].includes(transition.to)) {
    await completeAssignmentRouteLeg({ assignment: current, at: now, location: coordinates });
    const routePoints = await RiderLocationPoint.find({
      rider: current.rider,
      recordedAt: { $gte: current.routeStartedAt, $lte: current.routeEndedAt },
    }).select('location recordedAt').sort({ recordedAt: 1 }).lean();
    current.routePointCount = routePoints.length;
    current.routeDistanceMeters = routeDistanceMeters(routePoints);
    current.deliveryOutcome = transition.to;
  }
  current.status = transition.to;
  current.statusHistory.push({
    status: transition.to,
    at: now,
    actor: req.user.id,
    actorName: req.user.name || req.user.email || 'Rider',
    reason: String(req.body?.reason || '').slice(0, 500),
    clientEventId,
    location: coordinates ? { ...coordinates, accuracy: Number(req.body?.location?.accuracy) || null } : undefined,
  });
  await current.save();
  await SaleTransaction.updateOne(
    { _id: current.saleTransaction, assignedRiderUser: req.user.id },
    { $set: { riderDeliveryStatus: transition.to } },
  );
  await RiderEvent.create({ rider: req.user.id, outlet: current.outlet, assignment: current._id, type: 'delivery_status', metadata: { status: transition.to, orderNumber: current.orderNumber } });
  const runRows = await activeRunAssignmentsFor(current);
  const runPayloads = await populateAssignmentPayloads(runRows.map((assignment) => assignment._id));
  const payload = runPayloads.find((assignment) => assignment._id === String(current._id)) || assignmentPublic(current);
  emitRiderEvent({ tenantSlug: req.tenantSlug, outletId: current.outlet, riderId: req.user.id, event: 'rider-assignment:updated', payload });
  emitRiderEvent({
    tenantSlug: req.tenantSlug,
    outletId: current.outlet,
    riderId: req.user.id,
    event: 'rider-run:updated',
    payload: {
      riderId: String(req.user.id),
      deliveryRunId: current.deliveryRunId || '',
      assignmentId: String(current._id),
      status: current.status,
      state: ['delivered', 'delivery_failed'].includes(current.status) ? 'stops_in_progress' : 'in_progress',
      assignments: runPayloads,
    },
  });
  return res.json({ success: true, data: payload, assignments: runPayloads });
};

export const ingestRiderLocations = async (req, res) => {
  if (!requireRider(req, res)) return;
  const points = Array.isArray(req.body?.points) ? req.body.points : [];
  if (!points.length || points.length > 100) {
    return res.status(422).json({ success: false, message: 'Send between 1 and 100 location points.' });
  }

  const shift = await RiderShift.findOne({ rider: req.user.id, status: 'active' }).select('_id outlet').lean();
  if (!shift) {
    return res.status(409).json({
      success: false,
      code: 'NO_ACTIVE_SHIFT',
      message: 'Start duty before sending location.',
    });
  }

  if (env.RIDER_TRACKING_QUEUE_ENABLED) {
    const durableBatch = await ensureRiderTrackingBatch({
      riderId: req.user.id,
      outletId: shift.outlet,
      shiftId: shift._id,
      body: req.body,
    });
    try {
      const jobId = await enqueueRiderTrackingBatch({
        tenantSlug: req.tenantSlug,
        batchId: durableBatch._id,
        attempt: Number(durableBatch.attempts || 0) + 1,
      });
      return res.status(202).json({
        success: true,
        queued: true,
        data: {
          accepted: points.length,
          duplicates: 0,
          remainingQueueDepth: remainingLocationQueueDepth(
            req.body?.trackingHealth?.queueDepth ?? req.body?.queueDepth,
            points.length,
          ),
          jobId,
        },
      });
    } catch (error) {
      logger.error(`Rider tracking queue unavailable; processing inline: ${error.message}`, {
        tenantSlug: req.tenantSlug,
        riderId: String(req.user.id),
      });
      const claimed = await claimRiderTrackingBatch(durableBatch._id);
      if (claimed) {
        try {
          const data = await processRiderLocationBatch({
            tenantSlug: req.tenantSlug,
            riderId: claimed.rider,
            shiftId: claimed.shift,
            body: claimed.body,
            onEvent: (message) => emitRiderEvent(message),
          });
          await completeRiderTrackingBatch(claimed._id);
          return res.json({ success: true, queued: false, fallback: true, data });
        } catch (inlineError) {
          await releaseRiderTrackingBatch(claimed, inlineError, {
            terminal: inlineError instanceof RiderLocationIngestionError
              && inlineError.code === 'NO_ACTIVE_SHIFT',
          });
          if (inlineError instanceof RiderLocationIngestionError) {
            return res.status(inlineError.status).json({
              success: false,
              code: inlineError.code,
              message: inlineError.message,
            });
          }
          throw inlineError;
        }
      }
      return res.status(202).json({
        success: true,
        queued: true,
        duplicate: true,
        data: {
          accepted: points.length,
          duplicates: 0,
          remainingQueueDepth: remainingLocationQueueDepth(
            req.body?.trackingHealth?.queueDepth ?? req.body?.queueDepth,
            points.length,
          ),
          batchId: String(durableBatch._id),
        },
      });
    }
  }

  try {
    const data = await processRiderLocationBatch({
      tenantSlug: req.tenantSlug,
      riderId: req.user.id,
      shiftId: shift._id,
      body: req.body,
      onEvent: (message) => emitRiderEvent(message),
    });
    return res.json({ success: true, data });
  } catch (error) {
    if (error instanceof RiderLocationIngestionError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    throw error;
  }
};

export const getLiveRiderDispatch = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId || req.query.outlet);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const outlet = await Outlet.findById(outletId).select('name code address riderTracking').lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  const riders = await User.find({ role: 'rider', outletRef: outletId, isActive: true })
    .select('name email outlet outletRef')
    .sort({ name: 1 })
    .lean();
  const riderIds = riders.map((rider) => rider._id);
  const [shifts, assignments, devices, unassignedOrders] = await Promise.all([
    RiderShift.find({ rider: { $in: riderIds }, status: 'active' }).lean(),
    DeliveryAssignment.find({ rider: { $in: riderIds }, active: true }).lean(),
    RiderDevice.find({ rider: { $in: riderIds }, isActive: true }).sort({ lastSeenAt: -1 }).lean(),
    SaleTransaction.find({
      outlet: outletId,
      orderType: 'delivery',
      status: 'held',
      assignedRider: null,
      assignedRiderUser: null,
    })
      .select('transactionNumber customer deliveryAddress totalAmount notes heldAt createdAt kdsOrder')
      .populate('customer', 'name phone')
      .sort({ heldAt: 1, createdAt: 1 })
      .lean(),
  ]);
  const shiftMap = new Map(shifts.map((shift) => [String(shift.rider), shift]));
  const assignmentsByRider = new Map();
  for (const assignment of assignments) {
    const riderId = String(assignment.rider);
    if (!assignmentsByRider.has(riderId)) assignmentsByRider.set(riderId, []);
    assignmentsByRider.get(riderId).push(assignment);
  }
  const deviceMap = new Map();
  for (const device of devices) if (!deviceMap.has(String(device.rider))) deviceMap.set(String(device.rider), device);
  const outletCoordinates = coordinatesFromGeoPoint(outlet.riderTracking?.location);
  const staleAfterSeconds = Number(outlet.riderTracking?.staleAfterSeconds || 120);
  const now = Date.now();
  const liveRiders = riders.map((rider) => {
    const shift = shiftMap.get(String(rider._id));
    const riderAssignments = (assignmentsByRider.get(String(rider._id)) || [])
      .sort((a, b) => new Date(b.assignedAt || 0) - new Date(a.assignedAt || 0));
    const assignment = riderAssignments[0] || null;
    const publicAssignments = riderAssignments.map(assignmentPublic);
    const device = deviceMap.get(String(rider._id));
    const lastLocation = shift?.lastLocation;
    const coordinates = coordinatesFromGeoPoint(lastLocation?.location);
    const health = riderTrackingHealth({ shift, device, staleAfterSeconds, now: new Date(now) });
    const distanceFromOutletMeters = outletCoordinates && coordinates
      ? metersBetween(outletCoordinates, coordinates)
      : null;
    return {
      ...riderPublic(rider),
      onDuty: Boolean(shift),
      available: Boolean(shift && health.trackingOnline && health.locationUsable && coordinates),
      status: !shift ? 'off_duty' : assignment?.status || (health.trackingState === 'live' ? 'available' : health.trackingState),
      shiftId: shift?._id || null,
      assignment: assignment ? assignmentPublic(assignment) : null,
      assignments: publicAssignments,
      activeAssignments: publicAssignments,
      activeAssignmentCount: publicAssignments.length,
      deliveryRuns: connectedRunPublic(publicAssignments),
      location: coordinates ? { ...coordinates, recordedAt: lastLocation.recordedAt, accuracy: lastLocation.accuracy, isMock: lastLocation.isMock } : null,
      ...health,
      distanceFromOutletMeters,
      inOutletGeofence: shift?.inOutletGeofence ?? null,
      batteryLevel: lastLocation?.batteryLevel ?? device?.batteryLevel ?? null,
      device: device ? {
        appVersion: device.appVersion,
        model: device.model,
        lastSeenAt: device.lastSeenAt,
        lastLocationReceivedAt: device.lastLocationReceivedAt,
        lastTaskCallbackAt: device.lastTaskCallbackAt,
        lastWatchdogAt: device.lastWatchdogAt,
        lastUploadAt: device.lastUploadAt,
        lastTrackingError: device.lastTrackingError,
        locationQueueDepth: device.locationQueueDepth,
        trackingMode: device.trackingMode,
        trackingEnabled: device.trackingEnabled,
        locationPermission: device.locationPermission,
        backgroundLocationGranted: device.backgroundLocationGranted,
        batteryOptimizationEnabled: device.batteryOptimizationEnabled,
        lowPowerMode: device.lowPowerMode,
        consecutiveUploadFailures: device.consecutiveUploadFailures,
        notificationsEnabled: device.notificationsEnabled,
        pushRegistered: Boolean(device.pushToken),
        pushTokenUpdatedAt: device.pushTokenUpdatedAt,
        pushRegistrationError: device.pushRegistrationError,
      } : null,
    };
  }).sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.distanceFromOutletMeters == null) return 1;
    if (b.distanceFromOutletMeters == null) return -1;
    return a.distanceFromOutletMeters - b.distanceFromOutletMeters;
  });
  return res.json({
    success: true,
    data: {
      outlet: { _id: outlet._id, name: outlet.name, code: outlet.code, address: outlet.address, riderTracking: outlet.riderTracking || {} },
      riders: liveRiders,
      unassignedOrders: unassignedOrders.map((order) => ({ ...order, customerName: order.customer?.name || '', customerPhone: order.customer?.phone || '' })),
      serverTime: new Date(),
    },
  });
};

export const getRiderTrackingHistory = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId || req.query.outlet);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86_400_000);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    return res.status(422).json({ success: false, message: 'A valid history date range is required.' });
  }
  const riderFilter = mongoose.isValidObjectId(req.query.riderId) ? { rider: req.query.riderId } : {};
  const matchedAssignments = await DeliveryAssignment.find({
    outlet: outletId,
    assignedAt: { $gte: from, $lte: to },
    ...riderFilter,
  })
    .select('saleTransaction assignedAt')
    .sort({ assignedAt: -1 })
    .limit(limit)
    .lean();
  const orderIds = [...new Map(matchedAssignments.map((assignment) => [
    String(assignment.saleTransaction), assignment.saleTransaction,
  ])).values()];
  const assignments = orderIds.length
    ? await DeliveryAssignment.find({ outlet: outletId, saleTransaction: { $in: orderIds } })
        .populate('rider', 'name email')
        .populate(DELIVERY_ASSIGNMENT_SALE_POPULATE)
        .sort({ assignedAt: -1 })
        .lean()
    : [];
  const assignmentIds = assignments.map((assignment) => assignment._id);
  const routeStats = assignmentIds.length
    ? await RiderLocationPoint.aggregate([
        { $match: { assignment: { $in: assignmentIds } } },
        { $group: {
          _id: '$assignment',
          pointCount: { $sum: 1 },
          firstRecordedAt: { $min: '$recordedAt' },
          lastRecordedAt: { $max: '$recordedAt' },
        } },
      ])
    : [];
  const orders = groupAssignmentsByOrder(assignments.map(assignmentPublic), routeStats);
  return res.json({ success: true, data: { orders, from, to } });
};

const reviewPublic = (review) => {
  if (!review) return null;
  return {
    _id: String(review._id),
    behaviorRating: review.behaviorRating ?? null,
    riderChargeAmount: review.riderChargeAmount ?? null,
    notes: review.notes || '',
    enteredBy: review.enteredBy?._id ? String(review.enteredBy._id) : String(review.enteredBy || ''),
    enteredByName: review.enteredBy?.name || review.enteredByName || '',
    createdAt: review.createdAt || null,
    updatedAt: review.updatedAt || null,
  };
};

const performanceDateRange = (req) => {
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86_400_000);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return null;
  return { from, to };
};

// Operational rider report only. No accounting document or journal is created.
export const getRiderPerformance = async (req, res) => {
  const outletId = await resolveOutletId(req, req.query.outletId || req.query.outlet);
  if (!outletId) return res.status(422).json({ success: false, message: 'A permitted outlet is required.' });
  const range = performanceDateRange(req);
  if (!range) return res.status(422).json({ success: false, message: 'A valid performance date range is required.' });
  const outlet = await Outlet.findById(outletId).select('name code riderTracking.performanceEnabled').lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  const enabled = outlet.riderTracking?.performanceEnabled === true;
  if (!enabled) {
    return res.json({
      success: true,
      data: { enabled: false, outlet: { _id: outlet._id, name: outlet.name, code: outlet.code }, from: range.from, to: range.to, orders: [], rankings: [], winner: null },
    });
  }

  const assignments = await DeliveryAssignment.find({
    outlet: outletId,
    status: 'returned_to_restaurant',
    completedAt: { $gte: range.from, $lte: range.to },
  })
    .select('saleTransaction outlet rider orderNumber assignedAt completedAt statusHistory')
    .populate('rider', 'name email')
    .populate({ path: 'saleTransaction', select: 'transactionNumber customer', populate: { path: 'customer', select: 'name phone' } })
    .sort({ completedAt: -1 })
    .limit(1000)
    .lean();
  const saleIds = assignments.map((assignment) => assignment.saleTransaction?._id || assignment.saleTransaction);
  const reviews = saleIds.length
    ? await RiderDeliveryReview.find({ saleTransaction: { $in: saleIds } })
        .populate('enteredBy', 'name email')
        .lean()
    : [];
  const reviewsBySale = new Map(reviews.map((review) => [String(review.saleTransaction), review]));
  const orders = assignments.map((assignment) => {
    const timing = deliveryTimingFromAssignment(assignment);
    const sale = assignment.saleTransaction && typeof assignment.saleTransaction === 'object'
      ? assignment.saleTransaction
      : null;
    const review = reviewsBySale.get(String(sale?._id || assignment.saleTransaction));
    return {
      _id: String(sale?._id || assignment.saleTransaction),
      assignmentId: String(assignment._id),
      orderNumber: sale?.transactionNumber || assignment.orderNumber,
      customerName: sale?.customer?.name || '',
      rider: assignment.rider,
      assignedAt: assignment.assignedAt,
      pickedUpAt: timing.pickedUpAt,
      customerDeliveredAt: timing.customerDeliveredAt,
      returnedAt: timing.returnedAt,
      deliveryDurationSeconds: timing.deliveryDurationSeconds,
      review: reviewPublic(review),
    };
  });
  const rankings = buildRiderPerformance(orders);
  const durationRows = orders.filter((order) => order.deliveryDurationSeconds != null);
  const reviewedRows = orders.filter((order) => order.review);
  const summary = {
    deliveredCount: orders.length,
    reviewedCount: reviewedRows.length,
    totalRiderChargeAmount: Math.round(reviewedRows.reduce((sum, order) => sum + Number(order.review?.riderChargeAmount || 0), 0) * 100) / 100,
    averageDeliverySeconds: durationRows.length
      ? Math.round(durationRows.reduce((sum, order) => sum + order.deliveryDurationSeconds, 0) / durationRows.length)
      : null,
  };
  return res.json({
    success: true,
    data: {
      enabled: true,
      outlet: { _id: outlet._id, name: outlet.name, code: outlet.code },
      from: range.from,
      to: range.to,
      formula: {
        deliveries: 30,
        deliveryTime: 30,
        riderCharge: 20,
        behavior: 20,
        note: 'Higher delivery count and behavior are better; lower delivery time and total rider charge are better. Missing optional values are excluded and weights are rebalanced.',
      },
      summary,
      orders,
      rankings,
      winner: rankings.find((row) => row.eligible) || null,
    },
  });
};

export const upsertRiderDeliveryReview = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) {
    return res.status(400).json({ success: false, message: 'Invalid delivery order.' });
  }
  const order = await SaleTransaction.findById(req.params.orderId).select('outlet orderType transactionNumber').lean();
  if (!order || order.orderType !== 'delivery') return res.status(404).json({ success: false, message: 'Delivery order not found.' });
  const outletId = await resolveOutletId(req, order.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This delivery order belongs to another outlet.' });
  const outlet = await Outlet.findById(outletId).select('riderTracking.performanceEnabled').lean();
  if (outlet?.riderTracking?.performanceEnabled !== true) {
    return res.status(403).json({ success: false, code: 'RIDER_PERFORMANCE_DISABLED', message: 'Rider performance reporting is not enabled for this outlet.' });
  }
  const assignment = await DeliveryAssignment.findOne({
    saleTransaction: order._id,
    outlet: outletId,
    status: 'returned_to_restaurant',
  }).populate('rider', 'name email').sort({ completedAt: -1 });
  if (!assignment) {
    return res.status(409).json({ success: false, message: 'The rider must return to the restaurant, or the cashier must confirm the return, before rating or rider charges can be recorded.' });
  }

  const hasRating = Object.prototype.hasOwnProperty.call(req.body || {}, 'behaviorRating');
  const hasCharge = Object.prototype.hasOwnProperty.call(req.body || {}, 'riderChargeAmount');
  const hasNotes = Object.prototype.hasOwnProperty.call(req.body || {}, 'notes');
  if (!hasRating && !hasCharge && !hasNotes) {
    return res.status(422).json({ success: false, message: 'Provide a behavior rating, rider charge, or note.' });
  }
  const behaviorRating = req.body.behaviorRating === '' || req.body.behaviorRating == null
    ? null
    : Number(req.body.behaviorRating);
  const riderChargeAmount = req.body.riderChargeAmount === '' || req.body.riderChargeAmount == null
    ? null
    : Number(req.body.riderChargeAmount);
  if (behaviorRating != null && (!Number.isInteger(behaviorRating) || behaviorRating < 1 || behaviorRating > 5)) {
    return res.status(422).json({ success: false, message: 'Behavior rating must be a whole number from 1 to 5.' });
  }
  if (riderChargeAmount != null && (!Number.isFinite(riderChargeAmount) || riderChargeAmount < 0 || riderChargeAmount > 10_000_000)) {
    return res.status(422).json({ success: false, message: 'Enter a valid non-negative rider charge.' });
  }
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  const timing = deliveryTimingFromAssignment(assignment);
  const riderId = assignment.rider?._id || assignment.rider;
  const values = {
    saleTransaction: order._id,
    assignment: assignment._id,
    outlet: outletId,
    riderType: 'user',
    rider: riderId,
    riderName: assignment.rider?.name || 'Rider',
    orderNumber: order.transactionNumber || assignment.orderNumber,
    behaviorRating,
    riderChargeAmount,
    notes,
    pickedUpAt: timing.pickedUpAt,
    customerDeliveredAt: timing.customerDeliveredAt,
    returnedAt: timing.returnedAt || assignment.completedAt,
    deliveryDurationSeconds: timing.deliveryDurationSeconds,
    enteredBy: req.user.id,
    enteredByName: req.user.name || req.user.email || '',
  };
  const review = await RiderDeliveryReview.findOneAndUpdate(
    { saleTransaction: order._id },
    { $set: values },
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).populate('enteredBy', 'name email');
  emitRiderEvent({
    tenantSlug: req.tenantSlug,
    outletId,
    event: 'rider-performance:updated',
    payload: { orderId: String(order._id), assignmentId: String(assignment._id), riderId: String(riderId), review: reviewPublic(review) },
  });
  return res.json({ success: true, data: reviewPublic(review) });
};

// Cashier/management return verification. This is intentionally auditable and
// separate from rider actions so a suspicious early return can be reopened or
// its actual restaurant-arrival time can be corrected from the live map.
export const overrideRiderReturn = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid rider assignment.' });
  }
  const assignment = await DeliveryAssignment.findById(req.params.id);
  if (!assignment) return res.status(404).json({ success: false, message: 'Rider assignment not found.' });
  const outletId = await resolveOutletId(req, assignment.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This assignment belongs to another outlet.' });

  const action = req.body?.action === 'reopen' ? 'reopen' : 'confirm';
  const now = new Date();
  const actorName = req.user.name || req.user.email || 'Cashier';
  const reason = String(req.body?.reason || '').trim().slice(0, 500)
    || (action === 'reopen'
      ? 'Cashier disputed the delivery run return.'
      : 'Cashier confirmed the actual restaurant return time.');

  if (action === 'reopen') {
    if (assignment.status !== 'returned_to_restaurant') {
      return res.status(409).json({ success: false, message: 'Only a returned delivery run can be reopened.' });
    }
    const runAssignments = await DeliveryAssignment.find(
      assignment.deliveryRunId
        ? {
            rider: assignment.rider,
            deliveryRunId: assignment.deliveryRunId,
            status: 'returned_to_restaurant',
          }
        : { _id: assignment._id, status: 'returned_to_restaurant' },
    ).sort({ assignedAt: 1 });
    for (const row of runAssignments) {
      const priorStatus = [...row.statusHistory]
        .reverse()
        .find((event) => ['delivered', 'delivery_failed'].includes(event.status))?.status || 'delivered';
      row.status = priorStatus;
      row.active = true;
      row.completedAt = null;
      row.pickupState = 'delivery_stop_completed';
      row.runReturnedAt = null;
      row.statusHistory.push({ status: priorStatus, at: now, actor: req.user.id, actorName, reason });
    }
    await Promise.all(runAssignments.map((row) => row.save()));
    await Promise.all([
      SaleTransaction.bulkWrite(runAssignments.map((row) => ({
        updateOne: {
          filter: { _id: row.saleTransaction, assignedRiderUser: row.rider },
          update: { $set: { riderDeliveryStatus: row.status } },
        },
      }))),
      RiderEvent.insertMany(runAssignments.map((row) => ({
        rider: row.rider,
        outlet: row.outlet,
        assignment: row._id,
        type: 'delivery_status',
        metadata: {
          status: row.status,
          orderNumber: row.orderNumber,
          deliveryRunId: row.deliveryRunId || '',
          cashierOverride: true,
          action,
          reason,
        },
      }))),
    ]);
    const payloads = await populateAssignmentPayloads(runAssignments.map((row) => row._id));
    emitDeliveryRunAssignments({ tenantSlug: req.tenantSlug, assignments: payloads, state: 'stops_completed' });
    emitRiderEvent({
      tenantSlug: req.tenantSlug,
      outletId: assignment.outlet,
      event: 'rider-return:overridden',
      payload: {
        assignmentId: String(assignment._id),
        deliveryRunId: assignment.deliveryRunId || '',
        assignmentIds: payloads.map((row) => row._id),
        action,
        status: 'reopened',
        at: now,
        actorName,
      },
    });
    return res.json({
      success: true,
      data: payloads.find((row) => row._id === String(assignment._id)) || payloads[0],
      assignments: payloads,
      deliveryRunId: assignment.deliveryRunId || '',
    });
  }

  const runAssignments = await activeRunAssignmentsFor(assignment);
  if (!runAssignments.length && assignment.status === 'returned_to_restaurant') {
    const payloads = await populateAssignmentPayloads([assignment._id]);
    return res.json({ success: true, data: payloads[0], assignments: payloads, duplicate: true });
  }
  const unfinished = runAssignments.filter((row) => !['delivered', 'delivery_failed'].includes(row.status));
  if (unfinished.length) {
    return res.status(409).json({
      success: false,
      code: 'RUN_STOPS_REMAINING',
      message: `The rider still has ${unfinished.length} unfinished stop${unfinished.length === 1 ? '' : 's'} in this run.`,
      remainingOrders: unfinished.map((row) => ({
        assignmentId: String(row._id),
        orderNumber: row.orderNumber,
        status: row.status,
      })),
    });
  }
  if (!runAssignments.length) {
    return res.status(409).json({ success: false, message: 'No active delivery stops remain in this run.' });
  }

  const returned = await markDeliveryRunReturned({
    assignments: runAssignments,
    actor: req.user.id,
    actorName,
    reason,
  });
  emitDeliveryRunAssignments({ tenantSlug: req.tenantSlug, assignments: returned.payloads, state: 'completed' });
  emitRiderEvent({
    tenantSlug: req.tenantSlug,
    outletId: assignment.outlet,
    event: 'rider-return:overridden',
    payload: {
      assignmentId: String(assignment._id),
      deliveryRunId: assignment.deliveryRunId || '',
      assignmentIds: returned.payloads.map((row) => row._id),
      action,
      status: 'returned_to_restaurant',
      at: returned.at,
      actorName,
    },
  });
  return res.json({
    success: true,
    data: returned.payloads.find((row) => row._id === String(assignment._id)) || returned.payloads[0],
    assignments: returned.payloads,
    deliveryRunId: assignment.deliveryRunId || '',
  });
};
export const getRiderShiftRoute = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.shiftId)) return res.status(400).json({ success: false, message: 'Invalid shift.' });
  const shift = await RiderShift.findById(req.params.shiftId).populate('rider', 'name email').lean();
  if (!shift) return res.status(404).json({ success: false, message: 'Shift not found.' });
  const outletId = await resolveOutletId(req, shift.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This shift belongs to another outlet.' });
  const points = await RiderLocationPoint.find({ shift: shift._id })
    .select('location recordedAt accuracy speed heading batteryLevel isMock assignment')
    .sort({ recordedAt: 1 })
    .limit(20_000)
    .lean();
  return res.json({ success: true, data: { shift, points: points.map((point) => ({ ...point, ...coordinatesFromGeoPoint(point.location) })) } });
};

export const getRiderOrderRoute = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) {
    return res.status(400).json({ success: false, message: 'Invalid delivery order.' });
  }
  const assignments = await DeliveryAssignment.find({ saleTransaction: req.params.orderId })
    .populate('rider', 'name email')
    .populate(DELIVERY_ASSIGNMENT_SALE_POPULATE)
    .sort({ assignedAt: 1 })
    .lean();
  if (!assignments.length) {
    return res.status(404).json({ success: false, message: 'No rider history was found for this delivery order.' });
  }
  const outletId = await resolveOutletId(req, assignments[0].outlet);
  if (!outletId) {
    return res.status(403).json({ success: false, message: 'This delivery order belongs to another outlet.' });
  }
  const pointsForAssignments = await Promise.all(assignments.map(async (assignment) => {
    const hasRouteWindow = assignment.routeStartedAt && assignment.routeEndedAt;
    const riderId = assignment.rider?._id || assignment.rider;
    const filter = hasRouteWindow
      ? { rider: riderId, recordedAt: { $gte: assignment.routeStartedAt, $lte: assignment.routeEndedAt } }
      : { assignment: assignment._id };
    const points = await RiderLocationPoint.find(filter)
      .select('location recordedAt accuracy speed heading batteryLevel isMock assignment rider')
      .sort({ recordedAt: 1 })
      .limit(20_000)
      .lean();
    return { assignmentId: String(assignment._id), points };
  }));
  const rawPoints = pointsForAssignments.flatMap((entry) => entry.points);
  const pointsByAssignment = new Map();
  for (const entry of pointsForAssignments) {
    pointsByAssignment.set(entry.assignmentId, entry.points.map((point) => ({
      ...point,
      ...coordinatesFromGeoPoint(point.location),
    })));
  }
  const publicAssignments = assignments.map(assignmentPublic);
  const routeStats = publicAssignments.map((assignment) => {
    const points = pointsByAssignment.get(String(assignment._id)) || [];
    return {
      _id: assignment._id,
      pointCount: points.length,
      firstRecordedAt: points[0]?.recordedAt || null,
      lastRecordedAt: points[points.length - 1]?.recordedAt || null,
    };
  });
  const order = groupAssignmentsByOrder(publicAssignments, routeStats)[0];
  const segments = publicAssignments.map((assignment) => {
    const points = pointsByAssignment.get(String(assignment._id)) || [];
    return {
      assignment,
      points,
      pointCount: points.length,
      distanceMeters: routeDistanceMeters(points),
      deliveryRunId: assignment.deliveryRunId || '',
      routeSequence: assignment.routeSequence || 0,
      routeStartedAt: assignment.routeStartedAt || points[0]?.recordedAt || null,
      routeEndedAt: assignment.routeEndedAt || points[points.length - 1]?.recordedAt || null,
    };
  }).sort((a, b) => Number(a.routeSequence || 0) - Number(b.routeSequence || 0));
  return res.json({
    success: true,
    data: {
      order,
      segments,
      pointCount: rawPoints.length,
      distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    },
  });
};

export const updateRiderTrackingConfig = async (req, res) => {
  const outletId = await resolveOutletId(req, req.params.outletId);
  if (!outletId) return res.status(403).json({ success: false, message: 'This outlet is not permitted.' });
  const outlet = await Outlet.findById(outletId);
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  const coordinates = coordinatesFrom(req.body);
  if (req.body?.latitude !== undefined || req.body?.longitude !== undefined) {
    if (!coordinates) return res.status(422).json({ success: false, message: 'Valid outlet latitude and longitude are required.' });
    outlet.set('riderTracking.location', geoPoint(coordinates));
  }
  for (const [key, min, max] of [
    ['geofenceRadiusMeters', 50, 2000],
    ['locationRetentionDays', 7, 730],
    ['staleAfterSeconds', 30, 900],
  ]) {
    if (req.body?.[key] !== undefined) {
      const value = Number(req.body[key]);
      if (!Number.isFinite(value) || value < min || value > max) return res.status(422).json({ success: false, message: `${key} must be between ${min} and ${max}.` });
      outlet.set(`riderTracking.${key}`, value);
    }
  }
  if (req.body?.performanceEnabled !== undefined) {
    outlet.set('riderTracking.performanceEnabled', req.body.performanceEnabled === true);
  }
  await outlet.save();
  emitRiderEvent({ tenantSlug: req.tenantSlug, outletId, event: 'rider-tracking:config', payload: { outletId: String(outletId), riderTracking: outlet.riderTracking } });
  return res.json({ success: true, data: outlet.riderTracking });
};

export const notifyAssignedRider = async (req, res) => {
  const assignment = await DeliveryAssignment.findById(req.params.id).lean();
  if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });
  const outletId = await resolveOutletId(req, assignment.outlet);
  if (!outletId) return res.status(403).json({ success: false, message: 'This assignment belongs to another outlet.' });
  emitRiderEvent({
    tenantSlug: req.tenantSlug,
    outletId: assignment.outlet,
    riderId: assignment.rider,
    event: 'rider-assignment:reminder',
    payload: {
      assignmentId: String(assignment._id),
      orderId: String(assignment.saleTransaction),
      orderNumber: assignment.orderNumber,
      at: new Date(),
    },
  });
  const push = await sendRiderAssignmentPush({riderId: assignment.rider, assignment, reminder: true})
    .catch((error) => {
      logger.warn(`[RIDER PUSH] Reminder for ${assignment.orderNumber}: ${error?.message || error}`);
      return {attempted: 0, delivered: 0, failed: 0};
    });
  return res.json({ success: true, data: { delivered: true, push } });
};

export { ACTIVE_DELIVERY_STATUSES };
