import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  LENS_REVIEW_COMPLETE_NAME,
  handleLensReviewComplete,
  lensReviewCompleteDefinition,
} from "./tools/complete.js";
import {
  LENS_REVIEW_START_NAME,
  handleLensReviewStart,
  lensReviewStartDefinition,
} from "./tools/start.js";

const SERVER_INFO = { name: "lenses", version: "0.0.0" } as const;

/**
 * Build a configured MCP Server. Tool handlers are wired here; transport is not —
 * callers pick stdio (for the CLI bin) or an in-memory pair (for tests).
 */
export function createServer(): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [lensReviewStartDefinition, lensReviewCompleteDefinition],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    switch (req.params.name) {
      case LENS_REVIEW_START_NAME:
        return handleLensReviewStart(req);
      case LENS_REVIEW_COMPLETE_NAME:
        return handleLensReviewComplete(req);
      default:
        throw new Error(`Unknown tool: ${req.params.name}`);
    }
  });

  return server;
}

/**
 * Entry point for the CLI bin. Binds the server to stdio transport and blocks
 * until the client disconnects (SIGTERM / stdin closed).
 */
export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
