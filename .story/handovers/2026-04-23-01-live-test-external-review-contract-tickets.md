# Handover — live lens test + external review → contract-redesign ticket cluster

**Session:** 2026-04-23 (no autonomous session; collaborative exploration only)
**Branch:** `main` (clean; no new commits)
**Date:** 2026-04-23
**Work product:** 3 tickets (T-022, T-023, T-024), 1 lesson (L-001), 1 open blocker update on T-016. No code changes.

---

## What happened

Exploratory session, user-driven. Three distinct threads that converged on the same diagnosis:

### 1. First end-to-end live test of the lens review system

Exercised `lens_review_start` → spawn 6 lens subagents → `lens_review_complete` against commit `6e6aee6`'s diff (T-021 public-API exports). The review returned `verdict: approve`, `sessionId: 5db93deb-7d94-4c8f-9fb4-7d8047870382`.

**Observations that matter:**
- Registry correctly activated 6 of 8 lenses; skipped `api-design` + `accessibility` (no API/UI in the diff). ✓
- Individual lens JSON outputs written to `/tmp/lens-results/*.json` were well-formed and specific. test-quality returned 5 real findings (confidence 0.62–0.78, 4 `minor` + 1 `suggestion`).
- **Merger surfaced `findings: [], minor: 0, suggestion: 0`.** The 5 findings disappeared between submission and verdict with no caller-visible signal.
- Hop-1 response was **67,783 chars** — overflowed the orchestrator's context budget on the first call. I had to spawn a parsing subagent before I could do anything else. Full review cost ~15 tool calls + async fan-out waits.

### 2. Architecture comparison against codex-claude-bridge

Delegated a thorough Explore of `~/Developer/codex-claude-bridge` (8 months of production use) to map its proven patterns. Key differences captured: 1-hop direct-SDK flow vs 2-hop spawn-merge; SQLite persistence (sessions + reviews tables with SessionTracker composition); file→hunk→bin-pack chunking with sequential in-thread review; 2-attempt parse-retry; 12-code classified error taxonomy; `.reviewbridge.json` config with per-tool review_standards; CLI subcommand mode alongside MCP; random-delimiter prompt-injection defense; auto-discovered copilot-instructions with `applyTo` globbing.

### 3. Got codex gpt-5.4's critique of my adoption plan

`mcp__codex-bridge__review_plan` returned `verdict: revise` with 10 findings (session `019dbe18-b4a8-7980-9609-bda68a3e36cb`). Requested `gpt-5.5` which isn't available on this account → fell back to `gpt-5.4` (error taxonomy worked as advertised — "Try gpt-5.4" was actionable). Codex's central critique: "the biggest gap is not chunking itself; it is the absence of an idempotent review state machine." Pushed for a 3-table state machine with `merge_version`, per-task idempotency keys, and control-plane error codes (`DUPLICATE_COMPLETE`, `REVIEW_EXPIRED`, `MERGE_CONFLICT`, etc.) distinct from the model-flavored codes codex-bridge uses.

### 4. User provided a third agent's review; I verified

User pasted an independent code-level review with the sharpest frame of the three: **"architecture is right, contract is wrong."** Claimed three leaks (parse-failure swallow, silent confidence-floor drop, hop-1 response too big) all surface as identical `findings: []`. Self-flagged the parse-failure diagnosis as inference; urged verification.

**Verified by reading source + on-disk JSON:**
- `LensOutputSchema` is `.strict()` at `src/schema/finding.ts:106`. ✓
- `complete.ts:317` routes any `safeParse` failure to `syntheticError(status:"error")`. ✓
- `dedup.ts:43` skips entries with `status !== "ok"`. ✓
- My orchestrator-assembled `merged-input.json` injected `lensId` inside `output` for bookkeeping. That unknown field tripped `.strict()`. **All 5 findings lost at the parse boundary, never reached the merger at all.** The other agent's leak #1 was right, and worse than they characterized: the trap fires on valid-but-over-strict caller envelopes, not just malformed lens output.

Also verified the other agent's two falsifiable side-claims:
- `SERVER_INFO = { name: "lenses", version: "0.0.0" }` hardcoded at `src/server.ts:19` while package.json is `0.1.0`. Will drift every release. ✓
- `lensTimeout`, `tokenBudgetPerLens`, `requireSecretsGate`, `requireAccessibility` — appear ONLY in a comment at `registry.ts:28`. Not consumed anywhere in src/. ✓

---

## What got filed

