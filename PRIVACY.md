# Privacy

dreeft is a Claude Code mod that runs on your machine, inside Claude Code. It has no server. The author receives nothing from it: no telemetry, no analytics, no crash reports, no usage counts.

This page says what the mod reads, what it stores and what leaves your machine. The README has the full detail: see [What the mod reads, runs and sends](README.md#what-the-mod-reads-runs-and-sends).

## With the default settings

The mod reads the main conversation as the model writes it (thinking text and tool call arguments), the spinner's mode and the context size. It keeps counts from them in the session's state, which Claude Code holds, and draws the band from those counts.

It writes no file, starts no program, reads no environment variable, makes no model call and no network request, and sends nothing to anyone.

## With `memoryShadow` set to `on`

This experiment is off until you turn it on.

- **What leaves your machine.** After a turn that has candidate facts, the mod makes one model call through Claude Code, to your own model provider, on your account. The call holds up to 6 quoted spans of the turn's thinking, a quoted tool result or answer sentence for each, and the project's name: the repo's `origin` URL without credentials, query string or fragment, or the repo's directory name. Your model provider handles that call under its own terms and privacy policy, as it handles the rest of your session.
- **What is stored on your machine.** The same spans and evidence, the model's verdicts, the session id, the turn id, the time, the project's name and the absolute path of the repo's main checkout are appended to `~/.local/state/dreeft/memory-shadow.jsonl`, or under `$XDG_STATE_HOME/dreeft/` when that variable is an absolute path.
- **Redaction.** Anything shaped like a credential is replaced with `[redacted]` before the model call and before the log. The match is by pattern and can miss a secret. The README lists what it catches and what it can miss.

## With `steer` set to `shadow` or `on`

This experiment is off until you turn it on.

- **What is stored on your machine.** Lines are appended to `~/.local/state/dreeft/steer.jsonl`, or under `$XDG_STATE_HOME/dreeft/`. They hold ids, times, numbers, tool names and the mod's own fixed note. They hold no text from your session.
- **What the model reads.** At `on`, the mod can append one fixed two-sentence note to your conversation. The note goes to your model provider with the turn's next request, as the rest of the conversation does. At `shadow` nothing is sent.

## The logs

- Both logs stay on your machine. The mod never uploads them, and nothing else in the mod reads them.
- The log directory is readable by your user only (`700`), and so is each log file (`600`).
- The logs are appended to and never trimmed. Uninstalling the mod does not delete them. Delete `~/.local/state/dreeft/` to remove them, or `$XDG_STATE_HOME/dreeft/` when that variable is an absolute path.

## Changes and contact

A change to what the mod reads, stores or sends is made in this file and in the README, in the same release as the code.

Questions: open an issue at <https://github.com/achiurizo/dreeft/issues>. For a security problem, use the private report described in [SECURITY.md](SECURITY.md).
