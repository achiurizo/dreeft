# whispered-thoughts

A Claude Code mod that shows what the session is thinking, right above the prompt.

While the main session thinks, a small dim band above the prompt streams the
tail of its thinking. A faint shimmer runs across the newest line. Under it, a
meta row shows what the turn has cost so far:

```text
                     …the buffer also needs to grow from two hundred characters, or
                   the older row will be empty. Next I'll check how maxRows limits
                                       the band height in fullscreen mode before I
                            ◆ 12s · 3 blk · 1.8k out   +0.6% ⠀⢀⣀⣠⣤⣴⣀⣠⣤⣶  ~14t left
```

## What it shows

**Thought rows** (top three rows, only while a turn is running)

- The latest thinking text, word-wrapped into three right-aligned rows. The oldest row is the faintest and the newest is brightest.
- A bright 4-cell window sweeps across the newest row while thinking text is still arriving.
- When the model starts writing or calls a tool, the rows freeze and stay dim. A new thinking block starts a fresh tail.
- The band always reserves all three rows, so the prompt doesn't jump as words arrive.

**Meta row** (stays up after the turn ends, until the next turn starts)

| Part | Meaning |
| --- | --- |
| `◆ 12s` | Time spent thinking this turn |
| `3 blk` | Thinking blocks this turn |
| `1.8k out` | Output tokens this turn (thinking included) |
| `+0.6%` | How much this turn grew the context, as a share of the window. Amber at 10 points or more. Negative after a compaction. |
| `⣀⣠⣤⣴` | Growth of the last 20 turns, two turns per braille cell, scaled to the largest |
| `~14t left` | Turns until the window is full, at the average growth of the last 5 turns that grew. Amber at 5 or fewer. |

When the terminal is narrow, the meta row drops parts in this order: turns left, the trail, the token count. Under 12 cells the band draws nothing.

The mod only follows the main conversation. Subagent thinking and turns are ignored. It makes no model calls, network requests or file writes.

## Requirements

- A Claude Code build with function-hook plugins (mods).
- The terminal surface. Desktop, VS Code and mobile get nothing for now.
- Thinking summaries turned on in `~/.claude/settings.json`:

  ```json
  { "showThinkingSummaries": true }
  ```

  Without this setting the API sends no thinking text, so the thought rows never appear. The meta row still works.

## Install

Clone the repo, then load it as a local plugin.

For one session:

```sh
claude --plugin-dir ~/code/whispered-thoughts
```

For every session, add it to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/code/whispered-thoughts" }
}
```

If hot reloading is enabled in a session, edits to `hooks/` take effect without a restart.

## How it works

- A streaming `turn.step` hook watches the model's chunks and passes every chunk on unchanged. It records the thinking tail, thinking time, block count and output tokens.
- `session.measure` and each step's usage keep a running context size. `turn.complete` adds the turn's growth to the trail.
- A `ui.render` hook on the `AbovePrompt` band draws the rows from session state.
- The shimmer timer runs only while thinking text is arriving.
- If a state update fails, the mod drops the update and the turn continues.

| Path | Contents |
| --- | --- |
| `hooks/register.tsx` | Hooks, state atoms, render |
| `hooks/lib.ts` | Pure helpers: wrapping, shimmer, braille trail, formatting, turns-left |
| `types/index.d.ts` | Shape of the mod's session state |
| `hooks/*.test.ts` | Tests, run with the `claude-code/testing` kit |

## Development

```sh
claude plugin test .              # run the tests
claude plugin validate .          # check manifest, hooks and declared state
bunx -p typescript tsc -p .       # type-check
```

Type-checking needs `.claude-plugin/types/`. Claude Code generates that folder once it has loaded the mod, and it is gitignored, so a fresh clone can't type-check until the mod has loaded at least once.
