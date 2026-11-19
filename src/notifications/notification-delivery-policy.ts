type NotificationEvent = { dedupeKey?: string | null };
type StaffAudience = 'admin' | 'staff';

// The emitter addresses a branch application only to the dealer who issued its invitation.
export function registrationReviewerRole({ dedupeKey }: NotificationEvent): 'admin' | 'dealer' | null {
  const audience = /^dealer-registration:\d+:submitted:(admin|inviter)$/.exec(dedupeKey ?? '')?.[1];
  if (!audience) return null;
  return audience === 'admin' ? 'admin' : 'dealer';
}

// Emitters select the project owner; this only controls delivery channels.
// Keep account/network notices and repeated public-view pings out of this scope.
const ownerProjectEvents = [
  /^estimate:\d+:order-review:owner$/,
  /^order:\d+:created:owner$/,
  /^order:\d+:status:\d+:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /^order:\d+:installation-balance-due$/,
  /^order:\d+:extra:\d+:approval:owner$/,
  /^order:\d+:pickup:completed:owner$/,
  /^order:\d+:delivery:\d+:(?:payment|completed):owner$/,
  /^order:\d+:delivery:\d+:scheduled:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /^material-revision:\d+:approval$/,
  /^installation:\d+:dealer-measurements-accepted$/,
  /^installation:\d+:(?:canceled|remeasurement-unchanged|started|completed):owner$/,
  /^installation:\d+:quote:(?:\d+|latest):admin:(?:APPROVED|REJECTED):owner$/,
  /^installation:\d+:permit:(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|[A-Z_]+):owner$/,
  /^installation:\d+:appointment:\d+:proposed:owner$/,
  /^payment:\d+:paid(?::.+)?:owner$/,
  /^payment:\d+:partial:.+:owner$/,
  /^payment:\d+:received:(?:stripe|checkout|manual):[a-zA-Z0-9_-]+:owner$/,
];

export function isOwnerProjectNotification({ dedupeKey }: NotificationEvent): boolean {
  return ownerProjectEvents.some(pattern => pattern.test(dedupeKey ?? ''));
}

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
    /^payment:\d+:received:(?:stripe|checkout|manual):[a-zA-Z0-9_-]+:admin$/.test(key) ||
    /^refund:[a-zA-Z0-9_-]+:review$/.test(key) ||
    /^referral-payout:\d+:requested:admin$/.test(key) ||
    /^order:\d+:created:admin$/.test(key) ||
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
