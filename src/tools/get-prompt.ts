import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  GetPromptParamsSchema,
  type GetPromptParams,
} from "../schema/index.js";
import { getReview } from "../state/review-state.js";

export const LENS_REVIEW_GET_PROMPT_NAME = "lens_review_get_prompt";

/**
 * T-022: stateless prompt lookup. Given a `reviewId` and `lensId` both
 * produced by `lens_review_start`, returns the full prompt the spawned
 * subagent should receive. The caller fetches one prompt per spawn,
 * keeping hop-1's response tiny (see the live-test handover: hop-1 used
 * to return ~68KB of inline prompts; refs-not-prompts collapses that to
 * <5KB with `lens_review_get_prompt` carrying the heavy string).
 *
 * Stateless in the user-visible sense: the same (reviewId, lensId) always
 * returns the same string for the lifetime of the review. Session status
 * does NOT affect the result -- the prompt is unchanging identity data.
 * Retry prompts (with `<retry-context>` suffix) live on
 * `nextActions[].retryPrompt` directly and are NEVER fetched via this
 * tool; this tool always returns the ORIGINAL activation prompt.
 */
export const lensReviewGetPromptDefinition = {
  name: LENS_REVIEW_GET_PROMPT_NAME,
  description:
    "Fetch the full prompt for one lens in an active review. Call once per " +
    "lens before spawning the subagent. The agents[].promptHash returned by " +
    "lens_review_start identifies which lens to look up here.",
  inputSchema: {
    type: "object" as const,
    properties: {
      reviewId: { type: "string", minLength: 1 },
      lensId: { type: "string", minLength: 1 },
    },
    required: ["reviewId", "lensId"],
    additionalProperties: false,
  },
} satisfies ListToolsResult["tools"][number];

export const GetPromptOutputSchema = z
  .object({
    prompt: z.string().min(1),
  })
  .strict();
export type GetPromptOutput = z.infer<typeof GetPromptOutputSchema>;

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export async function handleLensReviewGetPrompt(
  req: CallToolRequest,
): Promise<CallToolResult> {
  let parsed: GetPromptParams;
  try {
    parsed = GetPromptParamsSchema.parse(req.params.arguments);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResult(
        `lens_review_get_prompt: invalid arguments: ${err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    if (err instanceof Error) {
      return errorResult(`lens_review_get_prompt: ${err.message}`);
    }
    return errorResult(`lens_review_get_prompt: unknown error`);
  }

  const session = getReview(parsed.reviewId);
  if (session === undefined) {
    return errorResult(
      `lens_review_get_prompt: unknown reviewId: ${parsed.reviewId}`,
    );
  }
  const prompt = session.prompts.get(parsed.lensId as never);
  if (prompt === undefined) {
    return errorResult(
      `lens_review_get_prompt: no prompt registered for lensId '${parsed.lensId}' in review ${parsed.reviewId}`,
    );
  }

  const response: GetPromptOutput = { prompt };
  return { content: [{ type: "text", text: JSON.stringify(response) }] };
}
