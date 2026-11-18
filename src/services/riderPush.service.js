import RiderDevice from '../models/RiderDevice.js';
import logger from '../utils/logger.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const ASSIGNMENT_CHANNEL_ID = 'rider-assignments-v2';
const TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export const isExpoPushToken = (value) => TOKEN_PATTERN.test(String(value || '').trim());

export const assignmentPushMessage = ({ token, assignment, reminder = false }) => ({
  to: token,
  title: reminder
    ? 'Delivery reminder'
    : assignment.pickupState === 'queued_at_restaurant' ? 'Order added to your next pickup' : 'New delivery assigned',
  body: reminder
    ? `Please review order ${assignment.orderNumber}.`
    : assignment.pickupState === 'queued_at_restaurant'
      ? `Order ${assignment.orderNumber} is waiting at the restaurant. It will join your next pickup run.`
      : `Order ${assignment.orderNumber} is ready for you. Tap to view the customer and order information.`,
  data: {
    type: reminder ? 'delivery_reminder' : 'delivery_assignment',
    screen: 'deliveries',
    assignmentId: String(assignment._id),
    orderId: String(assignment.saleTransaction || ''),
    orderNumber: String(assignment.orderNumber || ''),
  },
  sound: 'default',
  priority: 'high',
  channelId: ASSIGNMENT_CHANNEL_ID,
  ttl: 60 * 60 * 6,
});

const clearUnregisteredTokens = async (devices, tickets) => {
  const staleIds = tickets
    .map((ticket, index) => ticket?.details?.error === 'DeviceNotRegistered' ? devices[index]?._id : null)
    .filter(Boolean);
  if (staleIds.length) {
    await RiderDevice.updateMany({_id: {$in: staleIds}}, {$set: {pushToken: ''}});
  }
};

export const sendRiderAssignmentPush = async ({ riderId, assignment, reminder = false }) => {
  const rows = await RiderDevice.find({rider: riderId, isActive: true})
    .select('_id pushToken')
    .sort({lastSeenAt: -1})
    .lean();
  const devices = rows.filter((row) => isExpoPushToken(row.pushToken));
  if (!devices.length) {
    logger.warn(`[RIDER PUSH] No registered Expo token for rider ${riderId}; order ${assignment.orderNumber} was not pushed.`);
    return {attempted: 0, delivered: 0, failed: 0, skippedReason: 'NO_PUSH_TOKEN'};
  }

  const messages = devices.map((device) => assignmentPushMessage({
    token: device.pushToken,
    assignment,
    reminder,
  }));
  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
    ...(process.env.EXPO_ACCESS_TOKEN ? {Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}`} : {}),
  };
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(8_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.errors?.[0]?.message || `Expo push request failed (${response.status}).`);
  }
  const tickets = Array.isArray(result?.data) ? result.data : [];
  await clearUnregisteredTokens(devices, tickets);
  const delivered = tickets.filter((ticket) => ticket?.status === 'ok').length;
  const failed = Math.max(0, messages.length - delivered);
  if (failed) {
    logger.warn(`[RIDER PUSH] ${failed}/${messages.length} notification(s) were rejected for order ${assignment.orderNumber}.`);
  }
  return {
    attempted: messages.length,
    delivered,
    failed,
    ticketIds: tickets.map((ticket) => ticket?.id).filter(Boolean),
  };
};

export default {isExpoPushToken, assignmentPushMessage, sendRiderAssignmentPush};
