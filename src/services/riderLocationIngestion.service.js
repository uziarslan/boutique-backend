import DeliveryAssignment from '../models/DeliveryAssignment.js';
import Outlet from '../models/Outlet.js';
import RiderDevice from '../models/RiderDevice.js';
import RiderEvent from '../models/RiderEvent.js';
import RiderLocationPoint from '../models/RiderLocationPoint.js';
import RiderShift from '../models/RiderShift.js';
import {
  coordinatesFrom,
  coordinatesFromGeoPoint,
  geoPoint,
  metersBetween,
} from './riderTracking.service.js';
import {
  assignmentForRecordedAt,
} from './riderOrderRoute.service.js';
import {
  departWithReadyAssignments,
  prepareQueuedAssignmentsAtOutlet,
} from './riderDeliveryRun.service.js';
import { remainingLocationQueueDepth } from './riderTrackingUpload.service.js';

export class RiderLocationIngestionError extends Error {
  constructor(message, { status = 422, code = 'INVALID_TRACKING_BATCH' } = {}) {
    super(message);
    this.name = 'RiderLocationIngestionError';
    this.status = status;
    this.code = code;
  }
}

const safeClientDate = (value, now = new Date()) => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getTime() > now.getTime() + 300_000 || date.getTime() < now.getTime() - 86_400_000) return null;
  return date;
};

export const trackingDeviceUpdate = ({ body, now, locationReceived = false }) => {
  const batteryLevel = Number(body?.batteryLevel);
  const queueDepth = Number(body?.trackingHealth?.queueDepth ?? body?.queueDepth);
  const reportedMode = body?.trackingHealth?.mode || body?.trackingMode;
  const trackingMode = ['background', 'foreground', 'stopped'].includes(reportedMode)
    ? reportedMode
    : null;
  const taskCallbackAt = safeClientDate(body?.trackingHealth?.taskCallbackAt || body?.lastTaskCallbackAt, now);
  const watchdogAt = safeClientDate(body?.trackingHealth?.watchdogAt || body?.lastWatchdogAt, now);
  const lastError = String(body?.trackingHealth?.lastError || body?.lastTrackingError || '').slice(0, 500);
  const consecutiveUploadFailures = Number(body?.trackingHealth?.consecutiveUploadFailures);
  const permission = ['precise', 'approximate', 'denied', 'unknown'].includes(body?.locationPermission)
    ? body.locationPermission
    : undefined;
  return {
    lastSeenAt: now,
    trackingEnabled: body?.trackingEnabled === true || locationReceived,
    ...(trackingMode ? { trackingMode } : locationReceived ? { trackingMode: 'background' } : {}),
    ...(locationReceived ? { lastLocationReceivedAt: now, lastUploadAt: now } : {}),
    ...(Number.isFinite(batteryLevel) && batteryLevel >= 0 && batteryLevel <= 100 ? { batteryLevel } : {}),
    ...(Number.isFinite(queueDepth) && queueDepth >= 0 && queueDepth <= 1000 ? { locationQueueDepth: Math.round(queueDepth) } : {}),
    ...(taskCallbackAt ? { lastTaskCallbackAt: taskCallbackAt } : {}),
    ...(watchdogAt ? { lastWatchdogAt: watchdogAt } : {}),
    ...(permission ? { locationPermission: permission } : {}),
    ...(typeof body?.backgroundLocationGranted === 'boolean' ? { backgroundLocationGranted: body.backgroundLocationGranted } : {}),
    ...(typeof body?.batteryOptimizationEnabled === 'boolean' ? { batteryOptimizationEnabled: body.batteryOptimizationEnabled } : {}),
    ...(typeof body?.lowPowerMode === 'boolean' ? { lowPowerMode: body.lowPowerMode } : {}),
    ...(Number.isFinite(consecutiveUploadFailures) && consecutiveUploadFailures >= 0
      ? { consecutiveUploadFailures: Math.min(10_000, Math.round(consecutiveUploadFailures)) }
      : {}),
    lastTrackingError: lastError,
  };
};

