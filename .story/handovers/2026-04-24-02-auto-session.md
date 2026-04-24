# Handover — contract reconciliation sprint: T-023 + T-022 + T-024 + ISS-002

**Session:** 9a542e21-4fe8-4635-8b19-d0b5029bfc5d (targeted auto on [T-023, T-022, T-024, ISS-002])
**Branch:** `main` (4 commits, all green)
**Date:** 2026-04-24
**Commits this session:**
- `1d90d23` — feat: reconcile lensConfig schema + fix SERVER_INFO version drift (T-023)
- `c51bbc2` — feat: agent/server contract redesign + cooperative retry protocol (T-022)
- `dea1404` — feat: disk-backed in-flight review state + LensErrorCode taxonomy (T-024)
- `f2a80b7` — fix: exercise main()/stdio bootstrap via dist/cli.js spawn (ISS-002)

**Tests:** 567 passing across 27 files (was 502 at session start; +65 new). Typecheck clean. Build clean. 22/25 tickets complete on the Integration phase.

---

## What shipped

### T-023 — lensConfig reconciliation + version drift
Replaced hardcoded `SERVER_INFO.version = "0.0.0"` with a tsup/vitest `define`-injected `__LENSES_VERSION__` constant read from `package.json` at build time. Added `lensTimeout` (scalar or `{default, opus}` object) to `LensConfigSchema` with a pure `resolveLensTimeoutMs(model, config)` helper returning milliseconds. Deleted three documented-but-never-consumed fields (`tokenBudgetPerLens`, `requireSecretsGate`, `requireAccessibility`) from in-source comments. Version drift is pinned by `test/server.test.ts` (dynamic package.json read) and `test/version-drift.test.ts`.

### T-022 — contract redesign (THE session's main event)
Three contract leaks from the 2026-04-23 live test, all fixed:
1. **Envelope swallow:** `LensOutputSchema.strict()` → `.passthrough()`. Unknown orchestrator bookkeeping fields no longer downgrade the whole lens to a syntheticError. `LensFindingSchema` stays `.strict()` — LLM hallucination on finding shape surfaces in `parseErrors[]`.
2. **Confidence-floor silent drop:** `blocking-policy.ts` now returns `{kept, deferred}`. Dropped findings surface in `ReviewVerdict.deferred[]` with `reason: "below_confidence_floor"`.
3. **Hop-1 response bloat (~68KB → <5KB):** `lens_review_start` now returns `agents: [{id, model, promptHash, expiresAt}]` — refs, not prompts. New third tool `lens_review_get_prompt` fetches the full prompt per-spawn.

Verdict envelope extended with `parseErrors[]`, `deferred[]`, `suppressedFindingCount`, `hadAnyFindings` (L-003 disambiguator — ships WITH `deferred[]`), and `nextActions[]` (cooperative retry protocol, max_attempts=2, self-contained `retryPrompt`). Four new superRefine invariants keep the shape honest (counts match deferred.length, `hadAnyFindings=false` forbids non-empty findings/deferred, `nextActions.length > 0` forces `verdict != approve`).

State machine overhaul: `validateAndComplete` → `applyCompletion` supporting `started | awaiting_retry | complete` with per-lens attempt tracking. Hard-rejects stale (`attempt ≤ highestSeen`), non-contiguous, and expired submissions. Atomic no-half-apply under Node's event loop.

Doc sweep: RULES.md §4 + README + CLAUDE.md all describe three tools now.

### T-024 — disk-backed in-flight state
Disk is now source of truth; in-process Map is a bounded LRU read-cache (default 100 entries, env override `LENSES_INFLIGHT_LRU_CAP`). `reviewId` survives an MCP server restart between hops — the end-to-end test in `tools-complete.test.ts` proves it by wiping the Map between hop-1 and hop-2 and still getting a verdict.

Storage layout: `tmpdir()/lenses-in-flight/<reviewId>/{index.json, prompts/<lensId>.txt, tasks/<lensId>.<attempt>.json}`. Task records carry full `lensOutput` on terminal status so hydration rebuilds `perLensLatestOutput` with real findings. `applyCompletion` stays in-memory; `persistInFlightBestEffort` writes disk outside the outer try/catch (RULES.md §4 preserved; dedicated test pins it with a LENSES_IN_FLIGHT_DIR pointed at a non-dir path).

NEW `src/schema/error-code.ts` with 9-code `LensErrorCode` enum + exhaustive `Record<LensErrorCode, string>` messages. Bidirectional exhaustiveness guard via `Record<LensErrorCode, true>` satisfies clause (same pattern T-021 used for `LensId`). Persisted on failed task records; distinguishes `PARSE_FAILURE` (synthetic placeholder) from `UNKNOWN_ERROR` (agent-reported `status: error`).

### ISS-002 — smoke test
`test/smoke.test.ts` now spawns `node dist/cli.js --mcp` as a real child process, completes the MCP `initialize` + `notifications/initialized` handshake, issues `tools/list`, and asserts all three T-022 tools are advertised. Skipped when `dist/cli.js` is missing (pre-build local-dev). Catches CLI-wiring regressions end-to-end: shebang, `--mcp` parse, `StdioServerTransport.connect`, tools/list response shape.

---

## Decisions worth carrying forward