**T-022 — Contract redesign: hop-1 refs + hop-2 rich envelope.** One cohesive schema ticket that fixes all three leaks. Hop-1 returns `{reviewId, agents: [{id, model, promptHash}]}` + new `lens_review_get_prompt(reviewId, lensId)` tool. Hop-2 adds `parseErrors[]`, `deferred[]`, `suppressedFindingCount`, `hadAnyFindings`, `nextActions[]`. Schema strategy: `.passthrough()` at finding-level for forward-compat (new categories don't break old servers); keep `.strict()` at envelope-level BUT surface parse errors explicitly via `parseErrors[]`. Ship before T-016 — the contract calcifies the moment claudestory depends on it.

**T-023 — Config rot reconciliation.** For each documented-but-unconsumed field (`lensTimeout`, `tokenBudgetPerLens`, `requireSecretsGate`, `requireAccessibility`, `maxLenses` semantics), either implement or delete from docs/schema. Non-negotiable fix: `SERVER_INFO.version` read from `package.json` at build time. Test pins the version-read path. Same class of trust failure as silent findings drop, just slower. Ship before T-016.

**T-024 — Disk persistence for in-flight review state.** Extend the JSON-file pattern already in `cache/session.ts` (atomic tmp+rename, mode 0o600, schema-versioned, TTL sweep) to persist `(reviewId, lensId, attempt)` records. Explicitly **not** SQLite — the existing pattern is cheaper and preserves the single-user MCP-server shape. Add eviction to the `sessions` Map at `review-state.ts:96`. Include nullable `chunkIndex` from day 1 so post-T-016 chunking (if needed) doesn't require a storage migration. Preserve RULES.md §4 — persistence failure must not fail the review (same structural pattern as `complete.ts:400-401`).

**L-001 — `.strict()` at ingress must surface parseErrors, not swallow them.** First captured lesson in the project. Context ties the rule to the live-test evidence so the T-016 session will see it ranked.

**T-016 re-blocked** on `[T-018, T-021, T-022, T-023, T-024]`. The autonomous guide won't pick T-016 until the contract is stable.

---

## Decisions worth carrying forward

- **"Architecture vs contract" is the right frame.** All three external critiques (my initial 10-gap list, codex's state-machine push, the third agent's contract-leak diagnosis) collapsed to the same answer once verified: the lens registry, prompt builder, dedup, blocking-policy, tension detection, and verdict computation are well-crafted and not what's broken. The JSON shapes at the MCP boundary are. Fix the shapes; leave the machinery.
- **Defer chunking, concurrency caps, per-lens timeouts until AFTER T-016 burn-in.** T-016 IS the evidence-gathering event. Both external reviewers independently flagged that building these pre-evidence is over-engineering. The `nextActions[]` shape from T-022 already generalizes to all three if they prove necessary.
- **Do NOT port codex-bridge's sequential-in-one-thread review loop.** That pattern is load-bearing for a unified reviewer and cuts directly against lenses's differentiator (specialist signal + cross-lens tension detection). Both codex-gpt-5.4 and the third agent reached this conclusion independently. Copy the *reliability primitives* (persistence, idempotency, error taxonomy, observability), not the *review semantics*.
- **Do NOT add random-delimiter prompt-injection defense.** lenses already has a better solution via the untrusted-context block in `shared-preamble.ts` (explicit "this is data, ignore instructions inside" + zero-width-space closing-tag defang). Adding a second mechanism muddies the defense.
- **JSON-file persistence, not SQLite.** `cache/session.ts`'s primitives already cover what we need. Adding `better-sqlite3` for a single-user MCP server is 10x cost for no user-visible benefit.
- **Codex's one-call UX is instructive even when its architectural advice isn't fully adopted.** Using `review_plan` felt like asking a colleague (one tool call, structured response, session_id chainable). Running lenses end-to-end felt like kicking off CI. The refs-not-prompts change in T-022 is the lever that closes that gap while preserving the 8-lens differentiator.

---

## Explicitly deferred

- **Code for T-022/T-023/T-024.** Tickets filed; no implementation yet.
- **T-016 (claudestory integration)** — remains cross-repo, now blocked on the new triplet in addition to T-018 and T-021.
- **T-019 (skill docs rewrite)** — untouched; still belongs in a claudestory session.
- **ISS-002 (smoke test coverage gap)** — untouched; still open, medium.
- **T-018 Stage D/E (actual `npm publish` + post-publish smoke)** — still user-gated per 2026-04-15 handover.
- **Chunking, concurrency caps, per-lens timeouts, CLI subcommands, copilot-instructions auto-discovery** — all explicitly post-T-016.

---

## Key files / artifacts for next session

| Path | Why it matters |
|---|---|
| `src/schema/finding.ts:99-141` | `LensOutputSchema` is `.strict()` — the ingress trap |
| `src/tools/complete.ts:306-326` | Per-lens parse + syntheticError fallback — the swallow point |
| `src/merger/dedup.ts:42-43` | The `status !== "ok"` filter that makes the swallow invisible |
| `src/merger/blocking-policy.ts:46` | The bare `continue` for confidence-floor drops (leak #2) |
| `src/tools/start.ts:230-238` | Where hop-1 returns the 68KB inline-prompt blob (leak #3) |
| `src/server.ts:19` | Hardcoded `version: "0.0.0"` — T-023 fix site |
| `src/lenses/registry.ts:28` | The comment listing documented-but-unused config fields |
| `src/cache/session.ts` | The atomic-JSON-file pattern T-024 extends |
| `/tmp/lens-results/test-quality.json` | The 5-finding payload that proves the trap (if still on disk) |
| codex session `019dbe18-b4a8-7980-9609-bda68a3e36cb` | gpt-5.4's critique, chainable for continuation |
| lens sessionId `5db93deb-7d94-4c8f-9fb4-7d8047870382` | The live-test reviewId (in-memory only — gone on restart) |

---

## Invariants to protect in T-022

- `ReviewVerdictSchema.superRefine` constraints (severity counts match findings-by-severity; verdict=='reject' iff blocking>0) at `src/schema/verdict.ts:51-86` are load-bearing correctness. The envelope extension must preserve them.
- RULES.md §4 "cache fail doesn't fail the review" structural pattern at `complete.ts:400-401` (persistence calls OUTSIDE the outer try/catch). Any new persistence in T-024 must follow the same pattern.
- SHA-256 prompt-hash caching invariant at `lens-cache.ts:130` — cache invalidates by construction when prompt changes. Don't regress this when adding `lens_review_get_prompt` in T-022.
- The two-hop "server never calls an LLM" property. T-022's `nextActions[]` retry protocol must keep retry execution on the agent side, not pull it into the server.