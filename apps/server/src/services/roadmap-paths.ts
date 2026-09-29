/**
 * A roadmap's own pages in the browser (R-E2): its board, setup or history, and the element to
 * bring into view there. `ws` is already encoded. Links stored before the split
 * (`/roadmaps?roadmap=<id>#<focus>`) still open the right page in the browser.
 */
export function roadmapPath(
  ws: string,
  roadmapId: string,
  tab?: 'setup' | 'history',
  focus?: string,
): string {
  return `/workspaces/${ws}/roadmaps/${encodeURIComponent(roadmapId)}${tab ? `/${tab}` : ''}${
    focus ? `#${encodeURIComponent(focus)}` : ''
  }`;
}
