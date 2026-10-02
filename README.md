# whispered-thoughts

A Claude Code mod that shows what the session's thinking is doing, right above the prompt.

The transcript already shows the thinking itself. The band shows the data around it: what the thinking keeps coming back to, where the turn's time goes, and what the turn costs.

```text
                         ∴ register.tsx ×6 · metaRow ×4 · observe ×2   ⟲ 2
                   ▀▀▀▀▀▄▄▄▄▄▄▄▄▄ ▀▀▀▀▀▀▄▄▄▄ █████▕  think 11s · tools 13s · write 5s
             ◆ 11s · 2 blk · 3 tools · 1.8k out   +0.6% ⠀⢀⣀⣠⣤⣴⣀⣠⣤⣶
```

## What it shows

The band appears when a turn starts and stays up after it ends, until the next turn starts.

**Focus row**

- The three names the turn comes back to most, with counts. A name has to come up at least twice to show; until one does, the row reads `∴ …`.
- Names come from two places:
  - The turn's tool calls: the file a tool reads or edits, code names in a search pattern, and file names in a shell command.
  - The thinking text, when thinking summaries are on: a backticked span, a file name or path, or a camelCase or snake_case identifier.
- Plain words and directories don't count.
- `⟲ 2` counts second-guesses: how often the thinking says "wait", "actually" or "hmm". Shown in amber. Needs thinking summaries on.
- This is a word-count heuristic, not a summary, so it can pick the wrong names.

**Timeline row**

One cell per second of the turn, so the strip grows while the turn runs, tool runs included. A long turn packs several seconds into each cell so the whole turn fits. When several phases touch one cell, it shows the most notable: thinking, then tool, then writing, then waiting.

Each cell is two lanes, thinking on top and tools below:

| Cell | Phase |
| --- | --- |
| `▀` | Thinking |
| `▄` | Calling or running a tool |
| `█` | Writing the answer |
| blank | Waiting on the model |

A dim `▕` closes the strip, so trailing waiting time still reads as time.

After the strip, the time spent in each phase: `think 11s · tools 13s · write 5s`. A phase under half a second reads `<1s`.

Phases come from two sources: the model's chunks, and the mode of Claude Code's own spinner line (requesting, thinking, responding, tool input, tool use). The spinner still reports thinking when thinking summaries are off and no thinking text streams.

**Meta row**

| Part | Meaning |
| --- | --- |
| `◆ 11s` | Time spent thinking this turn |
| `2 blk` | Thinking blocks this turn |
| `3 tools` | Tool calls this turn |
| `1.8k out` | Output tokens this turn (thinking included) |
| `+0.6%` | How much this turn grew the context, in points of the window. Amber at 10 points or more. Negative after a compaction. |
| `⣀⣠⣤⣴` | Growth of the last 20 turns, two turns per braille cell, scaled to the largest. An amber `↓` marks a compaction, including a `/compact` between turns. |

When the terminal is narrow, the meta row drops parts in this order: the tool count, the trail, the token count. The timeline drops its totals before it shrinks below 8 cells. The focus row drops names from the end. When the band is short on rows, it keeps the bottom ones. The top row stops 4 cells short of the right edge, clear of the band's `[-]` collapse mark. Under 12 cells it draws nothing.

The mod only follows the main conversation. Subagent thinking and turns are ignored. It makes no model calls, network requests or file writes.

## Requirements

- Claude Code v2.1.287 or later, which added mods. The mod API is still early access, so a Claude Code update can break the mod until it catches up.
- The terminal surface. Desktop, VS Code and mobile get nothing for now.
- Optional: thinking summaries turned on in `~/.claude/settings.json`:

  ```json
  { "showThinkingSummaries": true }
  ```

  Without this setting, the focus row gets names from tool calls only, and never counts second-guesses. The timeline and meta row work either way, because the spinner still reports thinking. With the setting on, the transcript also shows the thinking.

## Install

From the marketplace, inside Claude Code:

```text
/plugin marketplace add achiurizo/whispered-thoughts
/plugin install whispered-thoughts@whispered-thoughts
```

Restart Claude Code, or run `/reload-plugins`, to load it.

### From source

Clone the repo:

```sh
git clone https://github.com/achiurizo/whispered-thoughts.git
```

Load the clone for one session:

```sh
claude --plugin-dir ./whispered-thoughts
```

Or load the clone in every session: add its absolute path to the `env` block of `~/.claude/settings.json`.

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/whispered-thoughts" }
}
```

If hot reloading is enabled in a session, edits to `hooks/` take effect without a restart.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `palette` | `mono` | Timeline colors. `mono` uses brightness only (thinking plain, tools dim). `amber` and `blue` color thinking and keep tools dim. `magenta` colors thinking magenta and tools cyan. |

Change it with `/config`, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "whispered-thoughts": { "options": { "palette": "amber" } }
  }
}
```

## How it works

- A streaming `turn.step` hook watches the model's chunks and passes every chunk on unchanged. Each chunk updates the turn's phase spans, focus counts, block and tool counts, and output tokens. When a step ends, its tool calls' arguments add to the focus counts.
- A `ui.render` hook on `Spinner` notes the spinner's mode and draws the spinner unchanged. Render hooks can't write state, so the ticker applies the noted mode as a phase, up to a second late.
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
npx -p typescript tsc -p .        # type-check
```

Type-checking needs `.claude-plugin/types/`. Claude Code writes that folder each time a session loads the mod from a local folder, such as with `--plugin-dir`. The folder is gitignored, so a fresh clone can't type-check until you start Claude Code once with `claude --plugin-dir .`. A marketplace install does not write it.

CI runs the same three checks on every pull request.

## License

MIT. See [LICENSE](LICENSE).
