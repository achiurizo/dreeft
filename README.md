# whispered-thoughts

A Claude Code mod that shows what the session's thinking is doing, right above the prompt.

The transcript already shows the thinking itself. The band shows the data around it: what the thinking keeps coming back to, where the turn's time goes, and what the turn costs.

```text
                         ∴ register.tsx ×6 · metaRow ×4 · observe ×2   ⟲ 2
                  ·▒▒▒▒▒░░░░░░░░░▒▒▒▒▒▒░░░░█████  think 11s · tools 13s · write 5s
             ◆ 11s · 2 blk · 3 tools · 1.8k out   +0.6% ⠀⢀⣀⣠⣤⣴⣀⣠⣤⣶
```

## What it shows

The band appears when a turn starts and stays up after it ends, until the next turn starts.

**Focus row**

- The three names the thinking mentions most this turn, with counts. A name is a backticked span, a file name or path, or a camelCase or snake_case identifier. Plain words don't count.
- `⟲ 2` counts second-guesses: how often the thinking says "wait", "actually" or "hmm". Shown in amber.
- This is a word-count heuristic, not a summary, so it can pick the wrong names.

**Timeline row**

One cell per second of the turn, so the strip grows while the turn runs, tool runs included. A long turn packs several seconds into each cell so the whole turn fits.

| Cell | Phase |
| --- | --- |
| `·` | Waiting on the model |
| `▒` | Thinking |
| `░` | Calling or running a tool |
| `█` | Writing the answer |

After the strip, the time spent in each phase: `think 11s · tools 13s · write 5s`.

**Meta row**

| Part | Meaning |
| --- | --- |
| `◆ 11s` | Time spent thinking this turn |
| `2 blk` | Thinking blocks this turn |
| `3 tools` | Tool calls this turn |
| `1.8k out` | Output tokens this turn (thinking included) |
| `+0.6%` | How much this turn grew the context, in points of the window. Amber at 10 points or more. Negative after a compaction. |
| `⣀⣠⣤⣴` | Growth of the last 20 turns, two turns per braille cell, scaled to the largest |

When the terminal is narrow, the meta row drops parts in this order: the tool count, the trail, the token count. The timeline drops its totals before it shrinks below 8 cells. The focus row drops names from the end. When the band is short on rows, it keeps the bottom ones. Under 12 cells it draws nothing.

The mod only follows the main conversation. Subagent thinking and turns are ignored. It makes no model calls, network requests or file writes.

## Requirements

- A Claude Code build with function-hook plugins (mods).
- The terminal surface. Desktop, VS Code and mobile get nothing for now.
- Optional: thinking summaries turned on in `~/.claude/settings.json`:

  ```json
  { "showThinkingSummaries": true }
  ```

  The focus row reads the thinking text, so it stays at `∴ …` without this setting. The timeline and meta row work either way. With the setting on, the transcript also shows the thinking.

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

- A streaming `turn.step` hook watches the model's chunks and passes every chunk on unchanged. Each chunk updates the turn's phase spans, focus counts, block and tool counts, and output tokens.
- A one-second ticker runs only while a main-loop turn is running, so the timeline grows between steps while tools run. It stops when the turn completes.
- `session.measure` and each step's usage keep a running context size. `turn.complete` adds the turn's growth to the trail.
- A `ui.render` hook on the `AbovePrompt` band draws the rows from session state.
- If a state update fails, the mod drops the update and the turn continues.

| Path | Contents |
| --- | --- |
| `hooks/register.tsx` | Hooks, state atoms, render |
| `hooks/lib.ts` | Pure helpers: focus scan, phase timeline, chunk reducer, row layout, braille trail |
| `types/index.d.ts` | Shape of the mod's session state |
| `hooks/*.test.ts` | Tests, run with the `claude-code/testing` kit |

## Development

```sh
claude plugin test .              # run the tests
claude plugin validate .          # check manifest, hooks and declared state
bunx -p typescript tsc -p .       # type-check
```

Type-checking needs `.claude-plugin/types/`. Claude Code generates that folder once it has loaded the mod, and it is gitignored, so a fresh clone can't type-check until the mod has loaded at least once.
