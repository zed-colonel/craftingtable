export interface SectionNavItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/**
 * "On this page" links for long pages. Sections stay expanded so nothing is
 * hidden behind a tab; the nav just gets the reader there. It sticks under the
 * compact header on phones as a scrolling chip row.
 */
export function SectionNav({ items }: { items: readonly SectionNavItem[] }) {
  if (items.length < 2) {
    return null;
  }
  return (
    <nav className="section-nav" aria-label="On this page">
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`} className="section-nav-link">
          {item.label}
          {item.count !== undefined && <span className="section-nav-count">{item.count}</span>}
        </a>
      ))}
    </nav>
  );
}
