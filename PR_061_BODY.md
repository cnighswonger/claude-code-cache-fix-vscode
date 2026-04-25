Settings UX overhaul. No behavior change — pure patch release.

## What

Every one of the 28 settings now has a real `markdownDescription` citing the upstream [extension-impact-guide](https://github.com/cnighswonger/claude-code-cache-fix/blob/main/docs/extension-impact-guide.md): *what the fix does*, *effect when the setting is enabled* (i.e. when the fix is skipped), *measured cost of skipping* with real numbers where the guide provides them, *deep link to the guide's anchor*.

Settings are grouped into five labeled sections via `contributes.configuration` as an array of `{title, order, properties}`:

1. **Activation** (4 settings)
2. **Corporate environments (proxies, custom CAs)** (6 settings)
3. **Proxy-mode fixes (CC v2.1.113+)** (5 settings)
4. **Preload-mode fixes (CC ≤v2.1.112)** (10 settings)
5. **Prompt & image rewrites** (3 settings)

Preload-only settings carry a leading `> ⚠️ **Preload-mode only** — no effect on CC v2.1.113+` callout so users on recent CC don't chase settings that do nothing for them. `stripGitStatus` description points users at the native `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` flag (same effect, no interceptor, works on Bun).

Within each section, every property has an `order` so layout is stable rather than alphabetized.

## What doesn't change

- Setting **keys** are unchanged (`skipFingerprint` stays `skipFingerprint`). The polarity-confusion of "set true to disable the fix" is called out in every description. A proper inversion (e.g. `fingerprintFixEnabled: true`) would require a settings migration and is deferred to a future minor release.
- `extension.js` is unchanged.
- Runtime behavior is unchanged. Existing `settings.json` entries work identically.

## Why this is worth shipping

The v0.5.x/v0.6.0 descriptions were one-line imperatives like *"Disable the fingerprint stabilization fix"* — technically correct, but silent about the measured ~35-point cache-hit-rate delta that skipping the fix produces on resume sessions. Users toggling these settings couldn't know the stakes. Now each description puts the numbers from the guide in front of them.

## Example — `skipFingerprint`

Before:
> Disable the fingerprint stabilization fix

After (rendered from markdown):
> **Fix:** Strips the unstable `cc_version` fingerprint (e.g. `2.1.92.a3f`) from the system prompt before forwarding. Claude Code computes this fingerprint from `messages[0]` content including meta/attachment blocks — when blocks shift position on resume, the fingerprint changes, the system prompt changes, and the entire prefix cache busts.
>
> **When this setting is `true`, the fix is skipped.**
>
> **Cost of skipping:** In a validated 7.5-hour Windows session (536 calls), 81% of calls had fingerprint instability — each one a full cache miss (~6-30K tokens of `cache_creation` instead of `cache_read`). Cache hit rate drops from 95-99% to 60-80% on resume sessions.
>
> **When to enable (`true`):** only if upstream CC ships a fingerprint-computation fix and the health status shows `dormant` across multiple sessions.
>
> Applies to both proxy-mode (pipeline extension `fingerprint-strip`, order 100) and preload-mode. See [impact guide](https://github.com/cnighswonger/claude-code-cache-fix/blob/main/docs/extension-impact-guide.md#1-fingerprint-strip-order-100).

## Testing

- `node --check extension.js` — clean
- `JSON.parse(package.json)` — valid
- `vsce package` → `claude-code-cache-fix-0.6.1.vsix` (11 files, 29.11 MB) built cleanly
- `code-insiders --install-extension` — succeeded
- Opened the extension's Settings page and walked through all 28 settings: each renders its markdown description correctly, sections appear in the declared order, preload-only callouts are visible.

## Scope

2 files changed, +223 / −148.
