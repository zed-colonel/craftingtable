import type { AttentionItemView } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { InboxHost } from '../../decisions/InboxHost.js';
import { InboxPage } from '../../features/inbox/InboxPage.js';
import { useGo, useWorkspaceScope } from '../session.js';

/** The "Needs you" inbox: each item hosts the decisions that resolve it (R-A5, R-A6). */
export function InboxRoute({
  attention,
  loaded,
  cycles,
  selectedId,
}: {
  attention: readonly AttentionItemView[];
  loaded: boolean;
  cycles: readonly WorkCycle[];
  selectedId?: string;
}) {
  const { workspaceId } = useWorkspaceScope();
  const go = useGo();
  return (
    <InboxPage
      workspaceId={workspaceId}
      items={attention}
      loaded={loaded}
      {...(selectedId === undefined ? {} : { selectedId })}
      onNavigate={go}
      renderHost={(item) => (
        <InboxHost key={item.id} item={item} attention={attention} workspaceCycles={cycles} />
      )}
    />
  );
}
