type NotificationEvent = { dedupeKey?: string | null };
type StaffAudience = 'admin' | 'staff';

// Only these operational events may reach staff outside the portal. Keep the
// event keys aligned with their emitters; message text is never an access rule.
function staffAudience({ dedupeKey }: NotificationEvent): StaffAudience | null {
  const key = dedupeKey ?? '';
  if (
    /^installation:\d+:appointment:\d+:response:(?:ACCEPT|REQUEST_RESCHEDULE)$/.test(key) ||
    /^order:\d+:extra:\d+:response:(?:PAYMENT_DUE|REJECTED):creator$/.test(key)
  ) return 'staff';

  if (
    /^payment:\d+:paid:admin$/.test(key) ||
    /^payment:\d+:partial:.+:admin$/.test(key) ||
    /^refund:[a-zA-Z0-9_-]+:review$/.test(key) ||
    /^order:\d+:pickup:selected:admin$/.test(key) ||
    /^order:\d+:delivery:\d+:selected:admin$/.test(key) ||
    /^installation:\d+:quote:(?:\d+|latest):customer:(?:APPROVED|REJECTED):admin$/.test(key) ||
    /^installation:\d+:appointment:\d+:response:(?:ACCEPT|REQUEST_RESCHEDULE):admin$/.test(key) ||
    /^order:\d+:extra:\d+:response:(?:PAYMENT_DUE|REJECTED):admin$/.test(key) ||
    /^network-business:\d+:(?:requested|applied:admin)$/.test(key) ||
    /^estimate-note-storage:warning:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
  ) return 'admin';

  return null;
}

export function isStaffNotification(notification: NotificationEvent): boolean {
  return staffAudience(notification) !== null;
}

export function allowsStaffNotificationDelivery(notification: NotificationEvent, roleName: string): boolean {
  const audience = staffAudience(notification);
  const role = roleName.toLowerCase();
  return audience === 'admin' ? role === 'admin'
    : audience === 'staff' && (role === 'admin' || role === 'operator');
}

// Retired quote-only events must also be skipped if an old queued delivery is
// encountered after deployment. Paid installation cancellation remains active.
export function isSuppressedInstallationNotification({ dedupeKey }: NotificationEvent): boolean {
  return /^installation:\d+:(?:(?:deposit-due|no-deposit):owner|canceled:admin)$/.test(dedupeKey ?? '');
}
