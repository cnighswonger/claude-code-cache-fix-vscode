## Summary

v0.6.0: zero-touch activation + corporate-environment support + two high-severity bug fixes. Pairs with `claude-code-cache-fix@>=3.0.3` (the upstream agent wiring you merged via [#54](https://github.com/cnighswonger/claude-code-cache-fix/pull/54)).

Full breakdown is in the new `CHANGELOG.md` — below is the short version for the PR context. Closes out the four issues raised in #8 and adds corp-env support that the prior PR framing deferred.

## Bugs fixed

### 1. Proxy mode never actually engaged (high)

**Symptom:** `Enable Proxy Mode` reported success, but `ANTHROPIC_BASE_URL` was never in `settings.json`. Claude Code traffic bypassed the proxy.

**Root cause:** `claudeCode.environmentVariables` is an array of `{name, value}` (as confirmed by inspecting real settings.json where the Claude Code extension itself had populated `CACHE_FIX_*` entries in that shape). The original `enableProxy` did `envVars.ANTHROPIC_BASE_URL = url` — but `envVars` is an `Array`, not a plain object, so that sets a named property that `JSON.stringify` silently drops when VS Code persists the setting.

**Fix:** `enableProxy`, `disableProxy`, and `isProxyEnabled` now read/write the array shape correctly while preserving existing entries.

### 2. `claudeCode.claudeProcessWrapper` rotted on every extension update (high)

**Symptom:** `ReferenceError: Claude Code native binary not found at c:\Users\…\extensions\vsitsllc.claude-code-cache-fix-0.5.0\ClaudeCodeCacheFixWrapper.exe` on the next Claude Code launch after every `--install-extension --force`.

**Root cause:** The setting was written with `context.extensionPath`, which lives inside the **versioned** extension folder. Every version bump renamed the folder and left the saved setting pointing at a non-existent path.

**Fix:** on activate, mirror the bundled `.exe` into a stable per-user location (`~/.claude/cache-fix-bin/ClaudeCodeCacheFixWrapper.exe`, idempotent via size + mtime check), then `reconcileWrapperSetting()` rewrites stale paths or clears them if proxy mode is taking over. Only touches the setting when it matches a pattern we own (`*\extensions\vsitsllc.claude-code-cache-fix-*` or our stable dir) — never modifies third-party wrappers.

## Zero-touch activation

- New `claude-code-cache-fix.autoStartProxy` (default `true`). On activate: silently sets `ANTHROPIC_BASE_URL` in global `claudeCode.environmentVariables` (array shape), spawns the proxy server itself.
- Managed proxy via `child_process.spawn(process.execPath, [server.mjs], { windowsHide: true })`. Stdout/stderr pipe to a new output channel. `GET /health` probe to avoid duplicate spawns when multiple windows or external launches are running. Child killed in `deactivate()`.
- New `claude-code-cache-fix.autoInstallInterceptor` (default `true`). When the npm package is missing on activate, installs it with whichever package manager owns the user's Node toolchain — `volta install` when `npm` resolves to a Volta shim (`/[\\/]volta[\\/]/i.test(npmPath)`), else `npm install -g`. Progress shown via `vscode.window.withProgress`.
- **Volta-aware interceptor lookup** — `getInterceptorDir()` checks `<npm root -g>/claude-code-cache-fix` first, then `<VOLTA_HOME>/tools/image/packages/claude-code-cache-fix/node_modules/claude-code-cache-fix`, then `<VOLTA_HOME>/tools/shared/claude-code-cache-fix`. Required because `volta install` doesn't populate the image's node_modules — the old `npm root -g`-only lookup missed volta-installed packages.

End-to-end on a fresh VM: install VSIX → restart VS Code → done. No shell commands, no command-palette steps.

## Corporate environments (Zscaler / Netskope / Forcepoint / Bluecoat / custom CA)

Six new settings. Resolved at proxy-spawn time and injected into the child's env as `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `CACHE_FIX_PROXY_CA_FILE`, `NODE_EXTRA_CA_CERTS`, and (only when explicitly opted in) `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` / `NODE_TLS_REJECT_UNAUTHORIZED=0`.

| Setting | Default | Purpose |
|---|---|---|
| `httpsProxy` | `""` | Corporate HTTP(S) proxy URL |
| `noProxy` | `localhost,127.0.0.1,::1,.local` | Hosts to bypass the proxy |
| `caFile` | `""` | Path to a PEM file with extra CA certificates |
| `rejectUnauthorized` | `true` | Verify TLS certificates (warn loudly when disabled) |
| `autoExportCerts` | `false` | (Windows) Auto-export certs from the Windows cert store |
| `certSearchPatterns` | `["*Zscaler*", "*Netskope*", "*Forcepoint*"]` | Subject patterns for auto-export |

Two new commands:
- **Claude Code Cache Fix: Export Windows Corporate Certificates** — runs PowerShell across `Cert:\LocalMachine\Root|CA` + `Cert:\CurrentUser\Root|CA`, writes PEM bundle to `~/.claude/cache-fix-corp-ca-bundle.pem`. Offers to wire it as `caFile` on success.
- **Claude Code Cache Fix: Test Connection to Anthropic API** — real round-trip with the configured agent + caFile. Distinguishes TLS chain failures from network/proxy failures in the error message.

Live setting changes (`onDidChangeConfiguration` on the 6 keys) automatically re-export certs and restart the proxy child so updates take effect without a VS Code restart.

## Telemetry

- NDJSON request log at `~/.claude/cache-fix-proxy-log.ndjson` via a per-user override of `proxy/extensions.json` that flips `request-log` on. Proxy spawn env includes `CACHE_FIX_REQUEST_LOG=<path>` and `CACHE_FIX_EXTENSIONS_CONFIG=<override path>`.
- One JSON line per `/v1/messages` (timestamp, model, latency, tokens, `cacheRead`, `cacheCreation`). Usable as a cache-hit-rate signal: `cacheRead / (cacheRead + cacheCreation)`.
- New command **Claude Code Cache Fix: Open Proxy Request Log**.

## Defensive self-patch for `claude-code-cache-fix@3.0.1`

`patchPipelineMjsIfNeeded()` rewrites `import(join(dir, file))` → `import(pathToFileURL(join(dir, file)).href)` in `proxy/pipeline.mjs` when the buggy form is detected on Windows. Fixes the `Received protocol 'c:'` pipeline load failure that silently degraded the proxy to a passthrough with zero cache fixes applied. Idempotent (marker check). **No-op on `@>=3.0.2`** — your upstream fix from [#52](https://github.com/cnighswonger/claude-code-cache-fix/issues/52) supersedes it, but the self-patch stays in place for users still on `3.0.1`.

## `Show Status` extended

Adds four lines: corp HTTP proxy, `NO_PROXY`, CA file (with existence check), TLS-verify state.

## Compatibility and testing

- Works with `claude-code-cache-fix@>=3.0.1` for proxy mode. `httpsProxy` end-to-end requires `@>=3.0.3` (where the agent wiring landed); on older versions the env vars still propagate but the proxy server ignores them. Stderr is the tell-tale — the proxy prints `[upstream] using proxy http://... for https upstream ...` on first forwarded request when the agent is active.
- **No regression** for users without corp-env settings — when no env vars are set, proxy behavior is identical to prior versions (default Node agent, system trust store).
- Tested on:
  - Windows 11 + Volta-managed Node 22.22.0 (Code Insiders) — end-to-end verified: proxy listening on 9801, request log accumulating real `cacheRead`/`cacheCreation` numbers (e.g. `243795 / (243795 + 61) = 99.97%` cache reuse between two consecutive prompts), `[upstream] using proxy ...` line appears when `httpsProxy` is set.
  - Windows Server 2025 + plain npm (reported by a tester hitting the Volta-lookup gap that motivated 0.5.9's `getInterceptorDir`).

## Scope note

This is a fairly large change (+954 / −63 in `extension.js`, plus `package.json` settings/commands and a small `.vscodeignore` tightening). Happy to split into separate PRs if you'd prefer — obvious seams:

1. Two bug fixes (array shape + wrapper path rot) — small, safe, independent.
2. Auto-start + auto-install + Volta lookup — one cohesive "zero-touch activation" bucket.
3. Corp-env support (6 settings + 2 commands + cert export) — one cohesive "corporate environments" bucket.
4. NDJSON telemetry + pipeline self-patch — small, optional.

Let me know if any of the above needs reshaping.
