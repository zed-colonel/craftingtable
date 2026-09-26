import type { AttentionItemView } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { ATTENTION_CODE_LABELS } from '../lib/attention-labels.js';
import { buildPath, type Route } from '../lib/route.js';
import { Section } from './Section.js';

/**
 * What needs the operator, from the daemon's attention items (R-A5). The dashboard shows
 * the top items; every other page shows a compact line per item. Both link to the item in
 * the inbox, the one place its decision is made.
 */
export function NeedsYou({
  items,
  workspaceId,
  variant,
  onNavigate,
  limit = 5,
}: {
  items: readonly AttentionItemView[];
  workspaceId: WorkspaceId;
  variant: 'strip' | 'section';
  onNavigate: (route: Route) => void;
  limit?: number;
}) {
  if (items.length === 0) return null;
  const open = (itemId: string) => onNavigate({ name: 'inbox', workspaceId, itemId });
  const rows = (variant === 'section' ? items.slice(0, limit) : items).map((item) => {
    const route: Route = { name: 'inbox', workspaceId, itemId: item.id };
    return (
      <li key={item.id} className="attention-row">
        <a
          className="text-button"
          href={buildPath(route)}
          onClick={(event) => {
            event.preventDefault();
            open(item.id);
          }}
        >
          {ATTENTION_CODE_LABELS[item.code]}
        </a>
        <span className="attention-reason">
          {item.title}
          {item.blocks > 0 ? ` · unblocks ${item.blocks}` : ''}
        </span>
      </li>
    );
  });
  if (variant === 'section') {
    return (
      <Section
        title="Needs you"
        label="Needs you"
        count={items.length}
        tone="attention"
        summary="Automation stopped for decisions only you can make."
        actions={
          <a
            className="text-button"
            href={buildPath({ name: 'inbox', workspaceId })}
            onClick={(event) => {
              event.preventDefault();
              onNavigate({ name: 'inbox', workspaceId });
            }}
          >
            Open inbox
          </a>
        }
      >
        <ul className="attention-list">{rows}</ul>
      </Section>
    );
  }
  return (
    <section className="attention-strip" aria-label="Needs you">
      <ul className="attention-list compact">{rows}</ul>
    </section>
  );
}