- **`lensTimeout` belongs in `LensConfigSchema` (activation-time), not `MergerConfigSchema`.** The ticket description initially said merger-config, but merger-config defaults are frozen at module load via IIFE — `lensTimeout` must vary per-call to compute `expiresAt`. Plan review (T-023 round 1) confirmed the override was architecturally sound.
- **`hadAnyFindings` ships WITH `deferred[]` in the same commit (L-003).** Without the disambiguator, `findings: []` becomes ambiguous between "no concerns" and "concerns suppressed" — a semantic break. Schema superRefine forbids `hadAnyFindings=false` with non-empty findings/deferred.
- **`applyCompletion` stays in-memory even with disk persistence (RULES.md §4).** T-024 moves disk IO to a peer `persistInFlightBestEffort` called OUTSIDE complete.ts's outer try/catch. Same discipline as `persistRoundBestEffort` (T-014) and `persistLensCacheBestEffort` (T-015). Plan review round 1 flagged an initial draft that would have merged disk IO into applyCompletion — reverted before implementation.
- **Task records carry full `lensOutput` on disk.** The plan reviewer (T-024 round 1) spotted that without findings in task records, mid-retry restart would rerun the merger over empty view. Fix was adding `lensOutput: LensOutputSchema.nullable()` to TaskRecord.
- **Double-submit rejection: `attempt ≤ highestSeen` is stale, not idempotent-equal.** T-022 plan review raised the concurrent-retry case. Under Node's single-threaded event loop, concurrent `applyCompletion` calls serialize at the synchronous mutation boundary — but equal attempts MUST be rejected (not merged) so the outcome is deterministic. Hard rejection with a clear "stale attempt" error.
- **`retryPrompt` is self-contained on `nextActions[]`; `lens_review_get_prompt` is stateless.** The caller does NOT re-call `get-prompt` for a retry. Original prompt lives in `session.prompts`; `nextActions[].retryPrompt = original + <retry-context> suffix`. Simplifies both sides.
- **tsup `define` + vitest `define` for `__LENSES_VERSION__`.** Build-time substitution keeps the version in sync with `package.json` automatically. No runtime `readFileSync` — doesn't break if a downstream bundler strips package.json.

---

## Open issues created this session

- **ISS-003** (medium, open) — minor comment-accuracy nit in `src/types/build-constants.d.ts`: the comment describes a runtime `undefined` scenario inside a type declaration file that asserts `string`. Triple-covered by version-drift.test.ts. Deferred; not blocking any ticket.

---

## Explicitly deferred (for T-016, T-025, or later)

- **T-016 (claudestory integration)** — cross-repo. All three of its blockers (T-018, T-021, T-022, T-023, T-024) now complete. Pick up in a fresh session rooted in `/Users/amirshayegh/Developer/CPM/claudestory`.
- **T-017 (setup-skill registration)**, **T-019 (skill docs rewrite)** — cross-repo, belong in claudestory.
- **`LensErrorCode` on the wire envelope.** Currently persisted on task records; not yet exposed via `parseErrors[].errorCode`. Add in a follow-up when claudestory surfaces a need.
- **Chunking (`chunkIndex > 0`).** Schema field pinned at null on every T-024 record; populated when T-025's chunking lands post-T-016 burn-in.
- **T-025 (post-T-016 burn-in primitives)** — still a placeholder. Waits for real claudestory usage evidence.
- **Storybloq `/story` skill config reference block update.** Different repo; `tokenBudgetPerLens` / `requireSecretsGate` / `requireAccessibility` still documented there. Flag for the T-016 session.

---

## Key files / artifacts for next session

| Path | Why it matters |
|---|---|
| `src/schema/finding.ts:99-141` | Envelope `.passthrough()` + finding `.strict()` split — the T-022 fix |
| `src/schema/verdict.ts:51-150` | Extended ReviewVerdictSchema with four new superRefine rules |
| `src/schema/review-protocol.ts` | NEW home for parseError/deferred/nextAction shapes |
| `src/schema/error-code.ts` | NEW 9-code LensErrorCode enum + message map |
| `src/state/review-state.ts` | Disk-backed state machine with LRU read-cache; applyCompletion + persistInFlightBestEffort |
| `src/cache/in-flight.ts` | NEW disk primitives — mirrors cache/session.ts |
| `src/tools/get-prompt.ts` | NEW third tool (stateless prompt lookup) |
| `src/tools/start.ts:80-120` | Hop-1 refs shape: promptHash + expiresAt; no inline prompts |
| `src/tools/complete.ts:255-438` | applyCompletion call + persist* peers outside outer try/catch |
| `test/smoke.test.ts:36-145` | CLI+stdio bootstrap via child_process.spawn |
| `.story/sessions/9a542e21-4fe8-4635-8b19-d0b5029bfc5d/plan.md` | All three implementation plans (last rewrite is T-024) |

---

## Invariants the NEXT session (probably T-016 in claudestory) must preserve

- `ReviewVerdictSchema.superRefine` extended rules at `src/schema/verdict.ts:88-145`:
  - `suppressedFindingCount === deferred.length`.
  - `hadAnyFindings === false → findings.length + deferred.length === 0`.
  - `nextActions.length > 0 → verdict !== "approve"`.
- RULES.md §4 "cache fail doesn't fail the review" structural pattern at complete.ts:436-442 — ALL four persist helpers (`persistRoundBestEffort`, `persistLensCacheBestEffort`, `persistInFlightBestEffort`) run OUTSIDE the outer try/catch. Any new persistence added in T-016 must follow the same pattern.
- The three-tool contract: `lens_review_start` (refs), `lens_review_get_prompt` (lookup), `lens_review_complete` (verdict + retry). Don't accidentally add a fourth without an acceptance-level doc update.
- `LensFindingSchema` MUST stay `.strict()`. Loosening it to `.passthrough()` would reopen the silent-pass bug the T-022 envelope fix was specifically designed not to repeat.