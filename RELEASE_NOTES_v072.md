## Real fix for the stale-`ANTHROPIC_BASE_URL` bug

v0.7.1's attempt to clean up `claudeCode.environmentVariables` in `deactivate()` didn't work — VS Code unloads the extension before the async settings write commits, and the entry stayed in `settings.json`. **v0.7.2 stops writing to `settings.json` entirely.**

## The new approach: `process.env`

All VS Code extensions in a window share a single Node.js extension host process — and therefore one `process.env`. Claude Code's spawn explicitly merges `process.env` with the user setting when launching `claude` (verified in `anthropic.claude-code` 2.1.120):

```js
function OV(V) {
  let K = _14(e6("environmentVariables")),
      B = { ...process.env };               // ← inherits parent env
  if (V) B.PATH = V;
  B.MCP_CONNECTION_NONBLOCKING = "true";
  for (let x of K) if (x.name) B[x.name] = x.value || "";
  return B.CLAUDE_CODE_ENTRYPOINT = "claude-vscode", B;
}
```

So we just set `process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9801'` in our `activate()`. Claude Code's subprocess inherits it. Nothing persists to disk.

## Why this is reliable

`process.env` is in-memory state of the extension host. Modification is **synchronous**. `deactivate()` does a synchronous `delete process.env.ANTHROPIC_BASE_URL` (or restores the prior value if there was one) before VS Code unloads us. No async race with the settings service. No stale `settings.json` entry possible.

When VS Code restarts with our extension uninstalled: extension host starts fresh, nothing for Claude Code to inherit, traffic goes direct to `api.anthropic.com`. Clean.

## Automatic migration

If you have a stale `ANTHROPIC_BASE_URL` entry left behind by 0.6.x / 0.7.0 / 0.7.1: install v0.7.2 and the entry is removed automatically on activate (`cleanupLegacyEnvSetting`). Conservative — only removes entries whose value contains `127.0.0.1`. User-set values (corp proxy, AWS Bedrock router) are left alone.

## Preserves your existing `ANTHROPIC_BASE_URL`

If you have `ANTHROPIC_BASE_URL` set to a non-proxy URL in your shell (or another tool sets it), we save the prior value before overriding and restore it on deactivate. `Enable Proxy Mode` prompts before replacing an explicit non-proxy value.

## Install

```
code --install-extension claude-code-cache-fix-0.7.2.vsix
```

If you were stuck with the 0.7.1 bug, just install v0.7.2 — no manual cleanup needed.

## Verify

After install, open user `settings.json`. The `ANTHROPIC_BASE_URL` entry should be **gone** from `claudeCode.environmentVariables`. The proxy should still be live (`Show Status` → "Proxy listening: Yes"), and the proxy log at `~/.claude/cache-fix-proxy-log.ndjson` should still receive entries on each Claude Code call.