export const touchRiderDevice = async ({ riderId, outletId, body, now, locationReceived = false }) => {
  const deviceId = String(body?.deviceId || '').trim();
  const filter = deviceId
    ? { rider: riderId, deviceId }
    : { rider: riderId, isActive: true };
  return RiderDevice.findOneAndUpdate(
    filter,
    { $set: {
      ...trackingDeviceUpdate({ body, now, locationReceived }),
      ...(deviceId ? { outlet: outletId, platform: 'android', isActive: true } : {}),
    } },
    { sort: { lastSeenAt: -1 }, returnDocument: 'after', upsert: Boolean(deviceId), runValidators: true },
  );
};

const publicRunAssignments = async ({ riderId, deliveryRunId }) => {
  if (!deliveryRunId) return [];
  return DeliveryAssignment.find({ rider: riderId, active: true, deliveryRunId })
    .sort({ assignedAt: 1 })
    .lean();
};

export const processRiderLocationBatch = async ({
  tenantSlug,
  riderId,
  shiftId,
  body,
  onEvent = () => {},
}) => {
  const points = Array.isArray(body?.points) ? body.points : [];
  if (!points.length || points.length > 100) {
    throw new RiderLocationIngestionError('Send between 1 and 100 location points.');
  }

  const shiftFilter = shiftId
    ? { _id: shiftId, rider: riderId }
    : { rider: riderId, status: 'active' };
  const shift = await RiderShift.findOne(shiftFilter);
  if (!shift) {
    throw new RiderLocationIngestionError('Start duty before sending location.', {
      status: 409,
      code: 'NO_ACTIVE_SHIFT',
    });
  }

  const outlet = await Outlet.findById(shift.outlet).select('riderTracking').lean();
  const [activeAssignments, existingPointRows] = await Promise.all([
    DeliveryAssignment.find({ rider: riderId, active: true }).select('_id deliveryRunId pickupState').lean(),
    RiderLocationPoint.find({
      rider: riderId,
      clientPointId: { $in: points.map((point) => String(point?.clientPointId || '')).filter(Boolean) },
    }).select('clientPointId').lean(),
  ]);
  const existingIds = new Set(existingPointRows.map((row) => row.clientPointId));
  const now = new Date();
  const latestBattery = [...points].reverse().find((point) => Number.isFinite(Number(point?.batteryLevel)))?.batteryLevel;
  const remainingQueueDepth = remainingLocationQueueDepth(
    body?.trackingHealth?.queueDepth ?? body?.queueDepth,
    points.length,
  );
  const deviceBody = {
    ...body,
    batteryLevel: latestBattery ?? body?.batteryLevel,
    queueDepth: remainingQueueDepth,
    trackingHealth: {
      ...(body?.trackingHealth || {}),
      queueDepth: remainingQueueDepth,
      consecutiveUploadFailures: 0,
      lastError: '',
    },
  };
  const retentionDays = Number(outlet?.riderTracking?.locationRetentionDays || 90);
  const expiresAt = new Date(now.getTime() + retentionDays * 86_400_000);
  const acceptedCandidates = points
    .map((point) => ({
      point,
      coordinates: coordinatesFrom(point),
      recordedAt: new Date(point.recordedAt || now),
    }))
    .filter(({ point, coordinates, recordedAt }) => {
      const clientPointId = String(point?.clientPointId || '');
      if (!coordinates || !clientPointId || clientPointId.length > 120 || existingIds.has(clientPointId)
        || !Number.isFinite(recordedAt.getTime())
        || recordedAt.getTime() > now.getTime() + 300_000
        || recordedAt.getTime() < now.getTime() - 86_400_000) return false;
      existingIds.add(clientPointId);
      return true;
    });

  if (!acceptedCandidates.length) {
    await touchRiderDevice({ riderId, outletId: shift.outlet, body: deviceBody, now });
    return { accepted: 0, duplicates: points.length, remainingQueueDepth };
  }

  const recordedTimes = acceptedCandidates.map(({ recordedAt }) => recordedAt.getTime());
  const firstRecordedAt = new Date(Math.min(...recordedTimes));
  const lastRecordedAt = new Date(Math.max(...recordedTimes));
  const assignmentWindows = await DeliveryAssignment.find({
    rider: riderId,
    assignedAt: { $lte: lastRecordedAt },
    $or: [{ completedAt: null }, { completedAt: { $gte: firstRecordedAt } }],
  }).select('_id assignedAt completedAt').sort({ assignedAt: 1 }).lean();
  const accepted = acceptedCandidates
    .map(({ point, coordinates, recordedAt }) => {
      const pointAssignment = assignmentForRecordedAt(assignmentWindows, recordedAt);
      return {
        rider: riderId,
        outlet: shift.outlet,
        shift: shift._id,
        assignment: pointAssignment?._id || null,
        clientPointId: String(point.clientPointId),
        location: geoPoint(coordinates),
        recordedAt,
        receivedAt: now,
        accuracy: Number.isFinite(Number(point.accuracy)) && Number(point.accuracy) >= 0 ? Number(point.accuracy) : null,
        speed: Number.isFinite(Number(point.speed)) && Number(point.speed) >= 0 ? Number(point.speed) : null,
        heading: Number.isFinite(Number(point.heading)) && Number(point.heading) >= 0 && Number(point.heading) <= 360 ? Number(point.heading) : null,
        altitude: Number.isFinite(Number(point.altitude)) ? Number(point.altitude) : null,
        batteryLevel: Number.isFinite(Number(point.batteryLevel)) && Number(point.batteryLevel) >= 0 && Number(point.batteryLevel) <= 100 ? Number(point.batteryLevel) : null,
        isMock: point.isMock === true,
        source: ['gps', 'network', 'passive'].includes(point.source) ? point.source : 'unknown',
        expiresAt,
      };
    })
    .sort((a, b) => a.recordedAt - b.recordedAt);

  try {
    await RiderLocationPoint.insertMany(accepted, { ordered: false });
  } catch (error) {
    // A retried BullMQ job may race with an earlier attempt. The compound
    // clientPointId index makes retries idempotent; duplicate-key-only writes
    // are therefore successful replays rather than failed tracking jobs.
    if (error?.code !== 11000 && !error?.writeErrors?.every((row) => row?.err?.code === 11000 || row?.code === 11000)) throw error;
  }

  const previousRecordedAt = shift.lastLocation?.recordedAt ? new Date(shift.lastLocation.recordedAt).getTime() : 0;
  const pointsNewerThanShift = accepted.filter((point) => (
    !previousRecordedAt || point.recordedAt.getTime() >= previousRecordedAt
  ));
  let distanceMeters = 0;
  let previous = coordinatesFromGeoPoint(shift.lastLocation?.location);
  for (const point of pointsNewerThanShift) {
    const current = coordinatesFromGeoPoint(point.location);
    const segment = previous ? metersBetween(previous, current) : 0;
    if (Number.isFinite(segment) && segment >= 2 && segment <= 5000) distanceMeters += segment;
    previous = current;
  }
  const latest = accepted[accepted.length - 1];
  const latestSnapshot = {
    location: latest.location,
    recordedAt: latest.recordedAt,
    accuracy: latest.accuracy,
    batteryLevel: latest.batteryLevel,
    isMock: latest.isMock,
  };
  const outletCoords = coordinatesFromGeoPoint(outlet?.riderTracking?.location);
  const latestCoords = coordinatesFromGeoPoint(latest.location);
  const geofenceDistance = outletCoords ? metersBetween(outletCoords, latestCoords) : null;
  const updatesLatestPosition = !previousRecordedAt || latest.recordedAt.getTime() >= previousRecordedAt;
  const measuredInOutletGeofence = geofenceDistance == null
    ? shift.inOutletGeofence
    : geofenceDistance <= Number(outlet?.riderTracking?.geofenceRadiusMeters || 150);
  const inOutletGeofence = updatesLatestPosition ? measuredInOutletGeofence : shift.inOutletGeofence;
  const geofenceChanged = updatesLatestPosition
    && shift.inOutletGeofence !== null
    && inOutletGeofence !== null
    && shift.inOutletGeofence !== inOutletGeofence;
  if (updatesLatestPosition) {
    shift.lastLocation = latestSnapshot;
    shift.lastLocationReceivedAt = now;
  }
  shift.pointCount += accepted.length;
  shift.distanceMeters += distanceMeters;
  shift.inOutletGeofence = inOutletGeofence;
  await Promise.all([
    shift.save(),
    touchRiderDevice({ riderId, outletId: shift.outlet, body: deviceBody, now, locationReceived: true }),
  ]);

  if (geofenceChanged) {
    await RiderEvent.create({
      rider: riderId,
      outlet: shift.outlet,
      shift: shift._id,
      type: inOutletGeofence ? 'outlet_entered' : 'outlet_exited',
      metadata: { distanceMeters: geofenceDistance },
    });
  }

  const runChange = updatesLatestPosition && inOutletGeofence === true
    ? await prepareQueuedAssignmentsAtOutlet({ riderId, at: latest.recordedAt })
    : geofenceChanged
      ? { changed: await departWithReadyAssignments({ riderId, at: latest.recordedAt }), deliveryRunId: '' }
      : { changed: 0, deliveryRunId: '' };
  if (runChange.changed > 0) {
    const changedAssignments = runChange.deliveryRunId
      ? await publicRunAssignments({ riderId, deliveryRunId: runChange.deliveryRunId })
      : await DeliveryAssignment.find({
          rider: riderId,
          active: true,
          pickupState: 'with_rider',
        }).sort({ assignedAt: 1 }).lean();
    await onEvent({
      tenantSlug,
      outletId: String(shift.outlet),
      riderId: String(riderId),
      event: 'rider-run:updated',
      payload: {
        riderId: String(riderId),
        deliveryRunId: runChange.deliveryRunId || changedAssignments[0]?.deliveryRunId || '',
        state: inOutletGeofence ? 'ready_for_pickup' : 'out_for_delivery',
        orderCount: runChange.changed,
        assignments: changedAssignments,
      },
    });
  }
  if (accepted.some((point) => point.isMock)) {
    await RiderEvent.create({ rider: riderId, outlet: shift.outlet, shift: shift._id, type: 'mock_location', metadata: { count: accepted.filter((point) => point.isMock).length } });
  }
  await onEvent({
    tenantSlug,
    outletId: String(shift.outlet),
    riderId: String(riderId),
    event: 'rider-location:updated',
    payload: {
      riderId: String(riderId),
      shiftId: String(shift._id),
      assignmentId: activeAssignments[0]?._id ? String(activeAssignments[0]._id) : null,
      assignmentIds: activeAssignments.map((assignment) => String(assignment._id)),
      latitude: latestCoords.latitude,
      longitude: latestCoords.longitude,
      accuracy: latest.accuracy,
      batteryLevel: latest.batteryLevel,
      isMock: latest.isMock,
      recordedAt: latest.recordedAt,
      receivedAt: now,
      inOutletGeofence,
    },
  });

  return {
    accepted: accepted.length,
    duplicates: points.length - accepted.length,
    remainingQueueDepth,
    shift: {
      _id: shift._id,
      pointCount: shift.pointCount,
      distanceMeters: shift.distanceMeters,
      inOutletGeofence,
    },
  };
};

export default {
  processRiderLocationBatch,
  touchRiderDevice,
  trackingDeviceUpdate,
};
