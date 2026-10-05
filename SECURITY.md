# Security

## Supported versions

Only the latest release gets security fixes.

## In scope

The mod's code: everything under `hooks/`, `scripts/` and `.claude-plugin/`.

The part most worth a close look is the memory shadow log. It is off by default. When `memoryShadow` is `on`, the mod sends quoted session text to the model provider and appends to a local log file. The README states exactly what that mode sends and stores, and what its redaction can miss: see [Memory shadow log (experimental)](README.md#memory-shadow-log-experimental). The `steer` setting is in scope beside it: off by default, at `shadow` it appends to a local log file, and at `on` it also appends a fixed note to the conversation that the model reads: see [Steering (experimental)](README.md#steering-experimental).

Claude Code itself is out of scope here.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.
