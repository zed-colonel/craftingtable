import type { AttentionItemView } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import type { ReactNode } from 'react';
import { About } from '../../components/About.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { ATTENTION_CODE_LABELS } from '../../lib/attention-labels.js';
import { Link, PathLink } from '../../lib/navigation.js';
import type { Route } from '../../lib/route.js';

/**
 * The "Needs you" inbox (R-A5): every open attention item, most blocking first, and one
 * item's decision. The detail renders the decisions the registry chooses from the item's code
 * (R-A6, `decisions/registry.ts`).
 */
export function InboxPage({
  workspaceId,
  items,
  loaded,
  selectedId,
  now,
  onNavigate,
  renderHost,
}: {
  workspaceId: WorkspaceId;
  items: readonly AttentionItemView[];
  loaded: boolean;
  selectedId?: string;
  now: number;
  onNavigate: (route: Route) => void;
  /** The decisions that resolve this item. */
  renderHost: (item: AttentionItemView) => ReactNode;
}) {
  const selected = items.find((item) => item.id === selectedId);
  const link = (route: Route, label: ReactNode, className = 'text-button') => (
    <Link
      className={className}
      route={route}
      onClick={(event) => {
        // Isolated tests render without the app's navigation; in the app this is `go`.
        event.preventDefault();
        onNavigate(route);
      }}
    >
      {label}
    </Link>
  );
  return (
    <div className="page">
      <PageHeader
        title="Needs you"
        subtitle={
          loaded ? `${items.length} open ${items.length === 1 ? 'item' : 'items'}` : 'Loading…'
        }
      />
      <About label="About Needs you">
        <p>
          Each item is a stop only you can move. Items are listed by how much work waits on them,
          then by age. Notifications open the same items.
        </p>
      </About>
      {selectedId !== undefined && selected === undefined && loaded && (
        <p className="empty-state" role="status">
          This item is resolved. {link({ name: 'inbox', workspaceId }, 'Back to the inbox')}
        </p>
      )}
      {selected !== undefined && (
        <Section
          title={ATTENTION_CODE_LABELS[selected.code]}
          label="Decision"
          tone="attention"
          summary={selected.title}
          actions={link({ name: 'inbox', workspaceId }, 'All items')}
        >
          <p className="attention-message" role="status">
            {selected.message}
          </p>
          <StatusStrip
            label="Item facts"
            facts={[
              { label: 'Waiting since', value: ago(selected.openedAt, now) },
              { label: 'Unblocks', value: selected.blocks, mono: true },
              {
                label: 'Notified',
                value: selected.pushedAt === null ? 'Not yet' : ago(selected.pushedAt, now),
              },
            ]}
          />
          <p>
            <PathLink className="text-button" path={selected.path}>
              Open where it happened
            </PathLink>
          </p>
          <div className="inbox-host">{renderHost(selected)}</div>
        </Section>
      )}
      <Section title="Open items" label="Open items" count={items.length}>
        {loaded && items.length === 0 ? (
          <p className="empty-state">Nothing needs you right now.</p>
        ) : (
          <ul className="attention-list">
            {items.map((item) => (
              <li
                key={item.id}
                className="attention-row"
                aria-current={item.id === selectedId ? 'true' : undefined}
              >
                {link(
                  { name: 'inbox', workspaceId, itemId: item.id },
                  ATTENTION_CODE_LABELS[item.code],
                )}
                <span className="attention-reason">
                  <span className="attention-title">{item.title}</span>
                  {item.blocks > 0 ? ` · unblocks ${item.blocks}` : ''} · {ago(item.openedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ago(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
