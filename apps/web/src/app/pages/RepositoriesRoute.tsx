import { RepositoriesPage } from '../../features/execution/RepositoriesPage.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { registerRepository, retireRepository } from '../../lib/execution-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { useCommands } from '../commands.js';
import { useExecutionStatus, useRepositories } from '../reads.js';
import { useSession, useWorkspaceScope } from '../session.js';

/** The workspace's registered repositories and their adopted checks. */
export function RepositoriesRoute() {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const repositories = useRepositories(workspaceId).data?.repositories ?? [];
  const status = useExecutionStatus().data;
  const commands = useCommands(() => store.refreshNow([queryKeys.repositories(workspaceId)]));
  return (
    <RepositoriesPage
      repositories={repositories}
      {...(status === undefined ? {} : { status })}
      canMutate={canMutate}
      busy={commands.busy}
      {...(commands.error === undefined ? {} : { error: commands.error })}
      onRegister={(input) => commands.run(() => registerRepository(workspaceId, input, csrfToken))}
      onRetire={(repositoryId) =>
        commands.run(() => retireRepository(workspaceId, repositoryId, csrfToken))
      }
      checks={{ workspaceId, csrfToken }}
    />
  );
}
