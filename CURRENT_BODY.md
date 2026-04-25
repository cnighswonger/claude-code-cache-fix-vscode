## Summary

Tested v0.5.0 (and the proxy-mode flow added in v0.5.0/0.5.1 release notes) on Windows 11 + VS Code Insiders + Volta-managed Node 22.22.0 + claude-code-cache-fix npm 3.0.1. Found four issues that combine into a fairly broken first-run experience for proxy mode (Bugs 1+2 are correctness; Bugs 3+4 are UX gaps that together make a fresh install actually fresh-install). Patch at the bottom — feel free to take any subset.

**Edit:** added Bug 4 (auto-install of the npm package) after testing the v0.5.0 → working-proxy path end-to-end and finding that even with Bugs 1–3 fixed, a user without the npm package still hits a "copy this command and run it yourself" popup. Closing that gap completes the zero-touch flow.

## Bug 1 — Proxy mode never actually engages (silent data loss in `enableProxy`)

**Severity:** high — `Enable Proxy Mode` reports success and the npm proxy server can be started manually, but Claude Code never sees `ANTHROPIC_BASE_URL`, so all requests still hit `api.anthropic.com` directly. The user thinks they're on the proxy and they're not.

**Root cause.** `claudeCode.environmentVariables` is **an array of `{name, value}` objects**, not a flat map. Confirmed by inspecting a real settings.json that already contained entries written by the Claude Code extension itself:

```json
"claudeCode.environmentVariables": [
  { "name": "CACHE_FIX_IMAGE_KEEP_LAST", "value": "3" },
  { "name": "CACHE_FIX_DEBUG", "value": "1" },
  { "name": "CACHE_FIX_DUMP_BREAKPOINTS", "value": "C:\\Users\\Alex\\.claude\\bp.json" }
]
```

But `extension.js` treats it as an object:

```js
const envVars = config.get(ENV_SETTING) || {};
if (envVars.ANTHROPIC_BASE_URL && ...) { ... }   // always undefined on an Array
envVars.ANTHROPIC_BASE_URL = DEFAULT_PROXY_URL;  // sets a *named property* on Array instance
await config.update(ENV_SETTING, envVars, ...);   // VS Code JSON-serializes the array
```

`JSON.stringify` of an array with named properties drops those properties. The update succeeds, the popup says success, but `ANTHROPIC_BASE_URL` never lands in settings.json. `isProxyEnabled()` then returns `false` on the next read for the same reason.

**Repro:** install fresh, run `Enable Proxy Mode`, look at settings.json. There is no `ANTHROPIC_BASE_URL` entry under `claudeCode.environmentVariables`.

**Fix:** read/write the array shape, preserving existing entries:

```js
const rawEnv = config.get(ENV_SETTING);
let entries = Array.isArray(rawEnv) ? rawEnv.slice()
  : (rawEnv && typeof rawEnv === 'object')
    ? Object.entries(rawEnv).map(([name, value]) => ({ name, value }))
    : [];
const existing = entries.find((e) => e?.name === 'ANTHROPIC_BASE_URL');
if (existing) existing.value = DEFAULT_PROXY_URL;
else entries.push({ name: 'ANTHROPIC_BASE_URL', value: DEFAULT_PROXY_URL });
await config.update(ENV_SETTING, entries, vscode.ConfigurationTarget.Global);
```

Mirrored changes for `disableProxy` (filter the entry out) and `isProxyEnabled` (look up the entry instead of `obj.ANTHROPIC_BASE_URL`).

## Bug 2 — `claudeCode.claudeProcessWrapper` rots on every extension update

**Severity:** high — every version bump produces a Claude Code error like:

```
ReferenceError: Claude Code native binary not found at
c:\Users\Alex\.vscode-insiders\extensions\vsitsllc.claude-code-cache-fix-0.5.0\ClaudeCodeCacheFixWrapper.exe.
```

**Root cause.** The npm package ships only the C source (`tools/claude-vscode-wrapper.c`), not a compiled `.exe`, so on Windows `getWrapperPath()` always falls through to `path.join(context.extensionPath, 'ClaudeCodeCacheFixWrapper.exe')`. That path lives inside the **versioned** extensions folder (`vsitsllc.claude-code-cache-fix-<VERSION>\...`). Once that absolute path is written into the global `claudeCode.claudeProcessWrapper` setting, the next extension update renames the folder and the saved setting points at a non-existent file.

**Fix.** Mirror the bundled `.exe` into a stable per-user location on every activate, and write that stable path into the setting instead:

