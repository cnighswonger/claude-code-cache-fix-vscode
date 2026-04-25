## Bugfix release

Fixes a latent bug present since 0.6.0. **Recommended for everyone on 0.6.x or 0.7.0.**

## What was broken

When you disabled or uninstalled the extension, the proxy child process stopped — but the `ANTHROPIC_BASE_URL=http://127.0.0.1:9801` entry the extension had written into your `claudeCode.environmentVariables` setting **persisted in `settings.json`**. Claude Code in VS Code would then try to connect to a dead `127.0.0.1:9801` on every request and fail with:

```
[ERROR] API error (attempt 1/11): undefined Connection error.
```

Terminal `claude` was unaffected — it doesn't read the VS-Code-only `claudeCode.environmentVariables` setting.

## What's fixed

`deactivate()` now removes the `ANTHROPIC_BASE_URL` entry it wrote on activate. The cleanup is conservative — only entries whose value contains `127.0.0.1` are removed, so user-set values (corp proxy, mitmproxy, custom upstream) are left alone.

## Tradeoff

`deactivate()` also fires on VS Code window close, so the setting will be removed on shutdown and re-added on next activate. Minor `settings.json` churn — one entry toggling on/off per VS Code lifecycle. This is the price for not silently breaking on uninstall.

## If you're already broken

Either:
1. Install v0.7.1 and let the next disable/enable cycle clean it up.
2. Or manually edit `settings.json` (Cmd/Ctrl+Shift+P → "Preferences: Open User Settings (JSON)") and remove the `ANTHROPIC_BASE_URL` entry from `claudeCode.environmentVariables`.

## Install

```
code --install-extension claude-code-cache-fix-0.7.1.vsix
```
