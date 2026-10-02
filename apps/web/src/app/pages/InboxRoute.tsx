import type { AttentionItemView } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { InboxHost } from '../../decisions/InboxHost.js';
import { InboxPage } from '../../features/inbox/InboxPage.js';
import { useGo, useWorkspaceScope } from '../session.js';

/** The "Needs you" inbox: each item hosts the decisions that resolve it (R-A5, R-A6). */
export function InboxRoute({
  attention,
  loaded,
  subjectOf,
  cycles,
  selectedId,
}: {
  attention: readonly AttentionItemView[];
  loaded: boolean;
  /** The subject of an item listed earlier, which may have resolved since (TS-M1). */
  subjectOf: (itemId: string) => string | undefined;
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
      subjectOf={subjectOf}
      {...(selectedId === undefined ? {} : { selectedId })}
      onNavigate={go}
      renderHost={(item) => (
        <InboxHost key={item.id} item={item} attention={attention} workspaceCycles={cycles} />
      )}
    />
  );
}
