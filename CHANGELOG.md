# Changelog

All notable changes to the Claude Code Cache Fix VS Code extension.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] — 2026-04-25

Tracks upstream [`claude-code-cache-fix@3.1.0`](https://github.com/cnighswonger/claude-code-cache-fix/releases/tag/v3.1.0) and drops preload-mode wrapper support entirely. Proxy mode is the only mode now — preload didn't work on the Bun-binary CC (v2.1.113+) anyway, and shipping the 67 MB Windows wrapper .exe alongside dead code was costing every user on every download.

### Removed — preload mode and wrapper

- **Deleted `ClaudeCodeCacheFixWrapper.exe` (67 MB) and `wrapper.js`.** VSIX is now ~30 KB instead of ~30 MB.
- **Removed commands `Claude Code Cache Fix: Enable` / `Disable`** (preload). The proxy commands `Enable Proxy Mode` / `Disable Proxy Mode` remain.
- **Removed 13 preload-only settings:** `skipRelocate`, `skipContinueTrailerStrip`, `skipReminderStrip`, `skipCacheControlSticky`, `normalizeIdentity`, `normalizeCwd`, `normalizeSmoosh`, `imageKeepLast`, `stripGitStatus`, `outputEfficiencyReplacement`, `debug`, plus the preload variants of `skipSmooshSplit` / `skipDeferredToolsRestore` / `skipToolUseInputNormalize` (the names are reused for proxy-mode opt-outs — see below).
- **Removed extension code:** `WRAPPER_SETTING` write paths, `getWrapperPath`, `ensureStableWrapperCopy`, `getStableBinDir`, `enable`/`disable`/`isEnabled`, `syncSettings` (it wrote `~/.claude/cache-fix-vscode-config.json` for the wrapper to read; nothing reads it anymore).
- **On activate, leftover `claudeCode.claudeProcessWrapper` settings written by 0.6.x are cleared** if the path looks like ours (matches `.vscode/extensions/...claude-code-cache-fix...` or `~/.claude/cache-fix-bin/`). Third-party wrappers are not touched.

### Added — sync to v3.1.0 upstream defaults

Three previously dormant proxy extensions are now enabled by default in v3.1.0; the override file we write at `~/.claude/cache-fix-proxy-extensions.json` mirrors that. Real-world testing of these together recovered cache hit rate from 5.9% to 99.9% in ~2 calls.

- **`smoosh-split`** (order 320) — peels `system-reminder` blocks out of tool results.
- **`content-strip`** (order 330) — removes per-turn bookkeeping text.
- **`tool-input-normalize`** (order 340) — cache-stable JSON serialization for `tool_use` inputs.

Plus two env-var-controlled extensions, both wired through new VS Code settings:

- **`prefix-diff`** — opt-in via the existing `prefixDiff` setting (now actually wires `CACHE_FIX_PREFIXDIFF=1` into the proxy spawn env; in 0.6.x it only fed the now-deleted preload wrapper). Snapshots request prefixes to `~/.claude/cache-fix-snapshots/` for diffing.
- **`deferred-tools-restore`** — default-on in v3.1.0; opt-out via `skipDeferredToolsRestore` (sets `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1`). Addresses MCP reconnect race conditions that previously shrank tool attachments and caused massive cache misses.

### Changed — settings now actually wire to the proxy

In 0.6.x, the proxy-mode `skip*` settings only updated the now-deleted preload wrapper config — they had **no effect on the proxy**. This is fixed: every `skip*` toggle now flips the corresponding extension's `enabled` flag in the override file we write before each proxy spawn, and changes restart the running proxy automatically.

- `skipFingerprint` → `fingerprint-strip.enabled=false`
- `skipToolSort` → `sort-stabilization.enabled=false`
- `skipSessionStartNormalize` → `fresh-session-sort.enabled=false`
- `skipSmooshSplit` → `smoosh-split.enabled=false` (new wiring)
- `skipContentStrip` → `content-strip.enabled=false` (new setting + wiring)
- `skipToolInputNormalize` → `tool-input-normalize.enabled=false` (renamed from `skipToolUseInputNormalize`, new wiring)
- `skipCacheControlNormalize` → `cache-control-normalize.enabled=false`
- `skipTtl` → `ttl-management.enabled=false`
- `skipDeferredToolsRestore` → `CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE=1` (env var, new wiring)
- `prefixDiff` → `CACHE_FIX_PREFIXDIFF=1` (env var, new wiring)

The settings panel collapsed from 5 sections / 28 toggles to 3 sections / 17 toggles — Activation (3), Corporate environments (6), Pipeline extensions (8). Less surface, but every remaining knob actually does something.

### Migration

Settings keys reused with new wiring:
- `claude-code-cache-fix.skipSmooshSplit` — was preload-only, now flips the proxy `smoosh-split` extension.
- `claude-code-cache-fix.skipDeferredToolsRestore` — was preload-only, now sets the proxy env var.
- `claude-code-cache-fix.prefixDiff` — was preload-only, now sets the proxy env var.

Setting renamed:
- `claude-code-cache-fix.skipToolUseInputNormalize` → `claude-code-cache-fix.skipToolInputNormalize`. If you had the old key in your settings.json, copy the value to the new key — VS Code will mark the old one as "Unknown configuration setting".

Settings deleted (no replacement; were preload-only and have no proxy equivalent yet upstream):
- `skipRelocate`, `skipContinueTrailerStrip`, `skipReminderStrip`, `skipCacheControlSticky`
- `normalizeIdentity` (proxy has `identity-normalization` always on at order 300 — same effect, no toggle), `normalizeCwd`, `normalizeSmoosh`
- `imageKeepLast`, `outputEfficiencyReplacement`
- `stripGitStatus` — use the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` environment variable instead (same effect, works on Bun-binary CC).
- `debug` — was the preload-mode debug log toggle. The proxy has its own NDJSON telemetry at `~/.claude/cache-fix-proxy-log.ndjson` (`Open Proxy Request Log` command), always on.

### Compatibility

- Requires `claude-code-cache-fix@>=3.0.1` for proxy mode at minimum; `>=3.1.0` for the new default-on extensions and env-var-controlled features.
- `httpsProxy` / `noProxy` end-to-end honored only on `>=3.0.3`.
- VSIX no longer contains the Windows wrapper .exe — install size shrinks by ~30 MB.

## [0.6.1] — 2026-04-24

Settings UX overhaul — no behavior change. Every setting now has a real markdown description citing the upstream [extension-impact-guide](https://github.com/cnighswonger/claude-code-cache-fix/blob/main/docs/extension-impact-guide.md) (measured impact, when to disable, deep link to the guide's anchor for that fix). Settings are grouped into five labeled sections in the VS Code Settings UI so the 28 toggles don't flatten into one alphabetized wall.

### Changed
- `contributes.configuration` is now an array of five sections with `title` and `order`:
  1. **Activation** (4 settings) — `autoStartProxy`, `autoInstallInterceptor`, `debug`, `prefixDiff`.
  2. **Corporate environments (proxies, custom CAs)** (6 settings) — `httpsProxy`, `noProxy`, `caFile`, `rejectUnauthorized`, `autoExportCerts`, `certSearchPatterns`.
  3. **Proxy-mode fixes (CC v2.1.113+)** (5 settings) — `skipFingerprint`, `skipToolSort`, `skipSessionStartNormalize`, `skipCacheControlNormalize`, `skipTtl`.
  4. **Preload-mode fixes (CC ≤v2.1.112)** (10 settings) — `skipRelocate` and friends, plus `normalize*` opt-ins.
  5. **Prompt & image rewrites** (3 settings) — `imageKeepLast`, `stripGitStatus`, `outputEfficiencyReplacement`.
- Every `description` is now a `markdownDescription` with a four-part template: *what the fix does / effect when the setting is enabled / measured cost of skipping / deep link to the guide*. Real numbers where available (e.g. fingerprint: 81% of calls affected in a 536-call validation, cache hit rate 95-99% vs 60-80%).
- Preload-only settings carry a leading `> ⚠️ **Preload-mode only** — no effect on CC v2.1.113+` callout so users on recent CC don't chase settings that do nothing for them.
- `stripGitStatus` description now points users at the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` flag (same effect, no interceptor needed, works on Bun binary).
- Within each section, settings carry an `order` so layout is stable rather than alphabetized.

### Not changed
- Setting **keys** are unchanged (`skipFingerprint` stays `skipFingerprint`, etc.) — the polarity-confusion of "set true to disable the fix" is called out explicitly in each description. A proper rename (e.g. `fingerprintFixEnabled: true`) would require migration and is deferred to a future minor release.
- Runtime behavior is unchanged — `extension.js` is unchanged. Existing `settings.json` entries continue to work identically.

## [0.6.0] — 2026-04-23

Turns "install VSIX and follow a 3-step README" into "install VSIX, done." Fixes two high-severity bugs from 0.5.0 and adds corporate-environment support (proxy / custom CA / Windows cert auto-export). Self-heals across extension updates. Pairs with `claude-code-cache-fix@>=3.0.3` (whose upstream agent wiring landed via [cnighswonger/claude-code-cache-fix#54](https://github.com/cnighswonger/claude-code-cache-fix/pull/54)).

### Fixed

- **Proxy mode now actually engages.** `claudeCode.environmentVariables` is an array of `{name, value}` objects (as written by the Claude Code extension), but the original `enableProxy` wrote it as a flat map — `envVars.ANTHROPIC_BASE_URL = url` on an Array silently drops the property at `JSON.stringify` time. `Enable Proxy Mode` reported success while settings.json never received `ANTHROPIC_BASE_URL`; subsequent Claude Code traffic bypassed the proxy. `enableProxy`, `disableProxy`, and `isProxyEnabled` now read/write the correct array shape, preserving pre-existing `CACHE_FIX_*` entries.
- **`claudeCode.claudeProcessWrapper` no longer rots on every extension update.** Previously the setting was written with `context.extensionPath`, which lives inside the versioned extension folder (`vsitsllc.claude-code-cache-fix-<VERSION>\…`). Every version bump renamed the folder and produced `ReferenceError: Claude Code native binary not found at …vsitsllc.claude-code-cache-fix-0.5.0\ClaudeCodeCacheFixWrapper.exe` on the next Claude Code launch. The `.exe` is now mirrored to a stable per-user location (`~/.claude/cache-fix-bin/`), and a reconcile step on every activate rewrites stale paths or clears them if proxy mode supersedes. Only touches the setting if it's clearly ours (pattern-matched against our extension folder or stable dir) — never modifies third-party wrappers.

### Added — zero-touch activation

- **`autoStartProxy` setting (default `true`).** On activate, the extension silently sets `ANTHROPIC_BASE_URL` in global settings (if not already overridden to a non-proxy URL) and spawns the proxy server itself. No command-palette step, no "Copy Start Command" terminal paste.
- **Managed proxy server lifecycle.** Spawned via `child_process.spawn(process.execPath, [server.mjs], { windowsHide: true })`. Stdout/stderr pipe to a new output channel `Claude Code Cache Fix — Proxy`. A `GET /health` probe runs first so existing proxies (external or from other windows) are reused rather than duplicated. The child is killed on `deactivate` so closing VS Code stops the proxy too.
- **`autoInstallInterceptor` setting (default `true`).** If the `claude-code-cache-fix` npm package is missing on activate, the extension installs it using whichever package manager owns the user's Node toolchain: `volta install` when `npm` resolves to a Volta shim (`/[\\/]volta[\\/]/i.test(npmPath)`), otherwise `npm install -g`. Progress surfaced via `vscode.window.withProgress`.
- **Volta-aware interceptor lookup.** `npm root -g` doesn't see `volta install`'d packages (Volta keeps them in its own `tools/image/packages/` tree). New `getInterceptorDir()` checks the npm root first, then `<VOLTA_HOME>/tools/image/packages/claude-code-cache-fix/node_modules/claude-code-cache-fix`, then the shared shim location. `VOLTA_HOME` defaults to `%LOCALAPPDATA%\Volta` on Windows and `~/.volta` elsewhere. All downstream helpers (`isInterceptorInstalled`, `getWrapperPath`, `getProxyServerPath`, patch helpers) go through this resolver.

### Added — corporate environments (Zscaler / Netskope / Forcepoint / Bluecoat / custom CA)

- **6 new settings** under `claude-code-cache-fix.*`: `httpsProxy`, `noProxy`, `caFile`, `rejectUnauthorized`, `autoExportCerts`, `certSearchPatterns`.
- **Configuration is resolved at proxy-spawn time and injected into the child's environment** as `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `CACHE_FIX_PROXY_CA_FILE`, `NODE_EXTRA_CA_CERTS`, and (only when explicitly opted in) `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` / `NODE_TLS_REJECT_UNAUTHORIZED=0`. The proxy server itself honors these as of `claude-code-cache-fix@3.0.3+`.
- **`Claude Code Cache Fix: Export Windows Corporate Certificates` command** — runs PowerShell against `Cert:\LocalMachine\Root|CA` and `Cert:\CurrentUser\Root|CA`, matching subject patterns from `certSearchPatterns` (defaults: `*Zscaler*`, `*Netskope*`, `*Forcepoint*`). Writes a PEM bundle to `~/.claude/cache-fix-corp-ca-bundle.pem`. On success, offers to wire it as the `caFile` setting. Idempotent — re-runs pick up cert rotations.
- **`maybeAutoExportCerts()` runs in `activate()`** (when `autoExportCerts: true`) before the proxy spawn, so the bundle path lands in the spawn env on first start without a manual command invocation.
- **`Claude Code Cache Fix: Test Connection to Anthropic API` command** — performs a real round-trip to `api.anthropic.com` using the configured agent + caFile (`hpagent` loaded from the cache-fix `node_modules` when present). Distinguishes TLS chain failures from network/proxy failures in the error message.
- **`Show Status` extended** — adds Corp HTTP proxy, `NO_PROXY`, CA file (with existence check), and TLS-verify state.
- **Live setting changes trigger proxy restart.** `onDidChangeConfiguration` watches the 6 corp-env keys; when any changes and a managed proxy is running, the extension re-exports certs (if enabled) and restarts the child so the new env takes effect without a VS Code restart.

### Added — telemetry

- **Proxy request log (NDJSON).** On activate the extension writes a per-user override at `~/.claude/cache-fix-proxy-extensions.json` that mirrors the upstream defaults but flips `request-log` to `enabled: true`, and spawns the proxy with `CACHE_FIX_REQUEST_LOG=~/.claude/cache-fix-proxy-log.ndjson` and `CACHE_FIX_EXTENSIONS_CONFIG=<override path>`. One JSON line per `/v1/messages` (timestamp, model, latency, tokens, `cacheRead`, `cacheCreation`). Usable as a cache-hit-rate signal: `cacheRead / (cacheRead + cacheCreation)`.
- **New command `Claude Code Cache Fix: Open Proxy Request Log`** opens the NDJSON file in the editor.

### Added — defensive self-patch for older `claude-code-cache-fix`

- `patchPipelineMjsIfNeeded()` — on Windows, rewrites `import(join(dir, file))` → `import(pathToFileURL(join(dir, file)).href)` in the npm package's `proxy/pipeline.mjs` when the buggy form is detected. Fixes the `Received protocol 'c:'` pipeline load failure that silently degraded the proxy to a passthrough with zero cache fixes on `claude-code-cache-fix@3.0.1`. Idempotent (marker check), no-op on `@>=3.0.2` (where the upstream fix shipped, merging [#52](https://github.com/cnighswonger/claude-code-cache-fix/issues/52)). Restarts the proxy when patching a running instance.

### Changed

- **Preload wrapper auto-enable is now conditional on `autoStartProxy: false`.** Previously `activate()` would unconditionally configure preload wrappers if none was set. On CC v2.1.113+ (Bun binary) preload mode is a no-op, so preload auto-enable only runs when the user has explicitly opted out of proxy auto-start.
- **`.vscodeignore` tightened** to exclude the fork's working docs and reference directories from the published VSIX (CHANGELOG is still published; the rest are excluded). Final VSIX is 9 files, ~29.1 MB.

### Compatibility

- Requires `claude-code-cache-fix@>=3.0.1` for proxy mode. `httpsProxy` / `noProxy` settings are honored end-to-end only against `@>=3.0.3`; on older versions the env vars are still passed, but the proxy server ignores them (stderr will be silent instead of showing `[upstream] using proxy ...`).
- Tested on Windows 11 + Volta-managed Node 22.22.0 and Windows Server 2025 + plain npm. Code Insiders, stable VS Code, and Cursor all resolve the extension correctly.

## [0.5.0] — 2026-04-22

Upstream baseline; see the [release notes](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/tag/v0.5.0) for the original feature set (proxy mode + preload mode).
