## What's New

**Settings UX overhaul.** Every one of the 28 settings now has a real markdown description citing the upstream [extension-impact-guide](https://github.com/cnighswonger/claude-code-cache-fix/blob/main/docs/extension-impact-guide.md) — what the fix does, effect when toggled, measured cost of skipping, deep link to the guide's anchor.

Settings are grouped into five labeled sections in the VS Code Settings UI so the 28 toggles don't flatten into one alphabetized wall:

1. **Activation** — `autoStartProxy`, `autoInstallInterceptor`, `debug`, `prefixDiff`
2. **Corporate environments** — `httpsProxy`, `noProxy`, `caFile`, `rejectUnauthorized`, `autoExportCerts`, `certSearchPatterns`
3. **Proxy-mode fixes (CC v2.1.113+)** — `skipFingerprint`, `skipToolSort`, `skipSessionStartNormalize`, `skipCacheControlNormalize`, `skipTtl`
4. **Preload-mode fixes (CC ≤v2.1.112)** — `skipRelocate` and friends, plus `normalize*` opt-ins
5. **Prompt & image rewrites** — `imageKeepLast`, `stripGitStatus`, `outputEfficiencyReplacement`

Preload-only settings carry a leading `> ⚠️ **Preload-mode only** — no effect on CC v2.1.113+` callout so users on recent CC don't chase settings that do nothing for them.

`stripGitStatus` description now points users at the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` flag (same effect, no interceptor, works on Bun-binary CC too).

## Before vs after (example: `skipFingerprint`)

**Before v0.6.1:**
> Disable the fingerprint stabilization fix

**After v0.6.1:**
> **Fix:** Strips the unstable `cc_version` fingerprint from the system prompt before forwarding…
>
> **Cost of skipping:** In a validated 7.5-hour Windows session (536 calls), 81% of calls had fingerprint instability — each one a full cache miss (~6-30K tokens of `cache_creation`). Cache hit rate drops from 95-99% to 60-80% on resume sessions.
>
> See [impact guide](https://github.com/cnighswonger/claude-code-cache-fix/blob/main/docs/extension-impact-guide.md#1-fingerprint-strip-order-100).

All 28 settings got similar treatment, with real numbers pulled from the impact guide where the guide provides them.

## What didn't change

- **Setting keys are unchanged** — `skipFingerprint` stays `skipFingerprint`, all existing `settings.json` entries work identically.
- **No runtime behavior change** — `extension.js` is untouched. Purely a description/grouping overhaul.
- **No compatibility change** — same pairing as v0.6.0: works with `claude-code-cache-fix@>=3.0.1`; `httpsProxy` end-to-end requires `@>=3.0.3`.

## Install

```
code --install-extension https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/download/v0.6.1/claude-code-cache-fix-0.6.1.vsix
```

Or download the VSIX below and use **Extensions → ⋯ → Install from VSIX…**

Full list of per-setting diffs in [CHANGELOG.md](https://github.com/cnighswonger/claude-code-cache-fix-vscode/blob/main/CHANGELOG.md#061--2026-04-24).
