import { afterEach } from 'vitest';
import { clearAnswerDrafts } from './decisions/cycle/answer-draft.js';
import { resetFallbackQueryStore } from './lib/query-store.js';

// Components outside the app shell share one query store; each test starts with an empty one.
// Stop answer drafts are held for the session (R-C16 16b review); each test starts with none.
afterEach(() => {
  resetFallbackQueryStore();
  clearAnswerDrafts();
});
