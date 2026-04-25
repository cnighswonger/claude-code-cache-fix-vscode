# claude-code-cache-fix

[![npm](https://img.shields.io/npm/v/claude-code-cache-fix?color=blue)](https://www.npmjs.com/package/claude-code-cache-fix) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/cnighswonger/claude-code-cache-fix)](https://github.com/cnighswonger/claude-code-cache-fix/stargazers)

English | [中文](./README.zh.md) | [한국어](./README.ko.md) | [Português](./docs/guia-pt-br.md)

Cache optimization proxy and interceptor for [Claude Code](https://github.com/anthropics/claude-code). Fixes prompt cache bugs that cause excessive quota burn, stabilizes the request prefix, and monitors for silent regressions. Works with all CC versions including the v2.1.113+ Bun binary.

> **v3.0.0** adds a local HTTP proxy with hot-reloadable extensions. This is the recommended path for CC v2.1.113+ where the preload interceptor no longer works. A/B tested on v2.1.117: **95.5% cache hit rate through proxy vs 82.3% direct** on first warm turn. [Full release notes →](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.0.0)

> **Opus 4.7 advisory:** Metered data shows 4.7 burns Q5h quota at **~2.4x the rate of 4.6** for equivalent visible token counts. Two factors: a new tokenizer (up to 35% more tokens, [documented](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)) and adaptive thinking overhead (~105%, not documented in usage response). Workaround: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` (may reduce quality). See [Discussion #25](https://github.com/cnighswonger/claude-code-cache-fix/discussions/25) for full analysis.

## Quick Start: Proxy (recommended for CC v2.1.113+)

The proxy works with any CC version — Node.js or Bun binary. It sits between Claude Code and the Anthropic API, applying cache fixes as hot-reloadable extensions.

```bash
# Install
npm install -g claude-code-cache-fix

# Start the proxy (runs on localhost:9801)
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &

# Launch Claude Code through it
ANTHROPIC_BASE_URL=http://127.0.0.1:9801 claude
```

That's it. The proxy applies all 7 cache-fix extensions automatically. No wrapper scripts, no `NODE_OPTIONS`, no preload.

### What the proxy does

On every request passing through, 7 extensions run in order:

| Extension | What it fixes |
|-----------|--------------|
| `fingerprint-strip` | Removes unstable cc_version fingerprint from system prompt |
| `sort-stabilization` | Deterministic ordering of tool and MCP definitions |
| `ttl-management` | Detects server TTL tier, injects correct cache_control markers |
| `identity-normalization` | Normalizes message identity fields for prefix stability |
| `fresh-session-sort` | Fixes non-deterministic ordering on first turn |
| `cache-control-normalize` | Normalizes cache_control markers across messages |
| `cache-telemetry` | Extracts cache stats from response headers → `~/.claude/quota-status.json` |

Extensions are hot-reloadable — add, remove, or modify `.mjs` files in `proxy/extensions/` and changes apply to the next request without restarting. Configuration in `proxy/extensions.json`.

### Running as a service

For persistent use, run the proxy in the background:

```bash
# Start in background with logging
nohup node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" > /tmp/cache-fix-proxy.log 2>&1 &

# Add to your shell profile
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9801' >> ~/.bashrc
```

### Health check

```bash
curl http://127.0.0.1:9801/health
# {"status":"ok"}
```

## Corporate environments (proxies, custom CAs)

The proxy honors the following environment variables when forwarding to `api.anthropic.com`:

| Variable | Effect |
|----------|--------|
| `HTTPS_PROXY` / `HTTP_PROXY` (and lowercase variants) | Routes upstream requests through your corporate HTTP CONNECT proxy. |
| `NO_PROXY` | Comma-separated host list to bypass the proxy. Supports `*` and `.suffix.example.com`. |
| `CACHE_FIX_PROXY_CA_FILE` | Path to a PEM file with one or more extra CA certificates (for SSL-inspecting proxies). Alternative to setting `NODE_EXTRA_CA_CERTS` system-wide. |
| `NODE_EXTRA_CA_CERTS` | Standard Node mechanism — also honored. |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **Insecure escape hatch.** Disables TLS verification. Use only as a last resort while you wait for IT to provide the corp CA bundle. |

Example (Windows PowerShell):

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

Stderr will print `[upstream] using proxy http://proxy.corp.example:8080 ...` on first request if the agent is wired correctly.

## Quick Start: Preload (for CC v2.1.112 and earlier)

If you're on a Node.js-based CC version (v2.1.112 or earlier), the preload interceptor still works and requires no proxy:

```bash
npm install -g claude-code-cache-fix
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **Note:** The preload does NOT work on CC v2.1.113+ (Bun binary). Use the proxy path above.

See [Preload Setup Details](#preload-setup-details) below for wrapper scripts, shell aliases, and Windows instructions.

## Security model

> **This interceptor patches `globalThis.fetch`.** By design, it has full read/write access to all API requests and responses in the Claude Code process. This is inherent to the approach — any fetch interceptor, proxy, or gateway has this position.

**What it does:** Modifies outgoing request structure (block order, fingerprint, TTL, git-status) to fix cache bugs. Reads response headers and SSE usage data for monitoring.

**What it does NOT do:** No network calls from the interceptor. All telemetry is written to local files under `~/.claude/`. No data leaves your machine unless you explicitly opt in to [claude-code-meter](https://github.com/cnighswonger/claude-code-meter) sharing (separate package, requires interactive consent).

**Supply chain:** Single unminified file (`preload.mjs`, ~1,700 lines). One dependency (`zod` for schema validation in tests only). Review before installing. npm provenance links each published version to its source commit.

**Independent audit:** [Assessed as "LEGITIMATE TOOL"](https://github.com/anthropics/claude-code/issues/38335#issuecomment-4244413605) by @TheAuditorTool (2026-04-14).

## The problem

When you use `--resume` or `/resume` in Claude Code, the prompt cache breaks silently. Instead of reading cached tokens (cheap), the API rebuilds them from scratch on every turn (expensive). A session that should cost ~$0.50/hour can burn through $5–10/hour with no visible indication anything is wrong.

Three bugs cause this:

1. **Partial block scatter** — Attachment blocks (skills listing, MCP servers, deferred tools, hooks) are supposed to live in `messages[0]`. On resume, some or all of them drift to later messages, changing the cache prefix.

2. **Fingerprint instability** — The `cc_version` fingerprint (e.g. `2.1.92.a3f`) is computed from `messages[0]` content including meta/attachment blocks. When those blocks shift, the fingerprint changes, the system prompt changes, and cache busts.

3. **Non-deterministic tool ordering** — Tool definitions can arrive in different orders between turns, changing request bytes and invalidating the cache key.

Additionally, images read via the Read tool persist as base64 in conversation history and are sent on every subsequent API call, compounding token costs silently.

## Preload Setup Details

<details>
<summary>Expand for preload interceptor setup (CC v2.1.112 and earlier only)</summary>

### Installation

Requires Node.js >= 18 and Claude Code installed via npm (not the standalone binary).

```bash
npm install -g claude-code-cache-fix
```

### Usage

The preload works as a Node.js module that intercepts API requests before they leave your machine.

### Option A: Wrapper script (recommended)

Create a wrapper script (e.g. `~/bin/claude-fixed`):

```bash
#!/bin/bash
NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null)"

CLAUDE_NPM_CLI="$NPM_GLOBAL_ROOT/@anthropic-ai/claude-code/cli.js"
CACHE_FIX="$NPM_GLOBAL_ROOT/claude-code-cache-fix/preload.mjs"

if [ ! -f "$CLAUDE_NPM_CLI" ]; then
  echo "Error: Claude Code npm package not found at $CLAUDE_NPM_CLI" >&2
  echo "Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

if [ ! -f "$CACHE_FIX" ]; then
  echo "Error: claude-code-cache-fix not found at $CACHE_FIX" >&2
  echo "Install with: npm install -g claude-code-cache-fix" >&2
  exit 1
fi

exec env NODE_OPTIONS="--import $CACHE_FIX" node "$CLAUDE_NPM_CLI" "$@"
```

```bash
chmod +x ~/bin/claude-fixed
```

Adjust `CLAUDE_NPM_CLI` if your npm global prefix differs. Find it with:
```bash
npm root -g
```

### Option B: Shell alias

```bash
alias claude='NODE_OPTIONS="--import claude-code-cache-fix" node "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
```

### Option C: Direct invocation

```bash
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **Note**: This only works if `claude` points to the npm/Node installation. The standalone binary uses a different execution path that bypasses Node.js preloads.

### Windows users

On Windows, `NODE_OPTIONS="--import ..."` doesn't work the same way as on Linux/macOS. Use the included `claude-fixed.bat` wrapper instead:

1. After installing both packages globally:
   ```bat
   npm install -g claude-code-cache-fix
   npm install -g @anthropic-ai/claude-code
   ```

2. Copy `claude-fixed.bat` from this package to a directory in your PATH (e.g., `C:\Users\<you>\bin\`):
   ```bat
   copy "%NPM_ROOT%\claude-code-cache-fix\claude-fixed.bat" C:\Users\%USERNAME%\bin\
   ```
   Or find the file manually at your npm global root (run `npm root -g` to locate it).

3. Run Claude Code with the interceptor active:
   ```bat
   claude-fixed [any claude args...]
   ```

The wrapper dynamically resolves your npm global root, constructs a `file:///` URL for the preload module (converting backslashes to forward slashes for Node.js), and launches Claude Code with the interceptor loaded. All environment variables (`CACHE_FIX_DEBUG`, `CACHE_FIX_IMAGE_KEEP_LAST`, etc.) work the same as on Linux/macOS.

Credit: [@TomTheMenace](https://github.com/anthropics/claude-code/issues/38335) contributed the Windows wrapper and validated the interceptor across a 7.5-hour, 536-call Opus 4.6 session on Windows — 98.4% cache hit rate, 81% of calls had fingerprint instability that the interceptor corrected.

## VS Code Extension

### Option A: VSIX extension (recommended)

The easiest path — a VS Code extension that handles everything automatically:

1. Install the interceptor: `npm install -g claude-code-cache-fix`
2. Download the VSIX from [GitHub Releases](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)
3. Install: `code --install-extension claude-code-cache-fix-0.1.0.vsix`
   (or in VS Code: Extensions → `...` menu → "Install from VSIX...")
4. Restart any active Claude Code session

The extension auto-configures `claudeCode.claudeProcessWrapper` on activation. No manual settings needed. Works on Windows, macOS, and Linux.

Commands available in the VS Code command palette:
- **Claude Code Cache Fix: Enable** / **Disable** / **Show Status**

### Option B: Manual wrapper (if you prefer not to install the VSIX)

The VS Code Claude Code extension spawns `claude.exe` / `claude` as a subprocess. The `claude-code.environmentVariables` setting does **not** propagate `NODE_OPTIONS`, so a process wrapper is required.

**Linux / macOS** — create `~/bin/claude-vscode-wrapper`:

```bash
#!/bin/bash
NPM_ROOT="$(npm root -g 2>/dev/null)"
PRELOAD="$NPM_ROOT/claude-code-cache-fix/preload.mjs"
shift  # VS Code passes the original claude path as $1
export NODE_OPTIONS="--import $PRELOAD"
exec node "$NPM_ROOT/@anthropic-ai/claude-code/cli.js" "$@"
```

```bash
chmod +x ~/bin/claude-vscode-wrapper
```

Add to VS Code `settings.json`:

```json
{
  "claudeCode.claudeProcessWrapper": "/home/YOUR_USERNAME/bin/claude-vscode-wrapper"
}
```

**Windows** — `.bat`/`.cmd` wrappers fail because the extension uses `child_process.spawn()` without `shell: true`. Use the C wrapper source included in this package (`tools/claude-vscode-wrapper.c`):

```cmd
cl tools\claude-vscode-wrapper.c /Fe:claude-vscode-wrapper.exe
```

Then set in VS Code `settings.json`:

```json
{
  "claudeCode.claudeProcessWrapper": "C:\\path\\to\\claude-vscode-wrapper.exe"
}
```

### Known limitations (VS Code)

- **Fingerprint fix**: Fixed in v1.11.0 — the safety check now handles both the v2.1.108+ extraction method and the legacy method. No workaround needed. (Previously required `CACHE_FIX_SKIP_FINGERPRINT=1`.)

Credit: [@JEONG-JIWOO](https://github.com/JEONG-JIWOO) and [@X-15](https://github.com/X-15) for the VS Code extension investigation and C wrapper ([#16](https://github.com/cnighswonger/claude-code-cache-fix/issues/16)).

</details>

## How it works

The module intercepts `globalThis.fetch` before Claude Code makes API calls to `/v1/messages`. On each call it:

1. **Scans all user messages** for relocated attachment blocks (skills, MCP, deferred tools, hooks) and moves the latest version of each back to `messages[0]`, matching fresh session layout
2. **Sorts tool definitions** alphabetically by name for deterministic ordering
3. **Recomputes the cc_version fingerprint** from the real user message text instead of meta/attachment content

All fixes are idempotent — if nothing needs fixing, the request passes through unmodified. The interceptor is read-only with respect to your conversation; it only normalizes the request structure before it hits the API.

## Graduating from Fixes

The interceptor serves three purposes with different lifecycles:

| Purpose | Examples | When to disable |
|---------|----------|-----------------|
| **Bug fixes** | Block relocation, fingerprint, tool sort, TTL | When CC fixes the underlying bug — check the health line |
| **Monitoring** | Quota tracking, microcompact detection, GrowthBook flags | Keep permanently — these detect future regressions |
| **Optimizations** | Image stripping, output efficiency rewrite | Keep as long as they help your workflow |

### Health status

On first API call, the interceptor logs a health status line (requires `CACHE_FIX_DEBUG=1`):

```
cache-fix health: relocate=active(2h ago) fingerprint=dormant(5 clean sessions) tool_sort=active ttl=active identity=waiting
```

Status meanings:
- **active(Xh ago)** — fix was applied recently
- **dormant(N clean sessions)** — bug not detected in N resume sessions; CC may have fixed it
- **safety-blocked(Nx)** — round-trip verification failed; CC changed its algorithm, fix auto-disabled
- **waiting** — fix hasn't been triggered yet

When a fix shows `dormant`, you can safely disable it:
```bash
export CACHE_FIX_SKIP_RELOCATE=1  # example
```

To disable all fixes but keep monitoring:
```bash
export CACHE_FIX_DISABLED=1
```

### Regression detection

If cache_read ratio drops below 50% across 5+ calls after disabling fixes, you'll see:
```
REGRESSION WARNING: cache_read ratio averaged 12% across last 5 calls.
Fixes are disabled — consider re-enabling to recover cache performance.
```

## Safety

### Fingerprint round-trip verification

Before rewriting the `cc_version` fingerprint, the interceptor verifies that its
hardcoded salt and character indices reproduce the fingerprint Claude Code sent.
If verification fails (CC changed its algorithm), the rewrite is skipped automatically.
This ensures the interceptor can never make cache performance *worse* than stock CC.

### Fail-safe design

Every fix is designed to fail to a no-op:
- If block detection regexes don't match → blocks aren't relocated (CC behavior)
- If fingerprint format changes → fingerprint isn't rewritten (CC behavior)
- If tool sort produces no changes → payload passes through untouched
- If TTL injection target structure changes → TTL isn't injected (CC behavior)

The interceptor can only *help* or *do nothing*. It cannot make things worse.

## Status line — quota warnings in real time

The interceptor writes quota state to `~/.claude/quota-status.json` on every API call. The included `tools/quota-statusline.sh` script reads this file and displays a live status line in Claude Code showing:

- **Q5h %** with burn rate (%/min)
- **Q7d %** with burn rate (%/hr)
- **TTL tier** — shows `TTL:1h` when healthy, **`TTL:5m` in red when the server has downgraded you** (typically at Q5h ≥ 100%)
- **PEAK** in yellow during weekday peak hours (13:00–19:00 UTC)
- **Cache hit rate %**
- **OVERAGE** flag when active

### Setup

Copy the script and configure Claude Code to use it:

```bash
# Copy from the npm package to Claude Code's hooks directory
mkdir -p ~/.claude/hooks
cp "$(npm root -g)/claude-code-cache-fix/tools/quota-statusline.sh" ~/.claude/hooks/
chmod +x ~/.claude/hooks/quota-statusline.sh
```

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/quota-statusline.sh"
  }
}
```

### Recommended: disable git-status injection

Claude Code injects live `git status` output into the system prompt on every call. Any file edit changes the git status, which changes the system prompt, which busts the entire prefix cache. Disabling this saves ~1,800 tokens per call and fully stabilizes the system prompt across file edits:

```bash
export CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1
```

Or add `"includeGitInstructions": false` to `~/.claude/settings.json`. Claude Code can still run `git status` via the Bash tool when it needs git context — it just won't pre-inject it into every system prompt.

The flag also shrinks the Bash tool description by ~6,364 chars (the Bash tool includes git-related instructions that are stripped when the flag is set), for a total prefix savings of ~7,180 chars (~1,800 tokens) per call.

Community-validated by [@wadabum](https://github.com/cnighswonger/claude-code-cache-fix/issues/11): 18-token cache creation across git state changes (vs thousands without the flag). See [#11](https://github.com/cnighswonger/claude-code-cache-fix/issues/11) for the full telemetry comparison.

**Note:** this flag does not address the `"Primary working directory"` line in the system prompt, which changes per git worktree. A v1.9.0 interceptor fix to strip/normalize both is planned ([#11](https://github.com/cnighswonger/claude-code-cache-fix/issues/11)).

### Why the status line matters

When the server downgrades your TTL to 5m (Layer 2 — quota-aware downgrade at Q5h ≥ 100%), **every idle longer than 5 minutes causes a full context rebuild**. Without the status line, this is invisible — you just notice things getting slower and more expensive. With the status line, the red `TTL:5m` warning tells you immediately: **stop working, wait for the Q5h window to reset, then resume**. Powering through overage compounds the drain; pausing breaks the cycle.

## Image stripping

Images read via the Read tool are encoded as base64 and stored in `tool_result` blocks in conversation history. They ride along on **every subsequent API call** until compaction. A single 500KB image costs ~62,500 tokens per turn on Opus 4.6, and potentially **~85,000+ tokens on Opus 4.7** due to the new tokenizer (up to 35% inflation) and high-res image support (2576px max, up from 1568px). Image stripping is strongly recommended on 4.7.

Enable image stripping to remove old images from tool results:

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

This keeps images in the last 3 user messages and replaces older ones with a text placeholder. Only targets images inside `tool_result` blocks (Read tool output) — user-pasted images are never touched. Files remain on disk for re-reading if needed.

Set to `0` (default) to disable.

## System prompt rewrite (optional)

The interceptor can also rewrite Claude Code's `# Output efficiency` system-prompt section before the request is sent.

This feature is **optional** and **disabled by default**. If `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` is unset, nothing is changed.

Enable it by setting a replacement text:

```bash
export CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT=$'# Output efficiency\n\n...'
```

The rewrite is intentionally narrow:

- Only Claude Code's `# Output efficiency` section is replaced
- Other system prompt sections are preserved
- Existing system block structure and fields such as `cache_control` are preserved

This may be useful for users who want to stay on current Claude Code versions but experiment with a different `Output efficiency` instruction set instead of downgrading to an earlier release.

### Prompt variants

<details>
<summary>Anthropic internal / <code>USER_TYPE=ant</code> version</summary>

```text
# Output efficiency

When sending user-facing text, you're writing for a person, not logging to a console. Assume users can't see most tool calls or thinking - only your text output. Before your first tool call, briefly state what you're about to do. While working, give short updates at key moments: when you find something load-bearing (a bug, a root cause), when changing direction, when you've made progress without an update.

When you give updates, assume the recipient may have stepped away and lost the thread. They do not know your internal shorthand, codenames, or half-formed plan. Write in complete, grammatical sentences that can be understood cold. Spell out technical terms when helpful. If unsure, err on the side of a bit more explanation. Adapt to the user's expertise: experts can handle denser updates, but don't make novice users reconstruct context on their own.

User-facing text should read like natural prose. Avoid clipped sentence fragments, excessive dashes, symbolic shorthand, or formatting that reads like console output. Use tables only when they genuinely improve scanability, such as compact facts (files, lines, pass/fail) or quantitative comparisons. Keep explanatory reasoning in prose around the table, not inside it. Avoid semantic backtracking: structure sentences so the user can follow them linearly without having to reinterpret earlier clauses after reading later ones.

Optimize for fast human comprehension, not minimal surface area. If the user has to reread your summary or ask a follow-up just to understand what happened, you saved the wrong tokens. Match the level of structure to the task: for a simple question, answer in plain prose without unnecessary headings or numbered lists. While staying clear and direct, also be concise and avoid fluff. Skip filler, obvious restatements, and throat-clearing. Get to the point. Don't over-focus on low-signal details from your process. When it helps, use an inverted pyramid structure with the conclusion first and details later.

These user-facing text instructions do not apply to code or tool calls.
```

</details>

<details>
<summary>Public / default Claude Code version</summary>

```text
# Output efficiency

IMPORTANT: Go straight to the point. Try the simplest approach first without going in circles. Do not overdo it. Be extra concise.

Your text output is brief, direct, and to the point. Lead with the answer or action, not the reasoning. Omit filler, preamble, and unnecessary transitions. Do not restate the user's request; move directly to the work. When explanation is needed, include only what helps the user understand the outcome.

Prioritize user-facing text for:
- decisions that require user input
- high-signal progress updates at natural milestones
- errors or blockers that change the plan

If a sentence can do the job, do not turn it into three. Favor short, direct constructions over long explanatory prose. These instructions do not apply to code or tool calls.
```

</details>

<details>
<summary>Example custom replacement(A middle-ground version combining the two versions above)</summary>

```text
# Output efficiency

When sending user-facing text, write for a person, not a log file. Assume the user cannot see most tool calls or hidden reasoning - only your text output.

Keep user-facing text clear, direct, and reasonably concise. Lead with the answer or action. Skip filler, repetition, and unnecessary preamble.

Explain enough for the user to understand the reasoning, tradeoffs, or root cause when that would help them learn or make a decision, but do not turn simple answers into long writeups.

These instructions apply to user-facing text only. They do not apply to investigation, code reading, tool use, or verification.

Before making changes, read the relevant code and understand the surrounding context. Check types, signatures, call sites, and error causes before editing. Do not confuse brevity with rushing, and do not replace understanding with trial and error.

While working, give short updates at meaningful moments: when you find the root cause, when the plan changes, when you hit a blocker, or when a meaningful milestone is complete. Do not narrate every step.

When reporting results, be accurate and concrete. If you did not verify something, say so plainly. If a check failed, say that plainly too.
```

</details>

## Monitoring

The interceptor includes monitoring for several additional issues identified by the community:

### Microcompact / budget enforcement

Claude Code silently replaces old tool results with `[Old tool result content cleared]` via server-controlled mechanisms (GrowthBook flags). A 200,000-character aggregate cap and per-tool caps (Bash: 30K, Grep: 20K) truncate older results without notification. There is no `DISABLE_MICROCOMPACT` environment variable.

The interceptor detects cleared tool results and logs counts. When total tool result characters approach the 200K threshold, a warning is logged.

### False rate limiter

The client can generate synthetic "Rate limit reached" errors without making an API call, identifiable by `"model": "<synthetic>"`. The interceptor logs these events.

### GrowthBook flag dump

On the first API call, the interceptor reads `~/.claude.json` and logs the current state of cost/cache-relevant server-controlled flags (hawthorn_window, pewter_kestrel, slate_heron, session_memory, etc.).

### Quota tracking

Response headers are parsed for `anthropic-ratelimit-unified-5h-utilization` and `7d-utilization`, saved to `~/.claude/quota-status.json` for consumption by status line hooks or other tools.

### Peak hour detection

Anthropic applies elevated quota drain rates during weekday peak hours (13:00–19:00 UTC, Mon–Fri). The interceptor detects peak windows and writes `peak_hour: true/false` to `quota-status.json`. See `docs/peak-hours-reference.md` for sources and details.

### Usage telemetry and cost reporting

The interceptor logs per-call usage data to `~/.claude/usage.jsonl` — one JSON line per API call with model, token counts, and cache breakdown. Use the bundled cost report tool to analyze costs:

```bash
node tools/cost-report.mjs                    # today's costs from interceptor log
node tools/cost-report.mjs --date 2026-04-08  # specific date
node tools/cost-report.mjs --since 2h         # last 2 hours
node tools/cost-report.mjs --admin-key <key>  # cross-reference with Admin API
```

Also works with any JSONL containing Anthropic usage fields (`--file`, stdin) — useful for SDK users and proxy setups. See `docs/cost-report.md` for full documentation.

### Quota analysis (5-hour quota counting)

The same `usage.jsonl` log can be analyzed to test how Anthropic's 5-hour quota is actually computed. Run the bundled tool:

```bash
node tools/quota-analysis.mjs              # analyze your default log
node tools/quota-analysis.mjs --since 24h  # last 24 hours only
node tools/quota-analysis.mjs --json       # machine-readable output
```

The tool answers three questions from your own data:

1. **Does `cache_read` count toward your 5-hour quota?** Tests three hypotheses (cache_read costs 0x / 0.1x / 1x of input rate) and reports which one best explains your `q5h_pct` trajectory across reset windows. Lower coefficient of variation across windows = better fit.
2. **Do peak hours cost more quota per token?** Splits windows into peak-dominant (≥80% peak calls) and off-peak-dominant (≤20%) and compares the implied 100% quota under the best-fit model.
3. **What is your account's effective 5-hour quota in token-equivalents?** Reports a concrete number you can compare against your subscription tier or against what other users measure.

Requires `q5h_pct`, `q7d_pct`, and `peak_hour` fields in usage.jsonl, which were added in v1.6.1 (2026-04-09). Older entries are silently filtered out.

**Help us validate across accounts:** if you run this on your own log, please open an issue or PR on this repo with your output (or just the best-fit hypothesis name and your peak/off-peak ratio). Cross-validating across multiple accounts is the only way to distinguish per-account variance from real findings. Reference: [anthropics/claude-code#45756](https://github.com/anthropics/claude-code/issues/45756).

## Debug mode

Enable debug logging to verify the fix is working:

```bash
CACHE_FIX_DEBUG=1 claude-fixed
```

Logs are written to `~/.claude/cache-fix-debug.log`. Look for:
- `APPLIED: resume message relocation` — block scatter was detected and fixed
- `APPLIED: tool order stabilization` — tools were reordered
- `APPLIED: fingerprint stabilized from XXX to YYY` — fingerprint was corrected
- `APPLIED: stripped N images from old tool results` — images were stripped
- `APPLIED: output efficiency section rewritten` — output-efficiency section was replaced
- `MICROCOMPACT: N/M tool results cleared` — microcompact degradation detected
- `BUDGET WARNING: tool result chars at N / 200,000 threshold` — approaching budget cap
- `FALSE RATE LIMIT: synthetic model detected` — client-side false rate limit
- `GROWTHBOOK FLAGS: {...}` — server-controlled feature flags on first call
- `PROMPT SIZE: system=N tools=N injected=N (skills=N mcp=N ...)` — per-call prompt size breakdown
- `CACHE TTL: tier=1h create=N read=N hit=N% (1h=N 5m=N)` — TTL tier and cache hit rate per call
- `PEAK HOUR: weekday 13:00-19:00 UTC` — Anthropic peak hour throttling active
- `SKIPPED: resume relocation (not a resume or already correct)` — no fix needed
- `SKIPPED: output efficiency rewrite (section not found)` — no matching output-efficiency section found

### Prefix diff mode

Enable cross-process prefix snapshot diffing to diagnose cache busts on restart:

```bash
CACHE_FIX_PREFIXDIFF=1 claude-fixed
```

Snapshots are saved to `~/.claude/cache-fix-snapshots/` and diff reports are generated on the first API call after a restart.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_FIX_DEBUG` | `0` | Enable debug logging to `~/.claude/cache-fix-debug.log` |
| `CACHE_FIX_PREFIXDIFF` | `0` | Enable prefix snapshot diffing |
| `CACHE_FIX_IMAGE_KEEP_LAST` | `0` | Keep images in last N user messages (0 = disabled) |
| `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` | unset | Replace Claude Code's `# Output efficiency` system-prompt section before the request is sent |
| `CACHE_FIX_USAGE_LOG` | `~/.claude/usage.jsonl` | Path for per-call usage telemetry log |
| `CACHE_FIX_DISABLED` | `0` | Disable all bug fixes; keep monitoring + optimizations active |
| `CACHE_FIX_SKIP_RELOCATE` | `0` | Skip block relocation fix (Bug 1) |
| `CACHE_FIX_SKIP_FINGERPRINT` | `0` | Skip fingerprint stabilization (Bug 2b) |
| `CACHE_FIX_SKIP_TOOL_SORT` | `0` | Skip tool ordering stabilization (Bug 2a) |
| `CACHE_FIX_SKIP_TTL` | `0` | Skip TTL injection (Bug 5) |
| `CACHE_FIX_SKIP_IDENTITY` | `0` | Skip identity normalization (Bug 6) |
| `CACHE_FIX_SKIP_GIT_STATUS` | `0` | Skip git-status stripping |
| `CACHE_FIX_STRIP_GIT_STATUS` | `0` | Strip volatile git-status from system prompt for prefix stability. Model can still run `git status` via Bash. |
| `CACHE_FIX_TTL_MAIN` | `1h` | TTL for main-thread requests: `1h`, `5m`, or `none` (pass-through) |
| `CACHE_FIX_TTL_SUBAGENT` | `1h` | TTL for subagent requests: `1h`, `5m`, or `none` (pass-through) |
| `CACHE_FIX_DUMP_BREAKPOINTS` | unset | Path to dump cache breakpoint structure (diagnostic for #12) |

## Limitations

- **npm installation only** — The standalone Claude Code binary has Zig-level attestation that bypasses Node.js. This fix only works with the npm package (`npm install -g @anthropic-ai/claude-code`).
- **Overage TTL downgrade** — Exceeding 100% of the 5-hour quota triggers a server-enforced TTL downgrade from 1h to 5m. This is a server-side decision and cannot be fixed client-side. The interceptor prevents the cache instability that can push you into overage in the first place.
- **Microcompact is not preventable** — The monitoring features detect context degradation but cannot prevent it. The microcompact and budget enforcement mechanisms are server-controlled via GrowthBook flags with no client-side disable option.
- **System prompt rewrite is experimental** — This hook only rewrites one system-prompt section and is opt-in, but there are still unknowns: it is not proven that this prompt text is responsible for the behavior differences discussed in community reports, and it is not known whether future server-side validation could react to modified system prompts. Use at your own risk.
- **Version coupling** — The fingerprint salt and block detection heuristics are derived from Claude Code internals. A major refactor could require an update to this package.

## Tracked issues

- [#34629](https://github.com/anthropics/claude-code/issues/34629) — Original resume cache regression report
- [#40524](https://github.com/anthropics/claude-code/issues/40524) — Within-session fingerprint invalidation, image persistence
- [#42052](https://github.com/anthropics/claude-code/issues/42052) — Community interceptor development, TTL downgrade discovery
- [#43044](https://github.com/anthropics/claude-code/issues/43044) — Resume loads 0% context on v2.1.91
- [#43657](https://github.com/anthropics/claude-code/issues/43657) — Resume cache invalidation confirmed on v2.1.92
- [#44045](https://github.com/anthropics/claude-code/issues/44045) — SDK-level reproduction with token measurements
- [#32508](https://github.com/anthropics/claude-code/issues/32508) — Community discussion around the `Output efficiency` system-prompt change and its possible effect on model behavior

## Related research

- **[@ArkNill/claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis)** — Systematic proxy-based analysis of 7 bugs including microcompact, budget enforcement, false rate limiter, and extended thinking quota impact. The monitoring features in v1.1.0 are informed by this research.
- **[@Renvect/X-Ray-Claude-Code-Interceptor](https://github.com/Renvect/X-Ray-Claude-Code-Interceptor)** — Diagnostic HTTPS proxy with real-time dashboard, system prompt section diffing, per-tool stripping thresholds, and multi-stream JSONL logging. Works with any Claude client that supports `ANTHROPIC_BASE_URL` (CLI, VS Code extension, desktop app), complementing this package's CLI-only `NODE_OPTIONS` approach.
- **[@fgrosswig/claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)** — Self-hosted forensic dashboard with SSE live monitoring, multi-host aggregation, cache-health scoring, and forced-restart/compaction detection. Reads from Claude Code's native session JSONL files and optionally from an HTTP proxy NDJSON stream. v1.4.0 documented the forced-session-restart mechanism at quota-cap boundaries (~490K tokens per event) and the 78–91% cache-wipe pattern at compaction events. Complementary to our interceptor's in-process vantage point. See [Works with @fgrosswig's dashboard](#works-with-fgrosswigs-dashboard) below for the interop pattern.

## Works with @fgrosswig's dashboard

This interceptor and [@fgrosswig](https://github.com/fgrosswig)'s
[claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard)
solve strongly complementary problems. The interceptor captures per-call API
data from inside the Node.js process — cache metrics, quota state, TTL tier,
rewrites applied. The dashboard provides the visualization layer — historical
trending, per-day charts, multi-host aggregation, cache-health scoring.

Running both gives you the best of both tools, and the integration is a
one-liner thanks to the dashboard's tolerant NDJSON ingest and our new
`usage-to-dashboard-ndjson` translator.

### Quick setup

```bash
# Install both tools
npm install -g claude-code-cache-fix
# (follow fgrosswig's dashboard install: https://github.com/fgrosswig/claude-usage-dashboard)

# One-shot translation (reads ~/.claude/usage.jsonl, writes to
# ~/.claude/anthropic-proxy-logs/proxy-YYYY-MM-DD.ndjson, which his
# dashboard already watches)
node $(npm root -g)/claude-code-cache-fix/tools/usage-to-dashboard-ndjson.mjs

# Or keep it live-updating as the interceptor logs new calls
node $(npm root -g)/claude-code-cache-fix/tools/usage-to-dashboard-ndjson.mjs --follow &
```

No configuration required on the dashboard side — fgrosswig's
`collectProxyNdjsonFiles()` auto-discovers files in
`~/.claude/anthropic-proxy-logs/` (or `$ANTHROPIC_PROXY_LOG_DIR`), and our
translator writes to exactly that path with the expected `proxy-YYYY-MM-DD.ndjson`
filename convention. The dashboard's tolerant ingestion layer ignores unknown
fields, so interceptor-specific extras (`ttl_tier`, `ephemeral_1h_input_tokens`,
`ephemeral_5m_input_tokens`, `peak_hour`, quota state) pass through cleanly
and remain available to downstream consumers that know to read them.

The `cost_factor` metric in `tools/cost-report.mjs` also comes from
fgrosswig's methodology — the `(input + output + cache_read + cache_creation) / output`
ratio that gives a single-number measure of how much context is being paid
per useful output token. A rising cost factor across a long session is the
measurable signature of cache-efficiency degradation.

## Used in production

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP development environment. First production team to merge the interceptor to trunk for team-wide deployment (2026-04-10). Identified two distinct cache regression patterns through real-world testing — tool ordering jitter and the fresh-session sort gap — and contributed debug traces that drove the v1.5.1 and v1.6.2 fixes.

## Contributors

- **[@VictorSun92](https://github.com/VictorSun92)** — Original monkey-patch fix for v2.1.88, identified partial scatter on v2.1.90, contributed forward-scan detection, correct block ordering, tighter block matchers, and the optional output-efficiency rewrite hook
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP production environment validation, 1h cache TTL confirmation, tool ordering jitter discovery via debug trace (fixed in v1.5.1), fresh-session sort bug discovery via SKILLS SORT diagnostic (fixed in v1.6.2). First production team to roll the interceptor to trunk.
- **[@jmarianski](https://github.com/jmarianski)** — Root cause analysis via MITM proxy capture and Ghidra reverse engineering, multi-mode cache test script
- **[@cnighswonger](https://github.com/cnighswonger)** — Fingerprint stabilization, tool ordering fix, image stripping, monitoring features, overage TTL downgrade discovery, package maintainer
- **[@ArkNill](https://github.com/ArkNill)** — Microcompact mechanism analysis, GrowthBook flag documentation, false rate limiter identification
- **[@Renvect](https://github.com/Renvect)** — Image duplication discovery, cross-project directory contamination analysis
- **[@fgrosswig](https://github.com/fgrosswig)** — [claude-usage-dashboard](https://github.com/fgrosswig/claude-usage-dashboard) forensic methodology: cost-factor overhead ratio metric, `anthropic-*` header capture pattern, proxy NDJSON schema that informed our dashboard interop layer
- **[@TomTheMenace](https://github.com/TomTheMenace)** — Windows `.bat` wrapper for the interceptor, first Windows platform validation (7.5h/536-call Opus 4.6 session, 98.4% cache hit rate, 81% fingerprint instability corrected)
- **[@arjansingh](https://github.com/arjansingh)** — nvm-compatible wrapper script with dynamic `npm root -g` path resolution (PR #15)
- **[@beekamai](https://github.com/beekamai)** — Windows URL-encoding fix for `claude-fixed.bat` when npm root contains spaces (PR #17)
- **[@JEONG-JIWOO](https://github.com/JEONG-JIWOO)** — VS Code extension investigation: discovered `claudeCode.claudeProcessWrapper` as the working integration path, wrote the C wrapper for Windows (#16)
- **[@X-15](https://github.com/X-15)** — VS Code extension validation, per-fix health status analysis confirming safety check behavior on v2.1.105 (#16)
- **[@ArkNill](https://github.com/ArkNill)** — Fingerprint verification fix for CC v2.1.108+ (`isMeta` filter change, PR #21), Korean README (PR #22), original [claude-code-hidden-problem-analysis](https://github.com/ArkNill/claude-code-hidden-problem-analysis) research
- **[@deafsquad](https://github.com/deafsquad)** — Universal smoosh_split un-smoosh fix (PR #26), source-level function attribution of resume scatter bug (anthropics/claude-code#43657), OTEL telemetry discovery

If you contributed to the community effort on these issues and aren't listed here, please open an issue or PR — we want to credit everyone properly.

## Support

If this tool saved you money, consider buying me a coffee:

<a href="https://buymeacoffee.com/vsits" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

## License

[MIT](LICENSE)
