import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Mirror tsup.config.ts's `define` so source-level runs (vitest transforms
 * `src/**` via esbuild, not through the tsup output) resolve the same
 * `__LENSES_VERSION__` constant the built `dist/` output carries. Without
 * this, tests that read `createServer().version` would see `undefined`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __LENSES_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
