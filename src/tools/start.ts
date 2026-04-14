import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export const LENS_REVIEW_START_NAME = "lens_review_start";

/**
 * Tool definition returned via listTools. Typed with `satisfies` so any drift
 * from the SDK's expected shape becomes a compile error rather than a runtime
 * protocol mismatch.
 */
export const lensReviewStartDefinition = {
  name: LENS_REVIEW_START_NAME,
  description:
    "Begin a multi-lens review. Returns prompts for the agent to spawn as subagents, " +
    "plus any cached lens findings. Hop 1 of 2.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: true,
  },
} satisfies ListToolsResult["tools"][number];

/**
 * Stub handler. Real implementation lands in T-008.
 */
export async function handleLensReviewStart(
  _req: CallToolRequest,
): Promise<CallToolResult> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            stub: true,
            tool: LENS_REVIEW_START_NAME,
            message: "Not yet implemented — see T-008.",
          },
          null,
          2,
        ),
      },
    ],
  };
}
