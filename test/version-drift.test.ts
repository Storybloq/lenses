import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

/**
 * T-023: guard against `SERVER_INFO.version` drifting from `package.json`.
 * If tsup's `define` (or vitest's matching entry) stops substituting
 * `__LENSES_VERSION__`, this test fails with a concrete version-mismatch
 * message rather than a silent `undefined` served over the MCP wire.
 */
describe("version drift", () => {
  it("MCP server advertises the package.json version", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8"),
    ) as { version: string };

    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTx);
    const client = new Client(
      { name: "lenses-version-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTx);

    try {
      const info = client.getServerVersion();
      expect(info).toBeDefined();
      expect(info?.name).toBe("lenses");
      expect(info?.version).toBe(pkg.version);
      expect(info?.version).not.toBe("0.0.0");
      expect(info?.version).not.toBeUndefined();
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      try {
        await server.close();
      } catch {
        /* ignore */
      }
    }
  });
});
