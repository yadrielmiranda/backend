import {
  allowsStaffNotificationDelivery,
  isStaffNotification,
  isSuppressedInstallationNotification,
} from './notification-delivery-policy';

const adminEvents = [
  'payment:12:paid:admin',
  'payment:12:partial:pi_example:admin',
  'payment:12:partial:2026-11-18T12:00:00.000Z:admin',
  'refund:re_example:review',
  'order:20:pickup:selected:admin',
  'order:20:delivery:3:selected:admin',
  'installation:5:quote:8:customer:APPROVED:admin',
  'installation:5:quote:latest:customer:REJECTED:admin',
  'installation:5:appointment:9:response:ACCEPT:admin',
  'installation:5:appointment:9:response:REQUEST_RESCHEDULE:admin',
  'order:20:extra:3:response:PAYMENT_DUE:admin',
  'order:20:extra:3:response:REJECTED:admin',
  'network-business:6:requested',
  'network-business:6:applied:admin',
  'estimate-note-storage:warning:12345678-1234-4234-8234-123456789abc',
];
const creatorEvents = [
  'installation:5:appointment:9:response:ACCEPT',
  'installation:5:appointment:9:response:REQUEST_RESCHEDULE',
  'order:20:extra:3:response:PAYMENT_DUE:creator',
  'order:20:extra:3:response:REJECTED:creator',
];

describe('staff notification delivery scope', () => {
  it.each(adminEvents)('limits %s to administrators', dedupeKey => {
    const notification = { dedupeKey };
    expect(isStaffNotification(notification)).toBe(true);
    expect(allowsStaffNotificationDelivery(notification, 'admin')).toBe(true);
    for (const role of ['operator', 'dealer', 'client', 'technician']) {
      expect(allowsStaffNotificationDelivery(notification, role)).toBe(false);
    }
  });

  it.each(creatorEvents)('permits the staff recipient of %s', dedupeKey => {
    const notification = { dedupeKey };
    expect(isStaffNotification(notification)).toBe(true);
    for (const role of ['admin', 'operator']) {
      expect(allowsStaffNotificationDelivery(notification, role)).toBe(true);
    }
    for (const role of ['dealer', 'client', 'technician']) {
      expect(allowsStaffNotificationDelivery(notification, role)).toBe(false);
    }
  });

  it.each([
    null,
    'order:20:created:owner',
    'order:20:delivery:3:payment:owner',
    'installation:5:quote:8:admin-approval',
    'installation:5:quote:8:admin:APPROVED:owner',
    'installation:5:remeasurement-completed:admin',
    'material-revision:4:applied',
    'material-sale:3:paid',
    'material-sale:3:paid:customer',
    'network-business:6:reviewed',
    'order:20:extra:3:response:PAYMENT_DUE:creator:unexpected',
    'installation:5:appointment:9:response:proposed',
  ])('does not extend staff access to unrelated event %s', dedupeKey => {
    expect(isStaffNotification({ dedupeKey })).toBe(false);
    expect(allowsStaffNotificationDelivery({ dedupeKey }, 'admin')).toBe(false);
    expect(allowsStaffNotificationDelivery({ dedupeKey }, 'operator')).toBe(false);
  });

  it.each([
    'installation:5:deposit-due:owner',
    'installation:5:no-deposit:owner',
    'installation:5:canceled:admin',
  ])('retires queued quote-only notice %s', dedupeKey => {
    expect(isSuppressedInstallationNotification({ dedupeKey })).toBe(true);
  });

  it.each([
    'installation:5:canceled:owner',
    'installation:5:dealer-measurements-accepted',
    'installation:5:appointment:9:proposed:owner',
    'installation:5:started:owner',
    'installation:5:completed:owner',
    'payment:12:paid:admin',
    null,
  ])('preserves operational notification %s', dedupeKey => {
    expect(isSuppressedInstallationNotification({ dedupeKey })).toBe(false);
  });
});
