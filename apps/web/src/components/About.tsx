import type { ReactNode } from 'react';

/**
 * Where model explanations live. The prose that used to sit under every panel
 * title moves in here, so a section shows state first and explains itself on
 * request. It reads the same on every visit, so it starts closed.
 */
export function About({
  label = 'About this section',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="about">
      <summary>{label}</summary>
      <div className="about-body">{children}</div>
    </details>
  );
}
