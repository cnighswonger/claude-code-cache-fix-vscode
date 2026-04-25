## What's New

**Zero-touch activation** — install the VSIX, restart VS Code, done. No command-palette steps, no `node server.mjs &` in a terminal, no "copy this command and paste it" popups. The extension auto-installs the `claude-code-cache-fix` npm package (via `volta install` on Volta-managed systems, else `npm install -g`), self-spawns the proxy server as a managed child, wires `ANTHROPIC_BASE_URL` into the right settings shape, and cleans up on VS Code close.

**Corporate environment support** — works behind Zscaler / Netskope / Forcepoint / Bluecoat / custom-CA SSL inspection out of the box. Six new settings cover HTTP proxy URL, `NO_PROXY`, CA file path, TLS-verify toggle, and (Windows only) auto-export from the certificate store. Two new commands: *Export Windows Corporate Certificates* and *Test Connection to Anthropic API*.

**Two high-severity fixes from v0.5.0:**
- Proxy mode never actually engaged — `claudeCode.environmentVariables` is an array of `{name, value}` objects, but `enableProxy` wrote it as a flat map, so `ANTHROPIC_BASE_URL` was silently dropped at JSON serialization time. Now writes the correct shape while preserving existing `CACHE_FIX_*` entries.
- `claudeCode.claudeProcessWrapper` rotted on every extension update (pointed at the versioned extension folder). Now mirrors the bundled `.exe` to a stable per-user location and self-heals stale paths on every activate.

**Volta-aware interceptor lookup** — `npm root -g` doesn't see `volta install`'d packages. The extension now also checks `<VOLTA_HOME>/tools/image/packages/...` and `tools/shared/`.

**NDJSON request log** — `~/.claude/cache-fix-proxy-log.ndjson` gets one line per `/v1/messages` with timestamp, model, latency, tokens, cache-read, cache-create. New command: *Open Proxy Request Log*. Doubles as a real cache-hit-rate signal: `cacheRead / (cacheRead + cacheCreation)`.

### New settings

| Setting | Default | Purpose |
|---|---|---|
| `autoStartProxy` | `true` | Silently start proxy mode on activate |
| `autoInstallInterceptor` | `true` | Install the npm package if missing (volta/npm) |
| `httpsProxy` | `""` | Corporate HTTP(S) proxy URL |
| `noProxy` | `localhost,127.0.0.1,::1,.local` | Hosts to bypass the proxy |
| `caFile` | `""` | Path to PEM bundle with extra CA certificates |
| `rejectUnauthorized` | `true` | TLS verification (warns loudly when disabled) |
| `autoExportCerts` | `false` | (Windows) Auto-export from cert store |
| `certSearchPatterns` | `["*Zscaler*", "*Netskope*", "*Forcepoint*"]` | Subject patterns to match |

### Compatibility

- Requires `claude-code-cache-fix@>=3.0.1` for proxy mode. The `httpsProxy` setting is end-to-end only on `@>=3.0.3`, where the upstream agent wiring lives (merged via [cnighswonger/claude-code-cache-fix#54](https://github.com/cnighswonger/claude-code-cache-fix/pull/54)); on older versions the env vars still propagate but the proxy server ignores them.
- **No regression** for users without corp-env settings — with no env vars set, proxy behavior is identical to prior versions (default Node agent, system trust store).
- Tested on Windows 11 + Volta-managed Node 22.22.0 and Windows Server 2025 + plain npm. Code Insiders, stable VS Code, and Cursor all resolve the extension correctly.

### Install

```
code --install-extension claude-code-cache-fix-0.6.0.vsix
```

Or download the `.vsix` below and use **Extensions → ⋯ → Install from VSIX…**

### Credits

Upstream proxy agent wiring (the piece that makes `httpsProxy` actually work end-to-end) landed in `claude-code-cache-fix@3.0.3` via [#54](https://github.com/cnighswonger/claude-code-cache-fix/pull/54) — thanks @cnighswonger for the review and merge. The Windows pipeline-path fix in `@3.0.2` also traces back to the same audit pass ([#52](https://github.com/cnighswonger/claude-code-cache-fix/issues/52)).

Full details in [CHANGELOG.md](https://github.com/cnighswonger/claude-code-cache-fix-vscode/blob/main/CHANGELOG.md).
