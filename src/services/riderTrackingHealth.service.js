const validDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const ageSeconds = (value, now) => {
  const date = validDate(value);
  if (!date) return null;
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
};

const latestDate = (...values) => values
  .map(validDate)
  .filter(Boolean)
  .sort((a, b) => b.getTime() - a.getTime())[0] || null;

export const riderTrackingThresholds = (configuredSeconds) => {
  const delayedAfterSeconds = Math.min(900, Math.max(30, Number(configuredSeconds) || 120));
  // Android can batch callbacks for several minutes during a radio handover or
  // brief Doze window even while the location foreground service is alive.
  // Keep that distinct from a genuinely unreachable phone. Nearest-rider
  // assignment uses the tighter usable-location threshold below, so extending
  // the offline threshold never makes an old coordinate assignable.
  const offlineAfterSeconds = Math.max(900, Math.min(1800, Math.round(delayedAfterSeconds * 7.5)));
  const usableLocationAfterSeconds = Math.max(180, Math.min(600, Math.round(delayedAfterSeconds * 2.5)));
  return { delayedAfterSeconds, offlineAfterSeconds, usableLocationAfterSeconds };
};

export const riderTrackingHealth = ({ shift, device, staleAfterSeconds, now = new Date() }) => {
  const onDuty = Boolean(shift);
  const { delayedAfterSeconds, offlineAfterSeconds, usableLocationAfterSeconds } = riderTrackingThresholds(staleAfterSeconds);
  const locationRecordedAt = validDate(shift?.lastLocation?.recordedAt);
  // Existing shifts created before lastLocationReceivedAt was added fall back
  // to recordedAt. New writes always use the server receipt timestamp.
  const locationReceivedAt = validDate(shift?.lastLocationReceivedAt) || locationRecordedAt;
  const deviceSeenAt = validDate(device?.lastSeenAt);
  const lastSignalAt = latestDate(locationReceivedAt, deviceSeenAt);
  const locationAgeSeconds = ageSeconds(locationRecordedAt, now);
  const locationReceiptAgeSeconds = ageSeconds(locationReceivedAt, now);
  const signalAgeSeconds = ageSeconds(lastSignalAt, now);
  const deviceAgeSeconds = ageSeconds(deviceSeenAt, now);
  const locationSignalIsNewer = Boolean(locationReceivedAt
    && (!deviceSeenAt || locationReceivedAt.getTime() >= deviceSeenAt.getTime()));
  const trackingInterrupted = onDuty
    && device?.trackingEnabled === false
    && deviceAgeSeconds != null
    && deviceAgeSeconds <= offlineAfterSeconds
    && !locationSignalIsNewer;
  const deviceOnline = deviceAgeSeconds != null && deviceAgeSeconds <= offlineAfterSeconds;
  const gpsUnavailable = onDuty
    && deviceOnline
    && (locationReceiptAgeSeconds == null || locationReceiptAgeSeconds > offlineAfterSeconds);
  const locationUsable = onDuty
    && locationAgeSeconds != null
    && locationReceiptAgeSeconds != null
    && locationAgeSeconds <= usableLocationAfterSeconds
    && locationReceiptAgeSeconds <= usableLocationAfterSeconds;

  let trackingState = 'off_duty';
  if (onDuty) {
    if (trackingInterrupted) trackingState = 'interrupted';
    else if (signalAgeSeconds == null || signalAgeSeconds > offlineAfterSeconds) trackingState = 'offline';
    else if (gpsUnavailable) trackingState = 'gps_unavailable';
    else if (locationReceiptAgeSeconds == null || locationReceiptAgeSeconds > delayedAfterSeconds) trackingState = 'delayed';
    else trackingState = 'live';
  }

  const trackingOnline = trackingState === 'live' || trackingState === 'delayed' || trackingState === 'gps_unavailable';
  return {
    trackingState,
    trackingOnline,
    trackingInterrupted,
    locationDelayed: trackingState === 'delayed',
    gpsUnavailable,
    deviceOnline,
    locationUsable,
    // Keep the legacy field for older clients, but reserve it for a genuinely
    // interrupted/offline service instead of a short GPS delivery delay.
    stale: trackingState === 'offline' || trackingState === 'interrupted' || trackingState === 'gps_unavailable',
    locationAgeSeconds,
    locationReceiptAgeSeconds,
    deviceAgeSeconds,
    signalAgeSeconds,
    lastSignalAt,
    lastLocationReceivedAt: locationReceivedAt,
    delayedAfterSeconds,
    offlineAfterSeconds,
    usableLocationAfterSeconds,
  };
};

export default riderTrackingHealth;
