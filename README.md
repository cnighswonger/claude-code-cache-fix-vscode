# Claude Code Cache Fix — VS Code Extension

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub release](https://img.shields.io/github/v/release/cnighswonger/claude-code-cache-fix-vscode)](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)

One-click activation of [claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix) for Claude Code sessions in VS Code.

## What it does

Automatically configures the `claudeCode.claudeProcessWrapper` setting to load the cache-fix interceptor into every Claude Code session started from VS Code. The interceptor (v2.0.0) includes 15 cache-stability fixes that reduce unnecessary cache rebuilds by up to 99.8%. Compatible with CC v2.1.112 and Opus 4.7.

## Prerequisites

Install the interceptor globally:

```bash
npm install -g claude-code-cache-fix
```

## Usage

1. Install this extension
2. It auto-enables on first activation if the interceptor is installed
3. Restart any active Claude Code session

That's it. The extension handles the wrapper configuration automatically.

### Commands

- **Claude Code Cache Fix: Enable** — Activate the interceptor
- **Claude Code Cache Fix: Disable** — Deactivate (restores default Claude Code behavior)
- **Claude Code Cache Fix: Show Status** — Check if the interceptor is installed and active

## How it works

The VS Code Claude Code extension spawns `claude` as a subprocess. This extension sets `claudeCode.claudeProcessWrapper` to a bundled Node.js wrapper that:

1. Sets `NODE_OPTIONS` to load the interceptor via `--import`
2. Spawns `node cli.js` with the cache fixes active
3. Passes all arguments through to Claude Code

No native compilation required. Works on Windows, macOS, and Linux.

## Related

- [claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix) — The interceptor (v2.0.0, 15 fixes, 150+ stars)
- [Blog series](https://veritassuperaitsolutions.com/three-layer-gate-quota-overage/) — Technical analysis

## License

MIT — [Veritas Supera IT Solutions LLC](https://veritassuperaitsolutions.com)