```js
function getStableBinDir() {
  return path.join(require('os').homedir(), '.claude', 'cache-fix-bin');
}
function ensureStableWrapperCopy(context) {
  // mkdirSync + copyFileSync, idempotent via size+mtime check
  // returns the stable path
}
```

Plus a `reconcileWrapperSetting()` that runs in `activate()` and:
- only touches the setting if it's clearly ours (matches `*\extensions\vsitsllc.claude-code-cache-fix-*` or our stable dir — never touches a third-party wrapper),
- rewrites it to the stable path, **or** clears it entirely if proxy mode is taking over (preload+proxy is redundant on CC v2.1.113+).

This is fully self-healing across version bumps and uninstall/reinstall.

## Bug 3 — Proxy mode requires the user to manually start the server (UX gap)

**Severity:** medium — `Enable Proxy Mode` writes `ANTHROPIC_BASE_URL` (modulo Bug 1), then shows a popup that says "Start the proxy server, then restart any active Claude Code session." with a "Copy Start Command" button. The user has to spawn `node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &` themselves, which on Windows is not a one-liner and leaves a console window open. If the user closes that terminal, the proxy dies and Claude Code starts hitting a dead port (502s with no obvious cause).

**Fix.** Spawn the proxy from the extension as a managed child:

- `process.execPath` to find Node (no PATH lookup needed),
- `windowsHide: true` so no console window,
- pipe stdout/stderr to an `OutputChannel` ("Claude Code Cache Fix — Proxy") for diagnostics,
- probe `GET /health` first and reuse an existing server if one is running (so multiple windows / external launches don't fight),
- kill the child in `deactivate()` so closing VS Code stops the proxy too.

Optional setting `claude-code-cache-fix.autoStartProxy` (default `true`) lets users keep manual control if they want it. With this, going from a fresh install to working proxy is "install the VSIX, restart VS Code." Zero command palette steps.

## Bug 4 — Missing npm package isn't auto-installed (UX gap, follow-on to Bug 3)

**Severity:** medium — once Bug 3 is fixed and the extension owns proxy startup, the next paper-cut is the npm package itself. Today, on a fresh install where `claude-code-cache-fix` isn't on the global node_modules, both `enable` and `enableProxy` show a popup with a "Copy Install Command" button and ask the user to run `npm install -g claude-code-cache-fix` themselves. This is the same "do this yourself" pattern that Bug 3 removed for the proxy server.

**Fix.** Detect the user's primary package manager and install it for them:

```js
function detectInstallerForInterceptor() {
  const which = (name) => { /* `where`/`command -v` lookup */ };
  const voltaPath = which('volta');
  const npmPath   = which('npm');
  const npmIsVoltaManaged = !!(npmPath && /[\\/]volta[\\/]/i.test(npmPath));
  if (voltaPath && (npmIsVoltaManaged || !npmPath)) {
    return { name: 'volta', cmd: 'volta', args: ['install', 'claude-code-cache-fix@latest'] };
  }
  if (npmPath) {
    return { name: 'npm', cmd: 'npm', args: ['install', '-g', 'claude-code-cache-fix@latest'] };
  }
  return null;
}
```

Then in `activate()`, if the interceptor is missing and a new `autoInstallInterceptor` setting is on (default `true`), spawn the installer with `vscode.window.withProgress({ location: Notification })`, stream output to the proxy channel, and continue with proxy auto-start once the install succeeds.

**Why the volta-vs-npm distinction matters.** On a Volta-managed system, `npm install -g` *works* — the package lands inside `Volta\tools\image\node\<version>\node_modules\` — but it isn't tracked by `volta list`, so the user's package inventory drifts silently and the install doesn't survive a `volta pin node@<other>`. Detecting that `npm` resolves to a Volta shim (`C:\Program Files\Volta\npm.exe` on Windows; symlink under `~/.volta/bin/npm` on \*nix) tells us to use `volta install` instead. The detection signal is robust because Volta deliberately replaces `npm` on PATH.

Combined with Bug 3, the new fresh-install path is: install the VSIX → restart VS Code → it auto-installs the npm package → it auto-starts the proxy → it auto-sets `ANTHROPIC_BASE_URL`. Zero shell commands, zero command-palette steps.

## Related upstream — Windows path bug in `claude-code-cache-fix@3.0.1` (different repo)

While testing the proxy I noticed that on Windows **none of the cache-fix pipeline extensions actually load**, so the proxy is effectively a passthrough. `proxy/pipeline.mjs` line 19:

```js
const mod = await import(join(dir, file) + "?t=" + Date.now());
```

`import()` rejects raw Windows paths (`Only URLs with a scheme in: file, data, and node are supported... Received protocol 'c:'`). Fix is `pathToFileURL(join(dir, file)).href`. Worth filing in cnighswonger/claude-code-cache-fix — without it, Windows users on the proxy path get the listening server but zero applied fixes (`Fix stats:` empty in `Show Status`).

## Patch

Tested end-to-end on Windows 11 + Code Insiders + Volta Node 22.22.0 + npm 10.9.4. After the patch, `Show Status` reports `Mode: Proxy`, `Proxy listening: Yes (managed by extension)`, and real applied counts (`relocate: 1713 applied, ttl: 1253 applied, tool_sort: 531 applied, ...`).

```diff
diff --git a/extension.js b/extension.js
index 7f4caba..bf5dff3 100644
--- a/extension.js
+++ b/extension.js
@@ -1,12 +1,90 @@
 const vscode = require('vscode');
 const path = require('path');
 const fs = require('fs');
-const { execSync } = require('child_process');
+const http = require('http');
+const { execSync, spawn } = require('child_process');
 
 const WRAPPER_SETTING = 'claudeCode.claudeProcessWrapper';
 const ENV_SETTING = 'claudeCode.environmentVariables';
 const CONFIG_KEY = 'claude-code-cache-fix';
-const DEFAULT_PROXY_URL = 'http://127.0.0.1:9801';
+const PROXY_HOST = '127.0.0.1';
+const PROXY_PORT = 9801;
+const DEFAULT_PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
+
+let proxyProcess = null;
+let proxyChannel = null;
+
+function getProxyChannel() {
+  if (!proxyChannel) {
+    proxyChannel = vscode.window.createOutputChannel('Claude Code Cache Fix — Proxy');
+  }
+  return proxyChannel;
+}
+
+function probeProxyRunning(timeoutMs = 800) {
+  return new Promise((resolve) => {
+    const req = http.request(
+      { host: PROXY_HOST, port: PROXY_PORT, path: '/health', method: 'GET', timeout: timeoutMs },
+      (res) => {
+        res.resume();
+        resolve(res.statusCode === 200);
+      }
+    );
+    req.on('error', () => resolve(false));
+    req.on('timeout', () => { req.destroy(); resolve(false); });
+    req.end();
+  });
+}
+
+async function startProxyServer() {
+  if (proxyProcess && proxyProcess.exitCode === null) {
+    return { status: 'already-managed' };
+  }
+  if (await probeProxyRunning()) {
+    return { status: 'already-external' };
+  }
+  const proxyPath = getProxyServerPath();
+  if (!proxyPath) {
+    return { status: 'not-found' };
+  }
+  const channel = getProxyChannel();
+  channel.appendLine(`[${new Date().toISOString()}] Starting proxy: ${proxyPath}`);
+  try {
+    const child = spawn(process.execPath, [proxyPath], {
+      cwd: path.dirname(proxyPath),
+      env: process.env,
+      stdio: ['ignore', 'pipe', 'pipe'],
+      windowsHide: true,
+    });
+    child.stdout.on('data', (d) => channel.append(d.toString()));
+    child.stderr.on('data', (d) => channel.append(d.toString()));
+    child.on('exit', (code, signal) => {
+      channel.appendLine(`[${new Date().toISOString()}] Proxy exited (code=${code}, signal=${signal})`);
+      if (proxyProcess === child) proxyProcess = null;
+    });
+    proxyProcess = child;
+    for (let i = 0; i < 20; i++) {
+      await new Promise((r) => setTimeout(r, 100));
+      if (await probeProxyRunning(300)) return { status: 'started' };
+      if (child.exitCode !== null) return { status: 'crashed' };
+    }
+    return { status: 'started-unverified' };
+  } catch (err) {
+    channel.appendLine(`[${new Date().toISOString()}] Spawn failed: ${err.message}`);
+    return { status: 'spawn-failed', error: err.message };
+  }
+}
+
+function stopProxyServer() {
+  if (!proxyProcess) return false;
+  try {
+    proxyProcess.kill();
+  } catch {}
+  proxyProcess = null;
+  getProxyChannel().appendLine(`[${new Date().toISOString()}] Proxy stop requested`);
+  return true;
+}
 
 /**
  * Get npm global root, cached.
@@ -41,30 +119,119 @@ function isClaudeCodeInstalled() {
   return fs.existsSync(path.join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js'));
 }
 
+function getStableBinDir() {
+  return path.join(require('os').homedir(), '.claude', 'cache-fix-bin');
+}
+function getStableWrapperPath() {
+  const ext = process.platform === 'win32' ? 'ClaudeCodeCacheFixWrapper.exe' : 'wrapper.js';
+  return path.join(getStableBinDir(), ext);
+}
+
+function ensureStableWrapperCopy(context) {
+  const srcName = process.platform === 'win32' ? 'ClaudeCodeCacheFixWrapper.exe' : 'wrapper.js';
+  const src = path.join(context.extensionPath, srcName);
+  if (!fs.existsSync(src)) return null;
+  const dstDir = getStableBinDir();
+  const dst = path.join(dstDir, srcName);
+  try {
+    fs.mkdirSync(dstDir, { recursive: true });
+    const srcStat = fs.statSync(src);
+    let needsCopy = true;
+    if (fs.existsSync(dst)) {
+      const dstStat = fs.statSync(dst);
+      if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) needsCopy = false;
+    }
+    if (needsCopy) {
+      fs.copyFileSync(src, dst);
+      fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
+    }
+    return dst;
+  } catch { return null; }
+}
+
 function getWrapperPath(context) {
   if (process.platform === 'win32') {
     const npmRoot = getNpmRoot();
     if (npmRoot) {
       const npmExe = path.join(npmRoot, 'claude-code-cache-fix', 'tools', 'ClaudeCodeCacheFixWrapper.exe');
       if (fs.existsSync(npmExe)) return npmExe;
     }
+    const stable = getStableWrapperPath();
+    if (fs.existsSync(stable)) return stable;
     const exePath = path.join(context.extensionPath, 'ClaudeCodeCacheFixWrapper.exe');
     if (fs.existsSync(exePath)) return exePath;
     return null;
   }
+  const stable = getStableWrapperPath();
+  if (fs.existsSync(stable)) return stable;
   return path.join(context.extensionPath, 'wrapper.js');
 }
 
+function isOurWrapperSetting(current, context) {
+  if (typeof current !== 'string' || !current) return false;
+  const lc = current.toLowerCase();
+  const extLc = (context.extensionPath || '').toLowerCase();
+  const stableLc = getStableBinDir().toLowerCase();
+  if (lc.includes('claude-code-cache-fix') && lc.includes('.vscode-insiders\\extensions')) return true;
+  if (lc.includes('claude-code-cache-fix') && lc.includes('.vscode\\extensions')) return true;
+  if (lc.includes('claude-code-cache-fix') && lc.includes('cursor\\extensions')) return true;
+  if (extLc && lc.startsWith(extLc)) return true;
+  if (lc.startsWith(stableLc)) return true;
+  return false;
+}
+
+async function reconcileWrapperSetting(context, { proxyTakingOver }) {
+  const config = vscode.workspace.getConfiguration();
+  const current = config.get(WRAPPER_SETTING);
+  if (!current) return;
+  if (!isOurWrapperSetting(current, context)) return;
+  if (proxyTakingOver) {
+    await config.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
+    return;
+  }
+  const stable = ensureStableWrapperCopy(context) || getWrapperPath(context);
+  if (!stable) {
+    if (!fs.existsSync(current)) {
+      await config.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
+    }
+    return;
+  }
+  if (path.normalize(current).toLowerCase() !== path.normalize(stable).toLowerCase()) {
+    await config.update(WRAPPER_SETTING, stable, vscode.ConfigurationTarget.Global);
+  }
+}
+
 // ... [enableProxy / disableProxy / isProxyEnabled / activate now use the array shape
 //      for ENV_SETTING and call startProxyServer / stopProxyServer / reconcileWrapperSetting.
 //      Full diff: 365 +, 48 −. Happy to attach the whole patch as a file or open a PR if preferred.]
```

(Truncated for readability — the full diff is ~509 lines. The omitted hunks are: rewrites of `enableProxy`/`disableProxy`/`isProxyEnabled` to handle the array shape (Bug 1), `activate()` to call `reconcileWrapperSetting` and silently auto-start proxy when available (Bugs 2 + 3), and `deactivate()` to stop the managed child. New setting `claude-code-cache-fix.autoStartProxy` added to `package.json` contributes.configuration.)

I kept this as an issue rather than a PR per personal preference (don't want to publish a fork), but happy to send the full patch as an attachment, paste it inline, or rework as a PR if any of the above is something you'd merge.

