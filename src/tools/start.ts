import { randomUUID } from "node:crypto";

import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { hashLensPrompt, readLensCache } from "../cache/lens-cache.js";
import {
  activate,
  LensConfigSchema,
  LensIdSchema,
  ModelSchema,
} from "../lenses/registry.js";
import type { LensId } from "../lenses/prompts/index.js";
import {
  buildAgentPrompts,
  PreambleConfigSchema,
  ProjectContextSchema,
} from "../lenses/prompt-builder.js";
import { LensFindingSchema, type LensFinding } from "../schema/finding.js";
import { sharedStartShape, type StartParams } from "../schema/index.js";
import {
  registerReview,
  type CachedLensEntry,
} from "../state/review-state.js";

export const LENS_REVIEW_START_NAME = "lens_review_start";

/**
 * T-008 configuration shape shared by both stages. `default({})` fires inside
 * the Zod parse so downstream code always sees fully-populated values.
 *
 * `ProjectContextSchema` is imported from prompt-builder so the Zod validator
 * and the `ProjectContext` type `buildLensPrompt` consumes stay in lockstep --
 * there is one source of truth for that shape, not a parallel declaration.
 */
const configShape = {
  lensConfig: LensConfigSchema.default({}),
  preambleConfig: PreambleConfigSchema.default({}),
  projectContext: ProjectContextSchema.optional(),
} as const;

/**
 * Full MCP arguments envelope. Discriminated on `stage` to enforce the
 * CODE_REVIEW-only `changedFiles` requirement at the contract boundary --
 * the same invariant StartParamsSchema enforces for the preamble input,
 * re-expressed here because the top-level shape also includes config fields.
 *
 * Reuses `sharedStartShape` from schema/params so any evolution of the
 * review envelope propagates to both schemas automatically.
 */
export const StartToolInputSchema = z.discriminatedUnion("stage", [
  z
    .object({
      stage: z.literal("PLAN_REVIEW"),
      ...sharedStartShape,
      ...configShape,
    })
    .strict(),
  z
    .object({
      stage: z.literal("CODE_REVIEW"),
      changedFiles: z.array(z.string().min(1)).nonempty(),
      ...sharedStartShape,
      ...configShape,
    })
    .strict(),
]);
export type StartToolInput = z.infer<typeof StartToolInputSchema>;

/**
 * Wire response shape. Note `id` (wire) vs `lensId` (internal) -- the handler
 * renames once at serialization so internal code keeps the more descriptive
 * field name everywhere else.
 */
