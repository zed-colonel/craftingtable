/**
 * Loading this module makes Node resolve the workspace's TypeScript source in place of its
 * build output (TS-H6). A module of this package that runs from `.ts` (the tests) launches its
 * helpers in plain `node`, which strips types but resolves `@craftingtable/*` through the
 * packages' `exports` to `dist/` and has no `./x.js` to `./x.ts` mapping. Without these hooks
 * a child then ran the last build, or failed where there was none. Built, nothing loads this
 * module: production still runs `dist/`.
 *
 * The hooks add the `source` export condition to the workspace's own packages, which map it
 * to their `src/index.ts` (a dependency that published one would otherwise resolve to source
 * Node will not strip inside `node_modules`), and resolve a missing `./x.js` imported by a
 * `.ts` module to `./x.ts`, as `tsc` does. Node strips types only from erasable syntax, so a
 * module run this way must be written in it, as the domain is.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@craftingtable/'))
      return nextResolve(specifier, {
        ...context,
        conditions: [...context.conditions, 'source'],
      });
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        specifier.startsWith('.') &&
        specifier.endsWith('.js') &&
        context.parentURL?.endsWith('.ts') === true
      )
        return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
      throw error;
    }
  },
});
