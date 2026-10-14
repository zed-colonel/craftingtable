import { configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { clearAnswerDrafts } from './decisions/cycle/answer-draft.js';
import { forgetValidators } from './lib/api-client.js';
import { cancelPendingReveal } from './lib/reveal-element.js';
import { resetFallbackQueryStore } from './lib/query-store.js';
import { asyncWaitMs } from './test-time.js';

// `findBy…` and `waitFor` wait on a clock, not a step: one scaled bound for all (R-I2).
configure({ asyncUtilTimeout: asyncWaitMs() });

// Components outside the app shell share one query store; each test starts with an empty one.
// Stop answer drafts are held for the session (R-C16 16b review); each test starts with none,
// and with no read's validator (R-D5).
// A reveal still waiting for its target holds a timer of up to ten seconds, which would fire after
// its test file's environment is gone ("window is not defined"): none outlives its test.
afterEach(() => {
  resetFallbackQueryStore();
  clearAnswerDrafts();
  forgetValidators();
  cancelPendingReveal();
});
