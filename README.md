# @storybloq/lenses

Multi-lens code review MCP server — 8 specialized reviewers run in parallel, with findings deduplicated, confidence-filtered, and rolled into a single verdict.

## Installation

```sh
npm install -g @storybloq/lenses
```

## Register with Claude Code

```sh
claude mcp add lenses -s user -- lenses --mcp
```

After registration, three tools become available in your Claude Code session:

- `lens_review_start` — Returns `{reviewId, agents: [{id, model, promptHash, expiresAt}], cached}`. Refs-not-prompts shape keeps the hop-1 payload small; fetch the actual prompt for each agent via `lens_review_get_prompt` before spawning.
- `lens_review_get_prompt` — Looks up the full prompt for one lens in an active review. Stateless per `(reviewId, lensId)`.
- `lens_review_complete` — Accepts the subagent outputs (with optional `attempt` for retry) and returns the merged verdict. The envelope includes `parseErrors[]`, `deferred[]`, `suppressedFindingCount`, `hadAnyFindings`, and `nextActions[]` for the cooperative retry protocol.

## Architecture

See `CLAUDE.md` in the source repository for the two-hop flow, lens activation logic, merger semantics, and session caching.

## License

PolyForm-Noncommercial-1.0.0
