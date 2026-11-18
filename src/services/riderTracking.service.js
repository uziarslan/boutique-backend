import { getIo } from '../utils/socket.js';

export const coordinatesFrom = (input) => {
  if (!input) return null;
  const latitude = Number(input.latitude ?? input.lat);
  const longitude = Number(input.longitude ?? input.lng ?? input.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
};

export const geoPoint = (input) => {
  const coordinates = coordinatesFrom(input);
  return coordinates
    ? { type: 'Point', coordinates: [coordinates.longitude, coordinates.latitude] }
    : null;
};

export const locationSnapshot = (input, recordedAt = new Date()) => {
  const location = geoPoint(input);
  if (!location) return null;
  const capturedAt = new Date(input?.recordedAt || recordedAt);
  if (!Number.isFinite(capturedAt.getTime())) return null;
  const accuracy = Number(input?.accuracy);
  const batteryLevel = Number(input?.batteryLevel);
  return {
    location,
    recordedAt: capturedAt,
    accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
    batteryLevel: Number.isFinite(batteryLevel) && batteryLevel >= 0 && batteryLevel <= 100
      ? batteryLevel
      : null,
    isMock: input?.isMock === true,
  };
};

export const metersBetween = (a, b) => {
  const first = coordinatesFrom(a);
  const second = coordinatesFrom(b);
  if (!first || !second) return null;
  const radians = (degrees) => degrees * (Math.PI / 180);
  const dLat = radians(second.latitude - first.latitude);
  const dLon = radians(second.longitude - first.longitude);
  const lat1 = radians(first.latitude);
  const lat2 = radians(second.latitude);
  const haversine = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

export const coordinatesFromGeoPoint = (point) => {
  const values = point?.coordinates;
  if (!Array.isArray(values) || values.length !== 2) return null;
  return coordinatesFrom({ longitude: values[0], latitude: values[1] });
};

export const emitRiderEvent = ({ tenantSlug, outletId, riderId, event, payload }) => {
  if (!tenantSlug || !event) return;
  const io = getIo();
  if (!io) return;
  if (outletId) io.to(`rider-dispatch:${tenantSlug}:${String(outletId)}`).emit(event, payload);
  if (riderId) io.to(`rider:${tenantSlug}:${String(riderId)}`).emit(event, payload);
};

export default {
  coordinatesFrom,
  geoPoint,
  locationSnapshot,
  metersBetween,
  coordinatesFromGeoPoint,
  emitRiderEvent,
};
