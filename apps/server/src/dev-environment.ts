import { developmentDefaults } from './dev-defaults.js';

/** Applies the development defaults (`dev-defaults.ts`) before the daemon reads its settings. */
Object.assign(process.env, developmentDefaults(process.env));
