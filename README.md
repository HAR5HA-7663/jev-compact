# jev-compact

Context compaction for Claude Code that **prunes instead of summarising**.

The built-in `/compact` asks the model to rewrite your whole conversation as a summary: slow, lossy, and it replaces every tool output — including the ones you still need — with prose. `jev-compact` keeps the conversation as it is and removes only what is provably dead weight:

1. **Rules first, locally.** Exploration output (`Read`, `Grep`, `Glob`, read-only `Bash`, snapshots, MCP reads) older than the recent window is replaced by a one-line stub. Hook noise (`<system-reminder>` blocks, hook chatter) is stripped from old user turns. Long tool *inputs* (heredoc scripts, `Write` contents, big `Edit` strings) are shortened — the files are on disk. Nothing leaves the machine for this step.
2. **Jev ranks the rest.** If the result is still above the budget, the remaining judgement calls (agent reports, mutations, passing test runs) go to [Jev](https://typesafe.ai) (TypeSafe System One) in **one** batched request (~100–400 ms): *"will the assistant need this output again to finish the task?"* The lowest-scoring outputs are dropped until the budget is met.
3. **Never touched:** every user and assistant message, every error or failing test output, the first message, the last N messages.
4. **A note tells the assistant what was removed** so it re-runs a tool instead of guessing from memory, and the removed outputs are archived to `~/brain/archive/compaction/` (optional).
5. **Falls back** to the built-in summary — on the pruned set — whenever pruning alone cannot reach the budget or anything errors. You never get a worse outcome than today.

On a real 100k-token Claude Code window: **54 % smaller in 19 ms**, no Jev call needed. On a 35k window: 37 % from rules, then the built-in summary handles the rest. First live compaction on a 270k-token session: 55 % smaller (270k → 121k), 164 exploration outputs pruned, 19 error/test outputs kept, zero Jev calls.

## Install

Requires Claude Code ≥ 2.1.274 with function hooks enabled and a TypeSafe API key. Enable function hooks for every launcher (terminal, desktop app, `claude agents` daemon) by putting the flag in `~/.claude/settings.json` rather than in your shell:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

```sh
claude plugin marketplace add HAR5HA-7663/jev-compact
claude plugin install jev-compact@jev-compact
claude plugin install jev-compact-trigger@jev-compact
```

**Two plugins, one feature.** `jev-compact` holds the `session.compact` hook (the pruning). `jev-compact-trigger` watches context use after every turn and starts a compaction at `compactAtPercent`. They are separate because the engine skips a plugin's *own* `session.compact` hook when that plugin raises the compaction — a trigger inside `jev-compact` would only ever get the built-in summary. Sessions already running when you install do not pick the plugins up; restart them.

The key is read from `TYPESAFE_API_KEY` in the environment, else from a `TYPESAFE_API_KEY=` line in `~/.env`. Without a key the rule-based pruning still runs; only the Jev ranking is skipped.

Nothing about how you use Claude Code changes: `/compact` and auto-compact behave as before, just faster and with less lost.

## Configuration

`claude plugin install jev-compact@jev-compact --config targetPercent=45 --config preserveRecentMessages=12`

| option | default | meaning |
|---|---|---|
| `targetPercent` | 45 | prune down to this share of the context window (estimated) |
| `compactAtPercent` | 75 | context percentage at which a finished turn triggers compaction (acted on by `jev-compact-trigger`, which reads this row) |
| `preserveRecentMessages` | 12 | newest messages never touched |
| `minReductionRatio` | 0.25 | below this reduction the built-in summary runs on the pruned set |
| `model` | `jev-1.13.0` | pinned Jev model |
| `brainArchive` | true | write removed outputs to `~/brain/archive/compaction/<date>/` |

Opt out for a session or a repo without disabling the plugin: `JEV_COMPACT_OFF=1`, a `.jev-compact-off` file in the working directory, or `[[jev:private]]` anywhere in the conversation — pruning stays local, nothing is sent to Jev.

## What Jev sees

Only what it needs to rank: the first user message (the task), the latest user message, the recent assistant text, and for each candidate the tool name, the head of its input and the head/tail of its output — secrets masked (bearer tokens, `*_KEY=…`, URL passwords). It never sees the whole conversation.

## Development

```sh
npx -y tsx --test tests/core.test.mts            # unit tests (no network)
npx -y -p typescript tsc --noEmit -p tsconfig.json
TYPESAFE_API_KEY=… npx -y tsx bench/run.mts messages.json [--no-jev] [--target 45]
```

`src/core.ts` is pure (no engine access) so it can be benchmarked on converted transcripts; `hooks/jev-compact.ts` is the thin Claude Code hook around it.

## Log

`~/.local/state/jev/compact.log` — one line per compaction: reduction, what was pruned, Jev requests, and whether the built-in summary ran afterwards (`hybrid`). The trigger adds `auto N% >= T% -> compacted | skipped (…) | failed: …`; `JEV_COMPACT_DEBUG=1` adds one line per turn with the context percentage. The engine's own view is in `~/.claude/debug/<session>.txt` (or `--debug-file`).

## Credits

Started from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), which scores every message with Jev. This fork moves most decisions into local rules, prunes tool inputs, keeps errors and user text unconditionally, batches Jev into one request, and adds the note, the archive and the fallback.

MIT.
