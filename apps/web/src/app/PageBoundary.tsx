import { Component, type ReactNode } from 'react';

/**
 * Catches a page that failed to load or render (R-D5 review): pages load with their routes, so
 * a tab opened before a deploy can ask for code the new release no longer has. The page says so
 * and offers a reload; the shell around it stays. A new route shows a new page (keyed by the
 * host), which starts without the failure.
 */
export class PageBoundary extends Component<
  { readonly children: ReactNode; readonly reload?: () => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <p role="alert" className="error-state">
          This page could not be loaded. The app may have been updated since this tab opened.
        </p>
        <p className="inline-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
          >
            Reload
          </button>
        </p>
      </div>
    );
  }
}
