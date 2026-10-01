import { afterEach } from 'vitest';
import { resetFallbackQueryStore } from './lib/query-store.js';

// Components outside the app shell share one query store; each test starts with an empty one.
afterEach(() => resetFallbackQueryStore());
