import type { ReactNode } from 'react';

/**
 * The top of every page: where the reader is, what it is called, and the one
 * status plus the actions that apply to the whole page. Sections below never
 * repeat the title or re-state the page-level state.
 */
export function PageHeader({
  crumbs,
  title,
  subtitle,
  status,
  actions,
}: {
  /** Ancestor links, rendered small above the title. */
  crumbs?: ReactNode;
  title: ReactNode;
  /** One line of context under the title. Not an explanation of the model. */
  subtitle?: ReactNode;
  /** The page-level state badge, kept beside the actions so it is never off-screen. */
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {crumbs !== undefined && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {subtitle !== undefined && <p className="subtitle">{subtitle}</p>}
      </div>
      {(status !== undefined || actions !== undefined) && (
        <div className="page-header-actions">
          {status}
          {actions}
        </div>
      )}
    </header>
  );
}
