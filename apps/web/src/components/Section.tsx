import type { ReactNode } from 'react';

/**
 * One titled area of a page.
 *
 * The head carries the title, an optional count, a one-line summary of the
 * section's current state, and the actions that belong to the section. Model
 * explanations do not live in the head; they go in an `About` disclosure inside
 * the body. Reference and history sections are `collapsible` and start closed;
 * working sections are always open.
 *
 * The `section` element keeps its landmark role and accessible name whether or
 * not the body is collapsed, so tests and assistive technology find it the
 * same way in both states.
 */
export function Section({
  id,
  title,
  label,
  count,
  summary,
  actions,
  collapsible = false,
  defaultOpen = true,
  tone,
  children,
}: {
  /** Anchor for `SectionNav`; also used as the DOM id. */
  id?: string;
  title: ReactNode;
  /** Accessible name when the title is not plain text. Defaults to the title. */
  label?: string;
  count?: number;
  summary?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Attention-worthy sections get an accent border. */
  tone?: 'attention' | 'blocked' | 'ready';
  children?: ReactNode;
}) {
  const name = label ?? (typeof title === 'string' ? title : undefined);
  const head = (withActions: boolean) => (
    <>
      <div className="section-title">
        <h2>{title}</h2>
        {count !== undefined && <span className="section-count">{count}</span>}
      </div>
      {summary !== undefined && <p className="section-summary">{summary}</p>}
      {withActions && actions !== undefined && <div className="section-actions">{actions}</div>}
    </>
  );
  const className = `panel section${tone === undefined ? '' : ` section-${tone}`}`;
  if (collapsible) {
    // A button inside <summary> would also toggle the body, so actions sit in the body.
    return (
      <section id={id} className={className} aria-label={name}>
        <details open={defaultOpen} className="section-details">
          <summary className="section-head">{head(false)}</summary>
          <div className="section-body">
            {actions !== undefined && <div className="section-actions">{actions}</div>}
            {children}
          </div>
        </details>
      </section>
    );
  }
  return (
    <section id={id} className={className} aria-label={name}>
      <div className="section-head">{head(true)}</div>
      {children !== undefined && <div className="section-body">{children}</div>}
    </section>
  );
}
