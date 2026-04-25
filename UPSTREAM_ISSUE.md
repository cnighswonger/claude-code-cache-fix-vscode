## Bug

On Windows, **none of the proxy pipeline extensions load**, so the proxy degrades to a passthrough with zero cache fixes applied. Affects v3.0.x.

`proxy/pipeline.mjs` line 19:

```js
const mod = await import(join(dir, file) + "?t=" + Date.now());
```

`join(dir, file)` returns a raw Windows path like `C:\Users\...\proxy\extensions\fingerprint-strip.mjs`. Node's dynamic `import()` rejects that:

```
[pipeline] failed to load fingerprint-strip.mjs: Only URLs with a scheme in: file, data, node, and electron are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'
[pipeline] failed to load cache-control-normalize.mjs: ... Received protocol 'c:'
[pipeline] failed to load cache-telemetry.mjs: ... Received protocol 'c:'
[pipeline] failed to load fresh-session-sort.mjs: ... Received protocol 'c:'
[pipeline] failed to load identity-normalization.mjs: ... Received protocol 'c:'
[pipeline] failed to load request-log.mjs: ... Received protocol 'c:'
[pipeline] failed to load sort-stabilization.mjs: ... Received protocol 'c:'
[pipeline] failed to load ttl-management.mjs: ... Received protocol 'c:'
proxy listening on 127.0.0.1:9801
```

The proxy starts and answers `/health` 200, so it looks healthy, but every request flows through unchanged. `cache-fix-stats.json` (preload mode) shows fixes happening; the proxy's pipeline never runs.

## Repro

- Windows 10, 11, or Server 2025
- Any Node 18+ (tested on Volta-managed 22.22.0 and stock npm)
- `npm install -g claude-code-cache-fix@latest`
- `node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs"` (or trigger via the VS Code extension)
- Stderr immediately prints the eight load failures shown above.

## Fix (one-line)

Wrap with `pathToFileURL`:

```diff
 import { readdir, readFile } from "node:fs/promises";
 import { join } from "node:path";
+import { pathToFileURL } from "node:url";
 ...
-      const mod = await import(join(dir, file) + "?t=" + Date.now());
+      const mod = await import(pathToFileURL(join(dir, file)).href + "?t=" + Date.now());
```

The `?t=` cache-busting suffix still works — `pathToFileURL` returns a `URL` object whose `.href` is a valid string for `import()`, and the query string survives the wrapping.

## Verification after the fix

Re-run `node proxy/server.mjs`. Stderr should be empty. Make any request and check `~/.claude/cache-fix-proxy-log.ndjson` (when `CACHE_FIX_REQUEST_LOG` is set) — `cacheRead` should track upstream cache reuse, and pipeline extensions like `cache-control-normalize` and `ttl-management` will start mutating requests.

## Cross-reference

The VS Code extension repo issue cnighswonger/claude-code-cache-fix-vscode#8 mentions this bug and now ships an in-extension self-patch that rewrites the user's installed `pipeline.mjs` on activate (idempotent, string-replace, restores after `npm install -g claude-code-cache-fix@latest`). That keeps Windows users working until this lands upstream — but it's a workaround, not a fix. Hoping you'll merge the one-liner here so the workaround can go away.

I'd open a PR but prefer not to publish a fork from this account; happy to attach the patch as a file or paste it again with surrounding context if useful.
