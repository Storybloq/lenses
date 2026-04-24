import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createServer } from "../src/server.js";

/**
 * T-023 acceptance: the MCP-handshake version must match `package.json` so
 * callers never observe `0.0.0` on a published build. Reading it here at test
 * time pins the tsup/vitest `define` wiring end-to-end.
 */
const PKG_VERSION = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(resolve(here, "..", "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
})();

async function connectedPair() {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTx);
  const client = new Client(
    { name: "lenses-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTx);
  return { client, server };
}

async function closeQuietly(
  client: Client,
  server: Awaited<ReturnType<typeof createServer>>,
): Promise<void> {
  // In `finally`, swallow close errors so the original assertion failure
  // surfaces instead of being masked by a transport-already-closed error.
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

describe("MCP server skeleton", () => {
  it("completes the MCP handshake and advertises tool capability", async () => {
    const { client, server } = await connectedPair();
    try {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.tools).toBeDefined();
      expect(client.getServerVersion()).toEqual({
        name: "lenses",
        version: PKG_VERSION,
      });
    } finally {
      await closeQuietly(client, server);
    }
  });

  it("listTools returns both lens tools with the defined shapes", async () => {
    const { client, server } = await connectedPair();
    try {
      const result = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["lens_review_complete", "lens_review_start"]);
      for (const tool of result.tools) {
        expect(typeof tool.description).toBe("string");
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
    } finally {
      await closeQuietly(client, server);
    }
  });

  it("calling lens_review_start with no arguments surfaces a Zod error via isError", async () => {
    // Real handler (T-008); full happy-path coverage lives in
    // test/tools-start.test.ts. This assertion only pins the error-surface
    // shape at the MCP boundary so the server-level test doesn't regress.
    const { client, server } = await connectedPair();
    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: "lens_review_start", arguments: {} },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const first = result.content[0];
      expect(first?.type).toBe("text");
      if (first?.type === "text") {
        expect(first.text).toContain("lens_review_start: invalid arguments");
      }
    } finally {
      await closeQuietly(client, server);
    }
  });

  it("calling lens_review_complete with no arguments surfaces a Zod error via isError", async () => {
    // Real handler (T-009); full happy-path coverage lives in
    // test/tools-complete.test.ts. This assertion only pins the
    // error-surface shape at the MCP boundary so the server-level
    // test doesn't regress.
    const { client, server } = await connectedPair();
    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: "lens_review_complete", arguments: {} },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const first = result.content[0];
      expect(first?.type).toBe("text");
      if (first?.type === "text") {
        expect(first.text).toContain("lens_review_complete: invalid arguments");
      }
    } finally {
      await closeQuietly(client, server);
    }
  });

  it("calling an unknown tool rejects and the error mentions the tool name", async () => {
    const { client, server } = await connectedPair();
    try {
      await expect(
        client.request(
          {
            method: "tools/call",
            params: { name: "definitely-not-a-tool", arguments: {} },
          },
          CallToolResultSchema,
        ),
      ).rejects.toThrow(/definitely-not-a-tool/);
    } finally {
      await closeQuietly(client, server);
    }
  });
});
