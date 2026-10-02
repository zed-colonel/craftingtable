import type { AuthenticatedSessionResponse, WorkspaceOverview } from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { useNavigation } from '../lib/navigation.js';
import type { Route } from '../lib/route.js';

/** The signed-in session, as every page sees it (R-D4 increment 4b). */
export interface Session {
  readonly user: AuthenticatedSessionResponse['user'];
  readonly csrfToken: string;
  /** The daemon said the session ended: the app asks to sign in again. */
  readonly expire: () => void;
}

/** The workspace a page is about, and what the user may do in it. */
export interface WorkspaceScope {
  readonly workspaceId: WorkspaceId;
  readonly workspace: WorkspaceOverview;
  /** An owner or an editor. */
  readonly canMutate: boolean;
  readonly isOwner: boolean;
}

/**
 * The worktree whose cycle the work item page shows. The inbox and the run page choose it, then
 * open the work item, so it outlives either page.
 */
export interface CycleFocus {
  readonly worktreeId: WorktreeId | undefined;
  readonly focus: (worktreeId: WorktreeId | undefined) => void;
}

const SessionContext = createContext<Session | undefined>(undefined);
const WorkspaceContext = createContext<WorkspaceScope | undefined>(undefined);
const CycleFocusContext = createContext<CycleFocus | undefined>(undefined);
export const SessionProvider = SessionContext.Provider;
export const WorkspaceProvider = WorkspaceContext.Provider;
export const CycleFocusProvider = CycleFocusContext.Provider;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is read outside the app shell.`);
  return value;
}
export const useSession = (): Session => required(useContext(SessionContext), 'The session');
export const useWorkspaceScope = (): WorkspaceScope =>
  required(useContext(WorkspaceContext), 'The workspace');
export const useCycleFocus = (): CycleFocus =>
  required(useContext(CycleFocusContext), 'The cycle focus');
/** Opens another page in the app. */
export const useGo = (): ((route: Route) => void) =>
  required(useNavigation(), 'Navigation').navigate;

/**
 * Whether the component that asked is still mounted. A page is keyed by its workspace, so a
 * command's result that arrives after a change of workspace is dropped, never shown under the
 * new one (CT03-R2R3).
 */
export function useAlive(): () => boolean {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return useCallback(() => alive.current, []);
}
