/**
 * Build-time constants injected by tsup's `define` (and vitest's `define` for
 * the source-run test path). A module that references `__LENSES_VERSION__`
 * without one of those defines active will read `undefined` at runtime; the
 * server.ts version test pins that the replacement is wired.
 */

declare const __LENSES_VERSION__: string;