export const StartToolOutputSchema = z
  .object({
    reviewId: z.string().uuid(),
    agents: z.array(
      z
        .object({
          id: LensIdSchema,
          model: ModelSchema,
          prompt: z.string().min(1),
        })
        .strict(),
    ),
    cached: z.array(
      z
        .object({
          id: LensIdSchema,
          findings: z.array(LensFindingSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type StartToolOutput = z.infer<typeof StartToolOutputSchema>;

export const lensReviewStartDefinition = {
  name: LENS_REVIEW_START_NAME,
  description:
    "Begin a multi-lens review. Returns prompts for the agent to spawn as subagents, " +
    "plus any cached lens findings. Hop 1 of 2.",
  inputSchema: {
    type: "object" as const,
    properties: {
      stage: { type: "string", enum: ["PLAN_REVIEW", "CODE_REVIEW"] },
      artifact: { type: "string" },
      ticketDescription: { type: ["string", "null"] },
      reviewRound: { type: "integer", minimum: 1 },
      priorDeferrals: { type: "array" },
      changedFiles: { type: "array" },
      lensConfig: { type: "object" },
      preambleConfig: { type: "object" },
      projectContext: { type: "object" },
    },
    required: ["stage", "artifact", "ticketDescription", "reviewRound"],
    additionalProperties: false,
  },
} satisfies ListToolsResult["tools"][number];

/**
 * Attempt a cache read for one activated lens. Best-effort: a throw
 * from `readLensCache` (shouldn't, but defense-in-depth against a
 * future refactor) is logged and treated as a miss so a broken cache
 * cannot block the review.
 */
function tryCacheRead(
  lensId: LensId,
  promptHash: string,
): CachedLensEntry | undefined {
  try {
    const hit = readLensCache(lensId, promptHash);
    if (!hit) return undefined;
    return { findings: hit.findings, notes: hit.notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`lens_review_start: lens cache read failed: ${message}`);
    return undefined;
  }
}

/**
 * Build the Hop-1 response: activate → assemble → resolve-cache →
 * wire-rename. Pure wrt its inputs except for the reviewId generated
 * via `crypto.randomUUID()` and the best-effort disk reads done by
 * `readLensCache`. A cache read throw is swallowed per RULES.md §4 --
 * the lens is treated as a miss and re-spawned.
 *
 * T-015 pipeline: for each activated lens, compute a stable prompt
 * hash, consult the disk cache, and split into `agents` (miss -- the
 * agent must spawn) and `cached` (hit -- the agent skips). Cached
 * entries AND the full `promptHashes` map land on the ReviewSession
 * so hop-2 can re-inject findings and write fresh entries without
 * a second disk read.
 */
function buildResponse(parsed: StartToolInput): StartToolOutput {
  // `StartToolInputSchema` is a superset of `StartParamsSchema` (it adds
  // lensConfig, preambleConfig, projectContext on top of sharedStartShape +
  // stage + changedFiles). Destructuring the three config fields off leaves
  // exactly the StartParams residue. Using spread (not field-by-field
  // reconstruction) so future additions to `sharedStartShape` propagate
  // automatically without a silent drop here.
  const { lensConfig, preambleConfig, projectContext, ...startParamsLike } =
    parsed;
  const startParams: StartParams = startParamsLike as StartParams;

  const activations = activate({
    stage: parsed.stage,
    changedFiles: parsed.stage === "CODE_REVIEW" ? parsed.changedFiles : [],
    config: lensConfig,
  });

  const built = buildAgentPrompts({
    activations,
    startParams,
    preambleConfig,
    ...(projectContext !== undefined ? { projectContext } : {}),
  });

  // T-015 cache resolution. Split each activated lens into hit (goes
  // to `cachedEntries`) or miss (stays in `spawnedAgents`).
  // `promptHashes` tracks the hash for EVERY activated lens, cached
  // or not, so hop-2 can write fresh results under the right key.
  // `expectedLensIds` is the FULL activation list (hits + misses):
  // the state machine enforces coverage across the union, and cached
  // lenses are covered by `cachedResults`.
  const promptHashes = new Map<LensId, string>();
  const cachedEntries = new Map<LensId, CachedLensEntry>();
  const cachedWire: Array<{ id: LensId; findings: LensFinding[] }> = [];
  const spawnedAgents: typeof built = [];
  for (const agent of built) {
    const promptHash = hashLensPrompt(agent.prompt);
    promptHashes.set(agent.lensId, promptHash);
    const hit = tryCacheRead(agent.lensId, promptHash);
    if (hit) {
      cachedEntries.set(agent.lensId, hit);
      cachedWire.push({ id: agent.lensId, findings: [...hit.findings] });
    } else {
      spawnedAgents.push(agent);
    }
  }

  // Track the review in the T-020 state machine BEFORE returning so the
  // complementary `lens_review_complete` handler (T-009) can enforce
  // reviewId validity, lens coverage, and one-shot completion. In T-014
  // we also resolve (or mint) the cross-round `sessionId` here so the
  // complete-time path can build a `RoundRecord` without reparsing the
  // start-time envelope. T-015 additionally stashes the cached entries
  // and prompt-hash map so hop-2 can rehydrate findings and update the
  // cache without re-reading the prompts.
  const reviewId = randomUUID();
  const sessionId = parsed.sessionId ?? randomUUID();
  registerReview({
    reviewId,
    sessionId,
    stage: parsed.stage,
    expectedLensIds: built.map((a) => a.lensId),
    reviewRound: parsed.reviewRound,
    priorDeferrals: parsed.priorDeferrals,
    cachedResults: cachedEntries,
    promptHashes,
  });

  return {
    reviewId,
    agents: spawnedAgents.map(({ lensId, model, prompt }) => ({
      id: lensId,
      model,
      prompt,
    })),
    cached: cachedWire,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export async function handleLensReviewStart(
  req: CallToolRequest,
): Promise<CallToolResult> {
  try {
    const parsed = StartToolInputSchema.parse(req.params.arguments);
    const response = buildResponse(parsed);
    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  } catch (err) {
    // Return only the human-readable summary -- never leak Error.stack
    // through the MCP wire.
    const message =
      err instanceof z.ZodError
        ? `lens_review_start: invalid arguments: ${err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`
        : err instanceof Error
          ? `lens_review_start: ${err.message}`
          : `lens_review_start: unknown error`;
    return errorResult(message);
  }
}
