import { Link } from '../../lib/navigation.js';
import type { BoardView, Route } from '../../lib/route.js';

const LABELS: Record<BoardView, string> = { board: 'Board', graph: 'Graph', list: 'List' };

/** Board, graph or list (R-E3b): each a link, so the view is in the address. */
export function BoardViewSwitch({
  shown,
  route,
  views = ['board', 'list'],
}: {
  shown: BoardView;
  route: (view: BoardView) => Route;
  views?: readonly BoardView[];
}) {
  return (
    <nav aria-label="Board views" className="board-views">
      {views.map((view) => (
        <Link
          key={view}
          route={route(view)}
          className={`board-view${view === shown ? ' board-view-current' : ''}`}
          {...(view === shown ? { 'aria-current': 'page' as const } : {})}
        >
          {LABELS[view]}
        </Link>
      ))}
    </nav>
  );
}
