import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES as preferences,
  nextReminderAt,
  notificationText,
  validTimeZone,
} from './notification.js';
describe('attention reminder schedule', () => {
  it('sends at 30 minutes, then 1 through 6 hours from initial acceptance, then 9 pm local', () => {
    const start = '2026-09-10T15:00:00.000Z'; // 8 am Pacific
    let sent = start;
    for (const minute of [30, 60, 120, 180, 240, 300, 360]) {
      const next = new Date(Date.parse(start) + minute * 60_000).toISOString();
      expect(nextReminderAt(start, sent, preferences)).toBe(next);
      sent = next;
    }
    expect(nextReminderAt(start, sent, preferences)).toBe('2026-09-11T04:00:00.000Z');
    expect(nextReminderAt(start, '2026-09-11T04:00:00.000Z', preferences)).toBe(
      '2026-09-12T04:00:00.000Z',
    );
  });
  it('skips missed phases after downtime', () => {
    expect(nextReminderAt('2026-09-10T15:00:00Z', '2026-09-10T18:40:00Z', preferences)).toBe(
      '2026-09-10T19:00:00.000Z',
    );
    expect(nextReminderAt('2026-09-10T15:00:00Z', '2026-09-15T10:00:00Z', preferences)).toBe(
      '2026-09-16T04:00:00.000Z',
    );
  });
  it.each([
    ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00.000Z'],
  ])('keeps 9 pm across Pacific daylight saving transitions after %s', (sent, next) => {
    expect(nextReminderAt('2026-01-01T00:00:00Z', sent, preferences)).toBe(next);
  });
  it('handles non-hour offsets and skips nonexistent custom local times', () => {
    expect(
      nextReminderAt('2026-01-01T00:00:00Z', '2026-09-10T14:00:00Z', {
        ...preferences,
        timeZone: 'Asia/Kathmandu',
      }),
    ).toBe('2026-09-10T15:15:00.000Z');
    expect(
      nextReminderAt('2026-01-01T00:00:00Z', '2026-03-08T09:00:00Z', {
        ...preferences,
        dailyTime: '02:30',
      }),
    ).toBe('2026-03-09T09:30:00.000Z');
    expect(
      nextReminderAt('2026-01-01T00:00:00Z', '2026-11-01T08:30:00Z', {
        ...preferences,
        dailyTime: '01:30',
      }),
    ).toBe('2026-11-02T09:30:00.000Z');
  });
  it('validates timezone names and truncates without splitting Unicode characters', () => {
    expect(validTimeZone('America/Los_Angeles')).toBe(true);
    expect(validTimeZone('not-a-zone')).toBe(false);
    expect(notificationText('😀'.repeat(1100), 1024)).toBe(`${'😀'.repeat(1023)}…`);
  });
});
