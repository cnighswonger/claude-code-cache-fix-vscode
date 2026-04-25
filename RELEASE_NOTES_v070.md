## Highlights

Tracks upstream [`claude-code-cache-fix@3.1.0`](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.1.0) and **drops preload-mode wrapper support entirely**. Proxy mode is the only mode now — preload didn't work on the Bun-binary CC (v2.1.113+) anyway, and the 67 MB Windows wrapper `.exe` was costing every user on every download.

**VSIX size:** ~30 MB → **~20 KB** (7 files).

## What changed

### Removed — preload mode + wrapper
- Deleted `ClaudeCodeCacheFixWrapper.exe` (67 MB) and `wrapper.js`.
- Removed commands `Enable` / `Disable` (preload). Proxy commands `Enable Proxy Mode` / `Disable Proxy Mode` remain.
- Removed 13 preload-only settings (`skipRelocate`, `skipContinueTrailerStrip`, `skipReminderStrip`, `skipCacheControlSticky`, `normalizeIdentity`, `normalizeCwd`, `normalizeSmoosh`, `imageKeepLast`, `stripGitStatus`, `outputEfficiencyReplacement`, `debug`, etc.).
- On activate, leftover `claudeCode.claudeProcessWrapper` settings written by 0.6.x are cleared (only when the path looks like ours).

### Added — sync to v3.1.0 upstream defaults

Three previously dormant proxy extensions are now enabled by default; the override file at `~/.claude/cache-fix-proxy-extensions.json` mirrors that. Real-world testing of these together recovered cache hit rate from **5.9% → 99.9% in ~2 calls**.

- `smoosh-split` (order 320) — peels `system-reminder` blocks out of tool results.
- `content-strip` (order 330) — removes per-turn bookkeeping text.
- `tool-input-normalize` (order 340) — cache-stable JSON serialization for `tool_use` inputs.

Plus two env-var-controlled extensions, both wired through VS Code settings:

- `prefix-diff` — opt-in via `prefixDiff` setting (now actually wires `CACHE_FIX_PREFIXDIFF=1`).
- `deferred-tools-restore` — default-on; opt-out via `skipDeferredToolsRestore`. Addresses MCP reconnect race conditions.

### Changed — settings now actually wire to the proxy

In 0.6.x the proxy-mode `skip*` settings only updated the (now-deleted) preload wrapper config — they had **no effect on the proxy**. Fixed: every `skip*` toggle now flips the corresponding extension's `enabled` flag in the override file before each proxy spawn, and changes restart the running proxy automatically.

Settings panel collapsed from 5 sections / 28 toggles to 3 sections / 17 toggles. Less surface, every remaining knob does something.

## Migration

**Settings reused with new wiring:**
- `skipSmooshSplit` — was preload-only, now flips proxy `smoosh-split`.
- `skipDeferredToolsRestore` — was preload-only, now sets the proxy env var.
- `prefixDiff` — was preload-only, now sets the proxy env var.

**Setting renamed:** `skipToolUseInputNormalize` → `skipToolInputNormalize`. Copy your value over; VS Code marks the old key as "Unknown configuration setting".

**Settings deleted (no proxy equivalent yet upstream):** `skipRelocate`, `skipContinueTrailerStrip`, `skipReminderStrip`, `skipCacheControlSticky`, `normalizeIdentity`, `normalizeCwd`, `normalizeSmoosh`, `imageKeepLast`, `outputEfficiencyReplacement`, `debug`. For `stripGitStatus`, use the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` env var (works on Bun-binary CC too).

## Compatibility

- Requires `claude-code-cache-fix@>=3.0.1` for proxy at minimum; **`>=3.1.0`** for the new default-on extensions and env-var-controlled features.
- `httpsProxy` / `noProxy` end-to-end honored only on `>=3.0.3`.
- Auto-installed via `volta install` or `npm install -g` if missing on activate.

Full migration guide in [CHANGELOG.md](https://github.com/cnighswonger/claude-code-cache-fix-vscode/blob/main/CHANGELOG.md).

## Install

Download `claude-code-cache-fix-0.7.0.vsix` below, then:

```
code --install-extension claude-code-cache-fix-0.7.0.vsix
```

On first activate the extension installs `claude-code-cache-fix@latest` (which will be 3.1.0+) automatically. Restart any active Claude Code session afterward.
