import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

export const LENS_REVIEW_COMPLETE_NAME = "lens_review_complete";

/**
 * Tool definition returned via listTools. Typed with `satisfies` so any drift
 * from the SDK's expected shape becomes a compile error rather than a runtime
 * protocol mismatch.
 */
export const lensReviewCompleteDefinition = {
  name: LENS_REVIEW_COMPLETE_NAME,
  description:
    "Finish a multi-lens review. Accepts the raw outputs from each spawned agent; " +
    "returns the merged, confidence-filtered verdict. Hop 2 of 2.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: true,
  },
} satisfies ListToolsResult["tools"][number];

/**
 * Stub handler. Real implementation lands in T-009.
 */
export async function handleLensReviewComplete(
  _req: CallToolRequest,
): Promise<CallToolResult> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            stub: true,
            tool: LENS_REVIEW_COMPLETE_NAME,
            message: "Not yet implemented — see T-009.",
          },
          null,
          2,
        ),
      },
    ],
  };
}
