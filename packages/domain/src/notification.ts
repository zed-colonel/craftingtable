/** Reminder times are measured from the first accepted delivery, not failed attempts. */
export const REMINDER_MINUTES = [30, 60, 120, 180, 240, 300, 360] as const;
export interface NotificationPreferences {
  readonly enabled: boolean;
  readonly mergeReady: boolean;
  readonly needsAttention: boolean;
  readonly timeZone: string;
  readonly dailyTime: string;
  readonly device: string;
}
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  mergeReady: true,
  needsAttention: true,
  timeZone: 'America/Los_Angeles',
  dailyTime: '21:00',
  device: '',
};
export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
/** Skip elapsed reminders after downtime instead of replaying a burst. */
export function nextReminderAt(
  firstSentAt: string,
  acceptedAt: string,
  preferences: NotificationPreferences,
): string {
  const now = Date.parse(acceptedAt);
  for (const minutes of REMINDER_MINUTES) {
    const candidate = Date.parse(firstSentAt) + minutes * 60_000;
    if (candidate > now) return new Date(candidate).toISOString();
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: preferences.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const local = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${get('hour')}:${get('minute')}`,
    };
  };
  const previous = local(now);
  // Searching actual instants handles DST and non-hour offsets. A nonexistent
  // local time is skipped; a repeated local time fires at most once that day.
  for (
    let candidate = Math.floor(now / 60_000) * 60_000 + 60_000;
    candidate <= now + 72 * 3_600_000;
    candidate += 60_000
  ) {
    const next = local(candidate);
    if (
      next.time === preferences.dailyTime &&
      !(previous.time >= preferences.dailyTime && next.date === previous.date)
    )
      return new Date(candidate).toISOString();
  }
  throw new Error('No daily reminder time within three days');
}
export function notificationText(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`;
}
