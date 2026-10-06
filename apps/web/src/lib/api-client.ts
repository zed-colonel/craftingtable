import {
  type ApiErrorResponse,
  type AuthenticatedSessionResponse,
  apiErrorResponseSchema,
  authenticatedSessionResponseSchema,
  type ChangePasswordResponse,
  type CreateWorkspaceResponse,
  changePasswordResponseSchema,
  createWorkspaceResponseSchema,
  type LoginRequest,
  logoutResponseSchema,
  type RenameWorkspaceResponse,
  renameWorkspaceResponseSchema,
  revokeSessionResponseSchema,
  type SessionListResponse,
  sessionListResponseSchema,
  stepUpResponseSchema,
  type WorkspaceAuditPageResponse,
  type WorkspaceListResponse,
  type WorkspaceSnapshotResponse,
  workspaceAuditPageResponseSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import type { SessionId, WorkspaceId } from '@craftingtable/domain';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

/** The machine-readable part of an error beyond its code, when the daemon sends one. */
export interface ApiErrorDetail {
  readonly reason?: ApiErrorResponse['error']['reason'];
  readonly paths?: readonly string[];
  readonly pathCount?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: ApiErrorDetail = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The last validator and value of each read (R-D5, PERF-16), in memory only: the daemon answers
 * `no-store`, so no authenticated answer reaches the browser's disk cache, and the app revalidates
 * itself. An unchanged read comes back as 304 with no body and returns the same value, which the
 * query store then sees as unchanged. The newest `VALIDATOR_LIMIT` reads are kept.
 */
const validators = new Map<string, { readonly tag: string; readonly value: unknown }>();
const VALIDATOR_LIMIT = 64;

/** Forgets every read's validator: on signing in or out, and between tests. */
export function forgetValidators(): void {
  validators.clear();
}

/**
 * Asks the operator for their password again: `failed` when the last one given did not match.
 * Resolves undefined when they decline (R-G9).
 */
export type StepUpPrompt = (failed: boolean) => Promise<string | undefined>;
let stepUpPrompt: StepUpPrompt | undefined;

/** The signed-in app's password prompt, for commands that need step-up; undefined removes it. */
export function setStepUpPrompt(prompt: StepUpPrompt | undefined): void {
  stepUpPrompt = prompt;
}

/**
 * Sends a request and reads its answer. A command the daemon refuses until the operator gives
 * their password again (an unrestricted run, a final promotion: R-G9) asks for it through the
 * app's prompt, steps the session up, and is sent once more; declining leaves the refusal.
 */
export async function request<T>(
  url: string,
  schema: ResponseSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  try {
    return await send(url, schema, init);
  } catch (error) {
    const prompt = stepUpPrompt;
    if (
      prompt === undefined ||
      !(error instanceof ApiError) ||
      error.detail.reason !== 'step-up-required' ||
      (init.method ?? 'GET').toUpperCase() === 'GET'
    )
      throw error;
    const csrf = new Headers(init.headers).get('x-craftingtable-csrf') ?? '';
    for (let failed = false; ; failed = true) {
      const password = await prompt(failed);
      if (password === undefined) throw error;
      try {
        await send('/api/auth/step-up', stepUpResponseSchema, {
          method: 'POST',
          headers: { 'x-craftingtable-csrf': csrf },
          body: JSON.stringify({ password }),
        });
        break;
      } catch (refusal) {
        // Only a password that did not match is asked for again; any other refusal stands.
        if (!(refusal instanceof ApiError) || refusal.detail.reason !== 'step-up-failed')
          throw refusal;
      }
    }
    return send(url, schema, init);
  }
}

async function send<T>(url: string, schema: ResponseSchema<T>, init: RequestInit): Promise<T> {
  const read = (init.method ?? 'GET').toUpperCase() === 'GET';
  const held = read ? validators.get(url) : undefined;
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(held === undefined ? {} : { 'if-none-match': held.tag }),
      ...init.headers,
    },
  });
  if (held !== undefined && response.status === 304) {
    validators.delete(url);
    validators.set(url, held);
    return held.value as T;
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorResponseSchema.safeParse(body);
    if (!error.success)
      throw new ApiError(
        response.status,
        'internal-error',
        'The server returned an invalid error response',
      );
    const { code, message, ...detail } = error.data.error;
    throw new ApiError(response.status, code, message, detail);
  }
  const value = parseAnswer(url, schema, body);
  if (read) {
    validators.delete(url);
    const tag = response.headers.get('etag');
    if (tag !== null) {
      validators.set(url, { tag, value });
      for (const oldest of validators.keys()) {
        if (validators.size <= VALIDATOR_LIMIT) break;
        validators.delete(oldest);
      }
    }
  }
  return value;
}

/**
 * Reads a successful answer through its contract. An answer the contract refuses is a defect
 * between the daemon and the app, not a state a page can explain, so it is also said in the
 * browser console, where the e2e suite fails on it (TS-M15); the read fails as before.
 * `body` is undefined when it could not be read, as when a navigation abandons the read
 * partway: that read fails without a word, since nothing broke the contract.
 */
export function parseAnswer<T>(url: string, schema: ResponseSchema<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (body !== undefined)
      console.error(`The daemon's answer to ${url} does not match its contract.`, error);
    throw error;
  }
}

export async function loadSession(): Promise<AuthenticatedSessionResponse | undefined> {
  try {
    return await request('/api/auth/session', authenticatedSessionResponseSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return undefined;
    }
    throw error;
  }
}

export function login(input: LoginRequest): Promise<AuthenticatedSessionResponse> {
  forgetValidators();
  return request('/api/auth/login', authenticatedSessionResponseSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function loadSessions(): Promise<SessionListResponse> {
  return request('/api/auth/sessions', sessionListResponseSchema);
}

export async function logout(csrfToken: string): Promise<void> {
  try {
    await request('/api/auth/logout', logoutResponseSchema, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({}),
    });
  } finally {
    forgetValidators();
  }
}

export async function revokeSession(sessionId: SessionId, csrfToken: string): Promise<boolean> {
  const response = await request(
    `/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
    revokeSessionResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({}),
    },
  );
  return response.currentSessionRevoked;
}

export function loadWorkspaces(): Promise<WorkspaceListResponse> {
  return request('/api/workspaces', workspaceListResponseSchema);
}

export function createWorkspace(name: string, csrfToken: string): Promise<CreateWorkspaceResponse> {
  return request('/api/workspaces', createWorkspaceResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify({ name }),
  });
}

export function renameWorkspace(
  workspaceId: WorkspaceId,
  name: string,
  csrfToken: string,
): Promise<RenameWorkspaceResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/rename`,
    renameWorkspaceResponseSchema,
    {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify({ name }),
    },
  );
}

export function changePassword(
  input: { currentPassword: string; newPassword: string },
  csrfToken: string,
): Promise<ChangePasswordResponse> {
  return request('/api/auth/password', changePasswordResponseSchema, {
    method: 'POST',
    headers: { 'x-craftingtable-csrf': csrfToken },
    body: JSON.stringify(input),
  });
}

export function loadWorkspaceSnapshot(
  workspaceId: WorkspaceId,
): Promise<WorkspaceSnapshotResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/snapshot`,
    workspaceSnapshotResponseSchema,
  );
}

export function loadWorkspaceAudit(workspaceId: WorkspaceId): Promise<WorkspaceAuditPageResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/audit?limit=25`,
    workspaceAuditPageResponseSchema,
  );
}
