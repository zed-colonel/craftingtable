import type { ReactNode } from 'react';

/**
 * The controls that apply to a page or section, in one row: the primary action
 * first, then secondary ones, danger last. A page-level bar can stick to the
 * bottom of a phone screen so the next step is never off-screen.
 */
export function ActionBar({
  label,
  sticky = false,
  children,
}: {
  label: string;
  sticky?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className={`action-bar${sticky ? ' action-bar-sticky' : ''}`}>
      <legend className="visually-hidden">{label}</legend>
      {children}
    </fieldset>
  );
}
