import { describe, it, expect } from "vitest";
import { createServer } from "../src/server.js";

describe("toolchain smoke", () => {
  it("createServer returns a server instance", async () => {
    const server = createServer();
    try {
      expect(server).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
