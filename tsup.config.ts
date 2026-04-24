import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "tsup";

/**
 * Read the version once at config load and inject it as a build-time constant.
 * Prevents `SERVER_INFO.version` from drifting away from `package.json` on every
 * release -- esbuild's `define` replaces the bare identifier at transform time
 * so `dist/cli.js` and `dist/index.js` always carry the published version.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(here, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  shims: false,
  define: {
    __LENSES_VERSION__: JSON.stringify(pkg.version),
  },
});
