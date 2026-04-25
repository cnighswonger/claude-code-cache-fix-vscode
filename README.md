# Claude Code Cache Fix — VS Code Extension

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![GitHub release](https://img.shields.io/github/v/release/cnighswonger/claude-code-cache-fix-vscode)](https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest)

Zero-touch activation of [`claude-code-cache-fix`](https://github.com/cnighswonger/claude-code-cache-fix) — a local proxy that sits in front of Claude Code and rewrites requests for cache stability. Tracks upstream **v3.1.0**.

## What it does

On activate, the extension:

1. Installs `claude-code-cache-fix` (via Volta or npm, whichever owns your Node toolchain) if missing.
2. Starts the local proxy on `http://127.0.0.1:9801` as a managed child process.
3. Sets `claudeCode.environmentVariables.ANTHROPIC_BASE_URL` so the VS Code Claude Code extension routes through the proxy.

You then use Claude Code normally. The proxy applies the v3.1.0 pipeline extensions (fingerprint stabilization, tool sort, fresh-session sort, identity normalization, smoosh-split, content-strip, tool-input-normalize, cache-control-normalize, TTL management, deferred-tools-restore) before forwarding to `api.anthropic.com`. In published A/B tests this raised cache hit rate from 5.9% → 99.9% in a couple of calls.

## Prerequisites

Volta or npm on PATH. Everything else (`claude-code-cache-fix`, the proxy, the override config) is installed and configured automatically on first activate.

## Settings

17 settings, grouped into 3 sections in VS Code Settings UI. Most users never touch them.

- **Activation** — `autoStartProxy`, `autoInstallInterceptor`, `prefixDiff` (diagnostic snapshot).
- **Corporate environments** — `httpsProxy`, `noProxy`, `caFile`, `rejectUnauthorized`, `autoExportCerts`, `certSearchPatterns`. On Windows, `autoExportCerts` pulls Zscaler / Netskope / Forcepoint roots from the cert store automatically.
- **Pipeline extensions** — eight `skip*` toggles, one per pipeline extension. Default off (= fix is on). Flip to `true` only if you're A/B testing or have a known incompatibility. Each has measured cost data in its description.

## Commands

- **Show Status** — installed package, proxy listening, mode, corp env summary.
- **Enable Proxy Mode** / **Disable Proxy Mode** — manual override of the auto-start.
- **Open Proxy Request Log** — opens `~/.claude/cache-fix-proxy-log.ndjson`. One JSON line per `/v1/messages`; useful for cache-hit-rate analysis (`cacheRead / (cacheRead + cacheCreation)`).
- **Test Connection to Anthropic API** — runs a real round-trip with your configured proxy + CA so you know the corp egress works before driving traffic through it.
- **Export Windows Corporate Certificates** — Windows: dumps matching certs from the Windows trust store to a PEM bundle, optionally wires it as `caFile`.

## v0.7.0 changes vs. v0.6.x

- **Wrapper / preload mode is gone.** Doesn't work on the Bun-binary Claude Code (v2.1.113+) anyway. VSIX shrank from ~30 MB to ~30 KB.
- **Settings now actually wire to the proxy.** In 0.6.x the `skip*` toggles only updated the (now-deleted) preload wrapper config — they had no effect on proxy traffic. In 0.7.0 each toggle flips the corresponding extension in the proxy override file at `~/.claude/cache-fix-proxy-extensions.json` and restarts the running proxy.
- **Tracks upstream v3.1.0:** new default-on extensions (`smoosh-split`, `content-strip`, `tool-input-normalize`, `deferred-tools-restore`) and the diagnostic `prefix-diff`.

See [CHANGELOG.md](https://github.com/cnighswonger/claude-code-cache-fix-vscode/blob/main/CHANGELOG.md) for the full migration guide.

## Related

- [claude-code-cache-fix](https://github.com/cnighswonger/claude-code-cache-fix) — the upstream npm package this extension manages.
- [Extension impact guide](https://github.com/cnighswonger/claude-code-cache-fix/blob/main/docs/extension-impact-guide.md) — measured cost of disabling each fix.
- [Blog series](https://veritassuperaitsolutions.com/three-layer-gate-quota-overage/) — the original technical analysis.

## License

MIT — [Veritas Supera IT Solutions LLC](https://veritassuperaitsolutions.com)
