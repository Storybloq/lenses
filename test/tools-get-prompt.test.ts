import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import {
  handleLensReviewGetPrompt,
  GetPromptOutputSchema,
} from "../src/tools/get-prompt.js";
import {
  handleLensReviewStart,
  StartToolOutputSchema,
} from "../src/tools/start.js";
import { _resetForTests } from "../src/state/review-state.js";

async function startPlan(lenses: string[]): Promise<{ reviewId: string; agentIds: string[] }> {
  const res = await handleLensReviewStart({
    method: "tools/call",
    params: {
      name: "lens_review_start",
      arguments: {
        stage: "PLAN_REVIEW",
        artifact: "## Plan\n\nDo the thing.",
        ticketDescription: null,
        reviewRound: 1,
        lensConfig: { lenses },
      },
    },
  });
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error();
  const parsed = StartToolOutputSchema.parse(JSON.parse(first.text));
  return {
    reviewId: parsed.reviewId,
    agentIds: parsed.agents.map((a) => a.id),
  };
}

async function callGetPrompt(args: Record<string, unknown>): Promise<{
  isError: boolean;
  body: unknown;
  text: string;
}> {
  const res = await handleLensReviewGetPrompt({
    method: "tools/call",
    params: { name: "lens_review_get_prompt", arguments: args },
  });
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error();
  const text = String(first.text);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain error */
  }
  return { isError: Boolean(res.isError), body, text };
}

beforeEach(() => _resetForTests());
afterEach(() => _resetForTests());

describe("lens_review_get_prompt", () => {
  it("returns the full lens prompt for a registered (reviewId, lensId)", async () => {
    const { reviewId, agentIds } = await startPlan(["security"]);
    const lensId = agentIds[0];
    if (!lensId) throw new Error();

    const { isError, body } = await callGetPrompt({ reviewId, lensId });
    expect(isError).toBe(false);
    const parsed = GetPromptOutputSchema.parse(body);
    expect(parsed.prompt).toContain("## Safety");
    expect(parsed.prompt).toContain("Lens: security");
  });

  it("rejects an unknown reviewId", async () => {
    const { isError, text } = await callGetPrompt({
      reviewId: "not-a-real-review-id",
      lensId: "security",
    });
    expect(isError).toBe(true);
    expect(text).toContain("unknown reviewId");
  });

  it("rejects a lensId that was not activated for this review", async () => {
    const { reviewId } = await startPlan(["security"]);
    const { isError, text } = await callGetPrompt({
      reviewId,
      lensId: "accessibility", // not in the activation set
    });
    expect(isError).toBe(true);
    expect(text).toContain("no prompt registered");
  });

  it("rejects invalid arguments", async () => {
    const { isError, text } = await callGetPrompt({ reviewId: "" });
    expect(isError).toBe(true);
    expect(text).toContain("invalid arguments");
  });
});

describe("lens_review_get_prompt -- MCP round-trip", () => {
  it("is reachable over the MCP transport and serializes correctly", async () => {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTx);
    const client = new Client(
      { name: "lenses-get-prompt-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTx);
    try {
      const startResult = await client.request(
        {
          method: "tools/call",
          params: {
            name: "lens_review_start",
            arguments: {
              stage: "PLAN_REVIEW",
              artifact: "## Plan\n\nDo it.",
              ticketDescription: null,
              reviewRound: 1,
              lensConfig: { lenses: ["security"] },
            },
          },
        },
        CallToolResultSchema,
      );
      const startFirst = startResult.content[0];
      if (!startFirst || startFirst.type !== "text") throw new Error();
      const started = StartToolOutputSchema.parse(JSON.parse(startFirst.text));

      const gpResult = await client.request(
        {
          method: "tools/call",
          params: {
            name: "lens_review_get_prompt",
            arguments: { reviewId: started.reviewId, lensId: "security" },
          },
        },
        CallToolResultSchema,
      );
      expect(gpResult.isError).not.toBe(true);
      const gpFirst = gpResult.content[0];
      if (!gpFirst || gpFirst.type !== "text") throw new Error();
      const parsed = GetPromptOutputSchema.parse(JSON.parse(gpFirst.text));
      expect(parsed.prompt.length).toBeGreaterThan(100);
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

describe("hop-1 response size (T-022 <5KB goal)", () => {
  it("a 6-lens CODE_REVIEW hop-1 response fits under 5KB", async () => {
    // Activate the full complement of lenses via a TS file so the
    // performance + test-quality lenses fire too. Clear cache state
    // so the response carries all six in `agents[]` (none in cached[]).
    _resetForTests();
    const res = await handleLensReviewStart({
      method: "tools/call",
      params: {
        name: "lens_review_start",
        arguments: {
          stage: "CODE_REVIEW",
          artifact: "diff --git a/x b/x\n+x",
          ticketDescription: null,
          reviewRound: 1,
          changedFiles: ["src/foo.ts"],
        },
      },
    });
    const first = res.content[0];
    if (!first || first.type !== "text") throw new Error();
    expect(first.text.length).toBeLessThan(5_000);
    const parsed = StartToolOutputSchema.parse(JSON.parse(first.text));
    expect(parsed.agents.length).toBe(6);
    // Each agent entry has exactly the four T-022 fields.
    for (const a of parsed.agents) {
      expect(a).toHaveProperty("id");
      expect(a).toHaveProperty("model");
      expect(a).toHaveProperty("promptHash");
      expect(a).toHaveProperty("expiresAt");
    }
  });
});
