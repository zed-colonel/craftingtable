import type { SessionId, UserId } from './ids.js';

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SESSION_STATUSES = ['active', 'revoked'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface User {
  readonly id: UserId;
  readonly username: string;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt?: string;
  readonly version: number;
}

export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLowerCase();
}
