const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execSync, spawn } = require('child_process');

const WRAPPER_SETTING = 'claudeCode.claudeProcessWrapper';
const ENV_SETTING = 'claudeCode.environmentVariables';
const CONFIG_KEY = 'claude-code-cache-fix';
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 9801;
const DEFAULT_PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

let proxyProcess = null;
let proxyChannel = null;

function getProxyChannel() {
  if (!proxyChannel) {
    proxyChannel = vscode.window.createOutputChannel('Claude Code Cache Fix — Proxy');
  }
  return proxyChannel;
}

function getProxyLogPath() {
  return path.join(require('os').homedir(), '.claude', 'cache-fix-proxy-log.ndjson');
}

/**
 * Pick the package manager to use for installing the interceptor.
 * Volta wins if both `volta` is on PATH AND `npm` resolves to a Volta-managed binary
 * (i.e. the user's whole Node toolchain is Volta — `npm install -g` would still work
 * but bypasses Volta's tracking, so we'd be silently inconsistent with `volta list`).
 *
 * Returns `{ name: 'volta'|'npm', cmd: 'volta'|'npm', args: string[] }` or null when
 * neither tool is reachable.
 */
function detectInstallerForInterceptor() {
  const which = (name) => {
    try {
      const out = execSync(process.platform === 'win32' ? `where ${name}` : `command -v ${name}`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/).filter(Boolean)[0];
      return out || null;
    } catch { return null; }
  };
  const voltaPath = which('volta');
  const npmPath = which('npm');
  const npmIsVoltaManaged = !!(npmPath && /[\\/]volta[\\/]/i.test(npmPath));
  if (voltaPath && (npmIsVoltaManaged || !npmPath)) {
    return { name: 'volta', cmd: 'volta', args: ['install', 'claude-code-cache-fix@latest'] };
  }
  if (npmPath) {
    return { name: 'npm', cmd: 'npm', args: ['install', '-g', 'claude-code-cache-fix@latest'] };
  }
  return null;
}

/**
 * Install (or upgrade) the claude-code-cache-fix npm package using the detected manager.
 * Reports progress in a notification and streams output to the proxy channel.
 */
async function installInterceptor(reason) {
  const installer = detectInstallerForInterceptor();
  if (!installer) {
    return { ok: false, reason: 'neither volta nor npm on PATH' };
  }
  const channel = getProxyChannel();
  const cmdline = `${installer.cmd} ${installer.args.join(' ')}`;
  channel.appendLine(`[${new Date().toISOString()}] Auto-install (${reason}): ${cmdline}`);
  // Reset caches so post-install the new path is picked up.
  _npmRoot = null;
  _interceptorDir = null;

  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cache Fix: ${reason} via ${installer.name}…`, cancellable: false },
    () => new Promise((resolve) => {
      const child = spawn(installer.cmd, installer.args, {
        // shell:true so npm.cmd / npm.ps1 / volta.exe are all resolved off PATH on Windows.
        shell: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (d) => channel.append(d.toString()));
      child.stderr.on('data', (d) => channel.append(d.toString()));
      child.on('error', (err) => {
        channel.appendLine(`[${new Date().toISOString()}] Installer spawn error: ${err.message}`);
        resolve({ ok: false, reason: err.message });
      });
      child.on('exit', (code) => {
        channel.appendLine(`[${new Date().toISOString()}] Installer exited with code ${code}`);
        resolve({ ok: code === 0, reason: code === 0 ? null : `exit code ${code}`, manager: installer.name });
      });
    })
  );
}

function getProxyExtensionsConfigPath() {
  return path.join(require('os').homedir(), '.claude', 'cache-fix-proxy-extensions.json');
}

/**
 * Compute the proxy/TLS env vars that must be passed to the proxy child process.
 * Reads VS Code settings first, falls back to existing process env. Returns the
 * full env-var bag plus a small summary used for logging/status.
 */
function computeProxyEnv() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const fromCfg = (key) => {
    const v = cfg.get(key);
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const httpsProxy = fromCfg('httpsProxy')
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY  || process.env.http_proxy
    || '';
  const noProxy = fromCfg('noProxy') || process.env.NO_PROXY || process.env.no_proxy || '';
  const caFile = fromCfg('caFile') || process.env.CACHE_FIX_PROXY_CA_FILE || process.env.NODE_EXTRA_CA_CERTS || '';
  const rejectUnauthorized = cfg.get('rejectUnauthorized', true);

  const env = {};
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy;
    env.HTTP_PROXY = httpsProxy;
  }
  if (noProxy) env.NO_PROXY = noProxy;
  if (caFile) {
    env.CACHE_FIX_PROXY_CA_FILE = caFile;
    env.NODE_EXTRA_CA_CERTS = caFile;
  }
  if (!rejectUnauthorized) {
    env.CACHE_FIX_PROXY_REJECT_UNAUTHORIZED = '0';
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  return { env, summary: { httpsProxy, noProxy, caFile, rejectUnauthorized } };
}

/**
 * Export matching certificates from the Windows certificate store to a PEM bundle
 * we can hand to Node via NODE_EXTRA_CA_CERTS / CACHE_FIX_PROXY_CA_FILE. Honors the
 * `certSearchPatterns` setting (defaults to common SSL-MITM products). Idempotent —
 * regenerates on every activate so cert rotations get picked up.
 */
function exportWindowsCorporateCerts(patterns, outputPath) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not windows', count: 0 };
  const dir = path.dirname(outputPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const patternsArg = (patterns && patterns.length ? patterns : ['*Zscaler*'])
    .map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',');
  const escapedOut = outputPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$patterns = @(${patternsArg})`,
    '$all = @()',
    'foreach ($p in $patterns) {',
    '  $all += Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Subject -like $p }',
    '  $all += Get-ChildItem Cert:\\LocalMachine\\CA   | Where-Object { $_.Subject -like $p }',
    '  $all += Get-ChildItem Cert:\\CurrentUser\\Root  | Where-Object { $_.Subject -like $p }',
    '  $all += Get-ChildItem Cert:\\CurrentUser\\CA    | Where-Object { $_.Subject -like $p }',
    '}',
    '$all = $all | Sort-Object -Property Thumbprint -Unique',
    '$pem = ""',
    'foreach ($c in $all) {',
    '  $pem += "# Subject: $($c.Subject)`n"',
    '  $pem += "-----BEGIN CERTIFICATE-----`n"',
    '  $pem += [Convert]::ToBase64String($c.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)',
    '  $pem += "`n-----END CERTIFICATE-----`n`n"',
    '}',
    `if ($all.Count -gt 0) { Set-Content -Path '${escapedOut}' -Value $pem -Encoding ascii -NoNewline; Write-Output "Exported $($all.Count) certificates" } else { Write-Output 'No matching certificates found' }`,
  ].join('\n');
  try {
    const out = execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command -', {
      input: ps,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();
    const m = /Exported (\d+)/.exec(out);
    return { ok: !!m, count: m ? Number(m[1]) : 0, message: out };
  } catch (err) {
    return { ok: false, reason: err.message, count: 0 };
  }
}

function getCorpCaBundlePath() {
  return path.join(require('os').homedir(), '.claude', 'cache-fix-corp-ca-bundle.pem');
}

/**
 * If autoExportCerts is on, refresh the bundle and (when no caFile is set)
 * write the bundle path back into the caFile setting so the rest of the flow
 * picks it up uniformly. No-op on non-Windows.
 */
async function maybeAutoExportCerts() {
  if (process.platform !== 'win32') return;
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  if (!cfg.get('autoExportCerts', false)) return;
  const patterns = cfg.get('certSearchPatterns', ['*Zscaler*', '*Netskope*', '*Forcepoint*']);
  const outPath = getCorpCaBundlePath();
  const channel = getProxyChannel();
  channel.appendLine(`[${new Date().toISOString()}] Auto-exporting Windows certs (${patterns.join(', ')}) → ${outPath}`);
  const r = exportWindowsCorporateCerts(patterns, outPath);
  if (r.ok) {
    channel.appendLine(`[${new Date().toISOString()}] Cert export: ${r.message}`);
    const current = cfg.get('caFile', '');
    if (!current) await cfg.update('caFile', outPath, vscode.ConfigurationTarget.Global);
  } else {
    channel.appendLine(`[${new Date().toISOString()}] Cert export failed: ${r.reason || r.message || 'unknown'}`);
  }
}

/**
 * Run a real round-trip to api.anthropic.com using the configured proxy + CA, so
 * users can confirm corp-egress + cert chain is right BEFORE driving Claude Code
 * traffic through it. Mirrors the behavior the proxy itself will use for upstream.
 */
async function testProxyConnection() {
  const channel = getProxyChannel();
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const { summary } = computeProxyEnv();
  const { httpsProxy, noProxy, caFile, rejectUnauthorized } = summary;

  channel.appendLine(`[${new Date().toISOString()}] === Test connection to api.anthropic.com ===`);
  channel.appendLine(`  proxy: ${httpsProxy || '(direct)'}`);
  channel.appendLine(`  noProxy: ${noProxy || '(none)'}`);
  channel.appendLine(`  caFile: ${caFile || '(system default)'}${caFile && !fs.existsSync(caFile) ? ' [MISSING]' : ''}`);
  channel.appendLine(`  rejectUnauthorized: ${rejectUnauthorized}`);

  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing connection to api.anthropic.com…' },
    () => new Promise((resolve) => {
      // Build agent if we need a corp proxy or custom CA / insecure mode.
      let agent = null;
      const wantsAgent = httpsProxy || caFile || !rejectUnauthorized;
      if (wantsAgent) {
        try {
          const dir = getInterceptorDir();
          const hpagentPath = dir ? path.join(dir, 'node_modules', 'hpagent') : '';
          if (httpsProxy && hpagentPath && fs.existsSync(hpagentPath)) {
            const { HttpsProxyAgent } = require(hpagentPath);
            const opts = {
              keepAlive: true,
              proxy: httpsProxy,
              rejectUnauthorized,
            };
            if (caFile && fs.existsSync(caFile)) opts.ca = fs.readFileSync(caFile);
            agent = new HttpsProxyAgent(opts);
            channel.appendLine(`  using HttpsProxyAgent from ${hpagentPath}`);
          } else if (httpsProxy) {
            channel.appendLine(`  hpagent not bundled in claude-code-cache-fix; corp proxy will not be honored by this test (the proxy server itself uses Node-stdlib forwarding too — that's the upstream bug being tracked).`);
          } else {
            // No proxy, just custom CA / insecure mode
            const opts = { keepAlive: true, rejectUnauthorized };
            if (caFile && fs.existsSync(caFile)) opts.ca = fs.readFileSync(caFile);
            agent = new https.Agent(opts);
          }
        } catch (err) {
          channel.appendLine(`  agent setup error: ${err.message}`);
        }
      }

      const reqOpts = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/',
        method: 'GET',
        timeout: 10000,
        rejectUnauthorized,
      };
      if (agent) reqOpts.agent = agent;
      if (!agent && caFile && fs.existsSync(caFile)) {
        try { reqOpts.ca = fs.readFileSync(caFile); } catch {}
      }

      const req = https.request(reqOpts, (res) => {
        channel.appendLine(`  response: HTTP ${res.statusCode} ${res.statusMessage || ''}`);
        channel.appendLine(`  server: ${res.headers.server || '(unset)'}`);
        channel.appendLine(`[${new Date().toISOString()}] === Connection succeeded ===`);
        res.resume();
        vscode.window.showInformationMessage(
          `api.anthropic.com reachable (HTTP ${res.statusCode}). Proxy + CA configuration looks good.`,
          'Show Log'
        ).then((c) => { if (c === 'Show Log') channel.show(true); });
        resolve();
      });
      req.on('error', (err) => {
        channel.appendLine(`  ERROR: ${err.code || ''} ${err.message}`);
        const certHint = /certificate|UNABLE_TO|CERT_|self.signed/i.test(err.message)
          ? ' Looks like a TLS chain issue — your caFile is missing the corporate root CA.' : '';
        const proxyHint = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(err.message)
          ? ' Looks like a network/proxy issue — verify httpsProxy is reachable from this machine.' : '';
        channel.appendLine(`[${new Date().toISOString()}] === Connection failed ===`);
        vscode.window.showErrorMessage(
          `Connection failed: ${err.message}.${certHint}${proxyHint}`,
          'Show Log'
        ).then((c) => { if (c === 'Show Log') channel.show(true); });
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        channel.appendLine(`  TIMEOUT`);
        vscode.window.showErrorMessage('Connection timed out. Check httpsProxy reachability.');
        resolve();
      });
      req.end();
    })
  );
}

/**
 * Workaround for a bug in claude-code-cache-fix npm package <=3.0.1: the proxy's
 * pipeline loader passes raw Windows paths to dynamic import(), which Node rejects
 * with "Only URLs with a scheme in: file, data, node, and electron are supported".
 * Result: all pipeline extensions silently fail to load and the proxy degrades to a
 * passthrough with zero cache fixes applied. We patch in-place using string replace,
 * idempotent. Returns { patched, restart, reason } — restart=true means the running
 * server is using the broken module and needs a fresh spawn to pick up the fix.
 */
function patchPipelineMjsIfNeeded() {
  if (process.platform !== 'win32') return { patched: false, restart: false, reason: 'not windows' };
  const dir = getInterceptorDir();
  if (!dir) return { patched: false, restart: false, reason: 'interceptor not installed' };
  const file = path.join(dir, 'proxy', 'pipeline.mjs');
  if (!fs.existsSync(file)) return { patched: false, restart: false, reason: 'pipeline.mjs missing' };
  let src;
  try { src = fs.readFileSync(file, 'utf-8'); }
  catch (err) { return { patched: false, restart: false, reason: `read failed: ${err.message}` }; }

  // Idempotency check — pathToFileURL is the marker.
  if (src.includes('pathToFileURL(join(dir, file))')) {
    return { patched: false, restart: false, reason: 'already patched' };
  }
  const buggyLine = 'const mod = await import(join(dir, file) + "?t=" + Date.now());';
  if (!src.includes(buggyLine)) {
    return { patched: false, restart: false, reason: 'buggy line not found (upstream may have fixed)' };
  }
  const fixedLine = 'const mod = await import(pathToFileURL(join(dir, file)).href + "?t=" + Date.now());';
  let newSrc = src.replace(buggyLine, fixedLine);
  if (!newSrc.includes('from "node:url"') && !newSrc.includes("from 'node:url'")) {
    // Insert the import after the last existing top-of-file import line.
    const lines = newSrc.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\s/.test(lines[i])) lastImportIdx = i;
      else if (lastImportIdx >= 0 && lines[i].trim() === '') break;
    }
    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, 'import { pathToFileURL } from "node:url";');
      newSrc = lines.join('\n');
    } else {
      newSrc = 'import { pathToFileURL } from "node:url";\n' + newSrc;
    }
  }
  try { fs.writeFileSync(file, newSrc); }
  catch (err) { return { patched: false, restart: false, reason: `write failed: ${err.message}` }; }
  // If the proxy is already running it loaded the broken module — needs respawn.
  const restart = !!(proxyProcess && proxyProcess.exitCode === null);
  return { patched: true, restart, reason: null };
}

// Mirror the npm package's default extensions.json, but force `request-log` on
// so the proxy emits NDJSON telemetry for every stream event. Rewritten on each
// activate so upstream changes don't drift our override silently.
function ensureProxyExtensionsConfig() {
  const config = {
    'fingerprint-strip': { enabled: true, order: 100 },
    'sort-stabilization': { enabled: true, order: 200 },
    'fresh-session-sort': { enabled: true, order: 250 },
    'identity-normalization': { enabled: true, order: 300 },
    'cache-control-normalize': { enabled: true, order: 400 },
    'ttl-management': { enabled: true, order: 500 },
    'cache-telemetry': { enabled: true, order: 600 },
    'request-log': { enabled: true, order: 700 },
  };
  const configPath = getProxyExtensionsConfigPath();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  } catch {
    return null;
  }
}

function probeProxyRunning(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: PROXY_HOST, port: PROXY_PORT, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function startProxyServer() {
  if (proxyProcess && proxyProcess.exitCode === null) {
    return { status: 'already-managed' };
  }
  if (await probeProxyRunning()) {
    return { status: 'already-external' };
  }
  const proxyPath = getProxyServerPath();
  if (!proxyPath) {
    return { status: 'not-found' };
  }
  const channel = getProxyChannel();
  const extensionsConfig = ensureProxyExtensionsConfig();
  const logPath = getProxyLogPath();
  const proxyCfg = computeProxyEnv();
  channel.appendLine(`[${new Date().toISOString()}] Starting proxy: ${proxyPath}`);
  channel.appendLine(`[${new Date().toISOString()}] Request log: ${logPath}`);
  if (proxyCfg.summary.httpsProxy) {
    channel.appendLine(`[${new Date().toISOString()}] Upstream HTTP proxy: ${proxyCfg.summary.httpsProxy} (rejectUnauthorized=${proxyCfg.summary.rejectUnauthorized}, ca=${proxyCfg.summary.caFile || 'system default'})`);
  } else if (proxyCfg.summary.caFile) {
    channel.appendLine(`[${new Date().toISOString()}] Upstream CA file: ${proxyCfg.summary.caFile} (rejectUnauthorized=${proxyCfg.summary.rejectUnauthorized})`);
  }
  if (!proxyCfg.summary.rejectUnauthorized) {
    channel.appendLine(`[${new Date().toISOString()}] WARNING: TLS verification disabled — upstream certificates not validated.`);
  }
  try {
    const child = spawn(process.execPath, [proxyPath], {
      cwd: path.dirname(proxyPath),
      env: {
        ...process.env,
        ...proxyCfg.env,
        CACHE_FIX_REQUEST_LOG: logPath,
        ...(extensionsConfig ? { CACHE_FIX_EXTENSIONS_CONFIG: extensionsConfig } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => channel.append(d.toString()));
    child.stderr.on('data', (d) => channel.append(d.toString()));
    child.on('exit', (code, signal) => {
      channel.appendLine(`[${new Date().toISOString()}] Proxy exited (code=${code}, signal=${signal})`);
      if (proxyProcess === child) proxyProcess = null;
    });
    proxyProcess = child;
    // Wait briefly for the listen message, then probe.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await probeProxyRunning(300)) return { status: 'started' };
      if (child.exitCode !== null) return { status: 'crashed' };
    }
    return { status: 'started-unverified' };
  } catch (err) {
    channel.appendLine(`[${new Date().toISOString()}] Spawn failed: ${err.message}`);
    return { status: 'spawn-failed', error: err.message };
  }
}

function stopProxyServer() {
  if (!proxyProcess) return false;
  try {
    proxyProcess.kill();
  } catch {}
  proxyProcess = null;
  getProxyChannel().appendLine(`[${new Date().toISOString()}] Proxy stop requested`);
  return true;
}

/**
 * Get npm global root, cached.
 */
let _npmRoot = null;
function getNpmRoot() {
  if (!_npmRoot) {
    try {
      _npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  }
  return _npmRoot;
}

/**
 * Return the path to the installed `claude-code-cache-fix` package directory, or
 * null if not found. Handles three install layouts in order:
 *   1. Plain `npm install -g` → `<npm root -g>/claude-code-cache-fix`
 *   2. `volta install claude-code-cache-fix` → Volta puts it in its own tree at
 *      `<VOLTA_HOME>/tools/image/packages/claude-code-cache-fix/node_modules/claude-code-cache-fix`
 *      and does NOT populate the image's node_modules — so (1) misses it.
 *   3. Shared Volta location `<VOLTA_HOME>/tools/shared/claude-code-cache-fix`
 *      (some Volta versions keep the canonical copy here).
 * VOLTA_HOME defaults: %LOCALAPPDATA%\Volta on Windows, ~/.volta elsewhere.
 */
let _interceptorDir = null;
function getInterceptorDir() {
  if (_interceptorDir) return _interceptorDir;
  const candidates = [];
  const npmRoot = getNpmRoot();
  if (npmRoot) candidates.push(path.join(npmRoot, 'claude-code-cache-fix'));
  const voltaHome = process.env.VOLTA_HOME
    || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'Volta')
      : path.join(require('os').homedir(), '.volta'));
  if (voltaHome) {
    candidates.push(path.join(voltaHome, 'tools', 'image', 'packages', 'claude-code-cache-fix', 'node_modules', 'claude-code-cache-fix'));
    candidates.push(path.join(voltaHome, 'tools', 'shared', 'claude-code-cache-fix'));
  }
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'package.json'))) {
      _interceptorDir = p;
      return p;
    }
  }
  return null;
}

/**
 * Check if the interceptor npm package is installed globally.
 */
function isInterceptorInstalled() {
  const dir = getInterceptorDir();
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'preload.mjs'));
}

/**
 * Check if Claude Code npm package is installed globally.
 */
function isClaudeCodeInstalled() {
  const npmRoot = getNpmRoot();
  if (!npmRoot) return false;
  return fs.existsSync(path.join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js'));
}

/**
 * Stable on-disk location for the wrapper, shared across extension updates.
 * Writing the wrapper setting to this path avoids the "folder changes on every update"
 * breakage where claudeCode.claudeProcessWrapper rots to point at a prior version's extension dir.
 */
function getStableBinDir() {
  return path.join(require('os').homedir(), '.claude', 'cache-fix-bin');
}
function getStableWrapperPath() {
  const ext = process.platform === 'win32' ? 'ClaudeCodeCacheFixWrapper.exe' : 'wrapper.js';
  return path.join(getStableBinDir(), ext);
}

/**
 * Mirror the bundled wrapper into the stable bin dir if it's missing or outdated.
 * Returns the stable path on success, null on failure.
 */
function ensureStableWrapperCopy(context) {
  const srcName = process.platform === 'win32' ? 'ClaudeCodeCacheFixWrapper.exe' : 'wrapper.js';
  const src = path.join(context.extensionPath, srcName);
  if (!fs.existsSync(src)) return null;
  const dstDir = getStableBinDir();
  const dst = path.join(dstDir, srcName);
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    const srcStat = fs.statSync(src);
    let needsCopy = true;
    if (fs.existsSync(dst)) {
      const dstStat = fs.statSync(dst);
      if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
        needsCopy = false;
      }
    }
    if (needsCopy) {
      fs.copyFileSync(src, dst);
      // Preserve mtime so later comparisons stay sensible.
      fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
    }
    return dst;
  } catch {
    return null;
  }
}

/**
 * Get the path to the appropriate wrapper for this platform.
 * Preference order:
 *  1. npm-global tools/ (stable)
 *  2. ~/.claude/cache-fix-bin/ stable copy (stable across extension updates)
 *  3. bundled in extension directory (versioned path — last resort)
 */
function getWrapperPath(context) {
  if (process.platform === 'win32') {
    const dir = getInterceptorDir();
    if (dir) {
      const npmExe = path.join(dir, 'tools', 'ClaudeCodeCacheFixWrapper.exe');
      if (fs.existsSync(npmExe)) return npmExe;
    }
    const stable = getStableWrapperPath();
    if (fs.existsSync(stable)) return stable;
    const exePath = path.join(context.extensionPath, 'ClaudeCodeCacheFixWrapper.exe');
    if (fs.existsSync(exePath)) return exePath;
    return null;
  }
  const stable = getStableWrapperPath();
  if (fs.existsSync(stable)) return stable;
  return path.join(context.extensionPath, 'wrapper.js');
}

/**
 * Is the currently-written wrapper setting one we control? (Matches our extension folder
 * or our stable bin dir — we should never touch a wrapper that belongs to someone else.)
 */
function isOurWrapperSetting(current, context) {
  if (typeof current !== 'string' || !current) return false;
  const lc = current.toLowerCase();
  const extLc = (context.extensionPath || '').toLowerCase();
  const stableLc = getStableBinDir().toLowerCase();
  if (lc.includes('claude-code-cache-fix') && lc.includes('.vscode-insiders\\extensions')) return true;
  if (lc.includes('claude-code-cache-fix') && lc.includes('.vscode\\extensions')) return true;
  if (lc.includes('claude-code-cache-fix') && lc.includes('cursor\\extensions')) return true;
  if (extLc && lc.startsWith(extLc)) return true;
  if (lc.startsWith(stableLc)) return true;
  return false;
}

/**
 * Repair a stale wrapper setting left behind by a prior extension version.
 * Either rewrites it to the stable path, or clears it if proxy mode is taking over.
 */
async function reconcileWrapperSetting(context, { proxyTakingOver }) {
  const config = vscode.workspace.getConfiguration();
  const current = config.get(WRAPPER_SETTING);
  if (!current) return;
  if (!isOurWrapperSetting(current, context)) return;

  if (proxyTakingOver) {
    await config.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
    return;
  }

  const stable = ensureStableWrapperCopy(context) || getWrapperPath(context);
  if (!stable) {
    if (!fs.existsSync(current)) {
      await config.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
    }
    return;
  }
  if (path.normalize(current).toLowerCase() !== path.normalize(stable).toLowerCase()) {
    await config.update(WRAPPER_SETTING, stable, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Check if the wrapper is currently configured.
 */
function isEnabled() {
  const config = vscode.workspace.getConfiguration();
  const current = config.get(WRAPPER_SETTING);
  return current && current.includes('claude-code-cache-fix');
}

/**
 * Enable the cache fix by setting the process wrapper.
 */
async function enable(context) {
  // Check npm packages
  if (!isInterceptorInstalled()) {
    const action = await vscode.window.showWarningMessage(
      'claude-code-cache-fix npm package not found. Install it with: npm install -g claude-code-cache-fix',
      'Copy Install Command'
    );
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText('npm install -g claude-code-cache-fix');
      vscode.window.showInformationMessage('Install command copied to clipboard.');
    }
    return;
  }

  if (!isClaudeCodeInstalled()) {
    const action = await vscode.window.showWarningMessage(
      'Claude Code npm package not found. The cache fix requires the npm version, not the standalone binary. Install with: npm install -g @anthropic-ai/claude-code',
      'Copy Install Command'
    );
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText('npm install -g @anthropic-ai/claude-code');
      vscode.window.showInformationMessage('Install command copied to clipboard.');
    }
    return;
  }

  // Mirror the bundled wrapper into a stable per-user location so the saved setting
  // survives extension updates (the versioned extension folder changes on every bump).
  ensureStableWrapperCopy(context);
  const wrapperPath = getWrapperPath(context);

  // Windows-specific: need the .exe bridge
  if (process.platform === 'win32' && !wrapperPath) {
    const action = await vscode.window.showWarningMessage(
      'Windows requires a native .exe wrapper. Compile it from the C source in the claude-code-cache-fix package, or download from GitHub Releases.',
      'Copy Compile Command', 'Open Releases'
    );
    if (action === 'Copy Compile Command') {
      const dir = getInterceptorDir();
      const src = dir ? path.join(dir, 'tools', 'claude-vscode-wrapper.c') : 'claude-vscode-wrapper.c';
      await vscode.env.clipboard.writeText(`cl "${src}" /Fe:ClaudeCodeCacheFixWrapper.exe`);
      vscode.window.showInformationMessage('Compile command copied. Place the .exe in the extension directory or the cache-fix tools/ directory.');
    } else if (action === 'Open Releases') {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/cnighswonger/claude-code-cache-fix-vscode/releases/latest'));
    }
    return;
  }

  const config = vscode.workspace.getConfiguration();

  // Check if another wrapper is already set
  const current = config.get(WRAPPER_SETTING);
  if (current && !current.includes('claude-code-cache-fix')) {
    const choice = await vscode.window.showWarningMessage(
      `Another process wrapper is already configured: ${current}. Replace it?`,
      'Replace', 'Cancel'
    );
    if (choice !== 'Replace') return;
  }

  await config.update(WRAPPER_SETTING, wrapperPath, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'Claude Code Cache Fix enabled. Restart any active Claude Code session to apply.'
  );
}

/**
 * Disable the cache fix by clearing the process wrapper.
 */
async function disable() {
  const config = vscode.workspace.getConfiguration();
  const current = config.get(WRAPPER_SETTING);

  if (!current || !current.includes('claude-code-cache-fix')) {
    vscode.window.showInformationMessage('Claude Code Cache Fix is not currently enabled.');
    return;
  }

  await config.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'Claude Code Cache Fix disabled. Restart any active Claude Code session to apply.'
  );
}

/**
 * Show current status.
 */
async function showStatus(context) {
  const interceptorInstalled = isInterceptorInstalled();
  const ccInstalled = isClaudeCodeInstalled();
  const enabled = isEnabled();
  const wrapperPath = getWrapperPath(context);

  let statsInfo = '';
  try {
    const homeDir = require('os').homedir();
    const statsPath = path.join(homeDir, '.claude', 'cache-fix-stats.json');
    if (fs.existsSync(statsPath)) {
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
      const fixes = stats.fixes || {};
      const parts = [];
      for (const [name, data] of Object.entries(fixes)) {
        if (data.applied > 0) parts.push(`${name}: ${data.applied} applied`);
        else if (data.safetyBlocked > 0) parts.push(`${name}: safety-blocked`);
        else if (data.skipped > 0) parts.push(`${name}: dormant`);
      }
      if (parts.length > 0) statsInfo = '\n\nFix stats: ' + parts.join(', ');
    }
  } catch {}

  const proxyEnabled = isProxyEnabled();
  const proxyPath = getProxyServerPath();
  const proxyListening = await probeProxyRunning(500);
  const proxyManaged = proxyProcess && proxyProcess.exitCode === null;
  const corpEnv = computeProxyEnv().summary;
  const caFileExists = corpEnv.caFile ? fs.existsSync(corpEnv.caFile) : false;

  const lines = [
    `Platform: ${process.platform}`,
    `Interceptor installed: ${interceptorInstalled ? 'Yes' : 'No'}`,
    `Claude Code (npm) installed: ${ccInstalled ? 'Yes' : 'No'}`,
    `Mode: ${proxyEnabled ? 'Proxy' : enabled ? 'Preload (wrapper)' : 'Disabled'}`,
    proxyEnabled ? `Proxy URL: ${DEFAULT_PROXY_URL}` : `Wrapper path: ${wrapperPath || 'Not available'}`,
    `Proxy script: ${proxyPath ? 'Available (v3.0.1+)' : 'Not found (update npm package)'}`,
    `Proxy listening: ${proxyListening ? 'Yes' : 'No'}${proxyManaged ? ' (managed by extension)' : proxyListening ? ' (external process)' : ''}`,
    `Corp HTTP proxy: ${corpEnv.httpsProxy || '(none)'}`,
    `NO_PROXY: ${corpEnv.noProxy || '(none)'}`,
    `CA file: ${corpEnv.caFile || '(system default)'}${corpEnv.caFile ? (caFileExists ? ' OK' : ' MISSING') : ''}`,
    `TLS verify: ${corpEnv.rejectUnauthorized ? 'enabled' : 'DISABLED (insecure)'}`,
  ];

  vscode.window.showInformationMessage('Cache Fix Status:\n' + lines.join('\n') + statsInfo);
}

/**
 * Read the ANTHROPIC_BASE_URL entry from claudeCode.environmentVariables.
 * That setting is an ARRAY of { name, value } objects (not a flat map),
 * so we normalize both shapes defensively in case the schema ever changes.
 */
function getBaseUrlFromEnvSetting() {
  const config = vscode.workspace.getConfiguration();
  const raw = config.get(ENV_SETTING);
  if (Array.isArray(raw)) {
    const hit = raw.find((e) => e && typeof e === 'object' && e.name === 'ANTHROPIC_BASE_URL');
    return hit ? hit.value : undefined;
  }
  if (raw && typeof raw === 'object') return raw.ANTHROPIC_BASE_URL;
  return undefined;
}

/**
 * Check if proxy mode is currently enabled.
 */
function isProxyEnabled() {
  const v = getBaseUrlFromEnvSetting();
  return typeof v === 'string' && v.includes('127.0.0.1');
}

/**
 * Get the path to the proxy server script.
 */
function getProxyServerPath() {
  const dir = getInterceptorDir();
  if (!dir) return null;
  const proxyPath = path.join(dir, 'proxy', 'server.mjs');
  if (fs.existsSync(proxyPath)) return proxyPath;
  return null;
}

/**
 * Enable proxy mode by setting ANTHROPIC_BASE_URL in Claude Code env vars.
 * @param {{silent?: boolean}} opts - silent mode suppresses popups and skips the external-URL prompt
 */
async function enableProxy(opts = {}) {
  const silent = !!opts.silent;

  if (!isInterceptorInstalled()) {
    if (silent) return;
    const action = await vscode.window.showWarningMessage(
      'claude-code-cache-fix npm package not found (v3.0.1+ required for proxy). Install with: npm install -g claude-code-cache-fix',
      'Copy Install Command'
    );
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText('npm install -g claude-code-cache-fix');
    }
    return;
  }

  const proxyPath = getProxyServerPath();
  if (!proxyPath) {
    if (!silent) {
      vscode.window.showWarningMessage(
        'Proxy server not found. Update to v3.0.1+: npm install -g claude-code-cache-fix@latest'
      );
    }
    return;
  }

  const config = vscode.workspace.getConfiguration();
  const rawEnv = config.get(ENV_SETTING);
  // Normalize to array-of-entries, the shape the Claude Code extension actually consumes.
  let entries;
  if (Array.isArray(rawEnv)) entries = rawEnv.slice();
  else if (rawEnv && typeof rawEnv === 'object') entries = Object.entries(rawEnv).map(([name, value]) => ({ name, value }));
  else entries = [];

  const existing = entries.find((e) => e && e.name === 'ANTHROPIC_BASE_URL');
  if (existing && existing.value && !String(existing.value).includes('127.0.0.1')) {
    if (silent) {
      // Don't clobber a non-proxy ANTHROPIC_BASE_URL during auto-start — the user set it on purpose.
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `ANTHROPIC_BASE_URL is already set to: ${existing.value}. Replace with proxy?`,
      'Replace', 'Cancel'
    );
    if (choice !== 'Replace') return;
  }

  if (existing) {
    existing.value = DEFAULT_PROXY_URL;
  } else {
    entries.push({ name: 'ANTHROPIC_BASE_URL', value: DEFAULT_PROXY_URL });
  }
  await config.update(ENV_SETTING, entries, vscode.ConfigurationTarget.Global);

  const startResult = await startProxyServer();
  const baseMsg = `Proxy mode enabled (${DEFAULT_PROXY_URL}).`;
  const restartHint = ' Restart any active Claude Code session to apply.';
  let statusMsg;
  switch (startResult.status) {
    case 'started':
      statusMsg = `${baseMsg} Proxy server auto-started.${restartHint}`;
      break;
    case 'started-unverified':
      statusMsg = `${baseMsg} Proxy spawned but /health did not respond yet — check the "Claude Code Cache Fix — Proxy" output channel.${restartHint}`;
      break;
    case 'already-managed':
    case 'already-external':
      statusMsg = `${baseMsg} Proxy server already running.${restartHint}`;
      break;
    case 'crashed':
      statusMsg = `${baseMsg} Proxy started but exited immediately — see the output channel.`;
      break;
    case 'spawn-failed':
      statusMsg = `${baseMsg} Failed to spawn proxy: ${startResult.error || 'unknown error'}.`;
      break;
    case 'not-found':
    default:
      statusMsg = `${baseMsg} Proxy server script not found — reinstall claude-code-cache-fix@latest.`;
      break;
  }

  if (silent) {
    getProxyChannel().appendLine(`[${new Date().toISOString()}] Auto-start: ${statusMsg}`);
    return;
  }

  const action = await vscode.window.showInformationMessage(statusMsg, 'Show Proxy Log');
  if (action === 'Show Proxy Log') {
    getProxyChannel().show(true);
  }
}

/**
 * Disable proxy mode by removing ANTHROPIC_BASE_URL.
 */
async function disableProxy() {
  const config = vscode.workspace.getConfiguration();
  const rawEnv = config.get(ENV_SETTING);
  let entries;
  if (Array.isArray(rawEnv)) entries = rawEnv.slice();
  else if (rawEnv && typeof rawEnv === 'object') entries = Object.entries(rawEnv).map(([name, value]) => ({ name, value }));
  else entries = [];

  const before = entries.length;
  entries = entries.filter((e) => !(e && e.name === 'ANTHROPIC_BASE_URL'));
  if (entries.length === before) {
    vscode.window.showInformationMessage('Proxy mode is not currently enabled.');
    return;
  }

  await config.update(ENV_SETTING, entries.length > 0 ? entries : undefined, vscode.ConfigurationTarget.Global);
  const stopped = stopProxyServer();
  vscode.window.showInformationMessage(
    stopped
      ? 'Proxy mode disabled and managed proxy server stopped. Restart any active Claude Code session to apply.'
      : 'Proxy mode disabled. Restart any active Claude Code session to apply.'
  );
}

/**
 * Write VS Code settings to a config file the wrapper reads at launch.
 * Bridges VS Code UI settings into env vars for the interceptor.
 */
function syncSettings() {
  const config = vscode.workspace.getConfiguration(CONFIG_KEY);
  const homeDir = require('os').homedir();
  const configPath = path.join(homeDir, '.claude', 'cache-fix-vscode-config.json');
  const settings = {
    debug: config.get('debug', false),
    stripGitStatus: config.get('stripGitStatus', false),
    outputEfficiencyReplacement: config.get('outputEfficiencyReplacement', ''),
    imageKeepLast: config.get('imageKeepLast', 0),
    normalizeIdentity: config.get('normalizeIdentity', false),
    normalizeCwd: config.get('normalizeCwd', false),
    normalizeSmoosh: config.get('normalizeSmoosh', false),
    prefixDiff: config.get('prefixDiff', false),
    skipRelocate: config.get('skipRelocate', false),
    skipFingerprint: config.get('skipFingerprint', false),
    skipToolSort: config.get('skipToolSort', false),
    skipTtl: config.get('skipTtl', false),
    skipSmooshSplit: config.get('skipSmooshSplit', false),
    skipSessionStartNormalize: config.get('skipSessionStartNormalize', false),
    skipContinueTrailerStrip: config.get('skipContinueTrailerStrip', false),
    skipDeferredToolsRestore: config.get('skipDeferredToolsRestore', false),
    skipReminderStrip: config.get('skipReminderStrip', false),
    skipCacheControlNormalize: config.get('skipCacheControlNormalize', false),
    skipToolUseInputNormalize: config.get('skipToolUseInputNormalize', false),
    skipCacheControlSticky: config.get('skipCacheControlSticky', false),
  };
  try {
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function activate(context) {
  // Sync settings on activation and when they change
  syncSettings();
  const PROXY_ENV_KEYS = [
    `${CONFIG_KEY}.httpsProxy`,
    `${CONFIG_KEY}.noProxy`,
    `${CONFIG_KEY}.caFile`,
    `${CONFIG_KEY}.rejectUnauthorized`,
    `${CONFIG_KEY}.autoExportCerts`,
    `${CONFIG_KEY}.certSearchPatterns`,
  ];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration(CONFIG_KEY)) syncSettings();
      // If any proxy/CA setting changed and the proxy is currently managed,
      // re-export certs (if enabled) and restart the proxy to pick up the new env.
      const proxyEnvChanged = PROXY_ENV_KEYS.some((k) => e.affectsConfiguration(k));
      if (proxyEnvChanged) {
        await maybeAutoExportCerts();
        if (proxyProcess && proxyProcess.exitCode === null) {
          getProxyChannel().appendLine(`[${new Date().toISOString()}] Proxy/CA setting changed — restarting proxy.`);
          stopProxyServer();
          await startProxyServer();
        }
      }
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_KEY}.enable`, () => enable(context)),
    vscode.commands.registerCommand(`${CONFIG_KEY}.disable`, () => disable()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.status`, () => showStatus(context)),
    vscode.commands.registerCommand(`${CONFIG_KEY}.enableProxy`, () => enableProxy()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.disableProxy`, () => disableProxy()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.openProxyLog`, async () => {
      const p = getProxyLogPath();
      if (!fs.existsSync(p)) {
        vscode.window.showInformationMessage(
          `Proxy request log not yet written (${p}). Make a Claude Code request after proxy auto-starts.`
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
      vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand(`${CONFIG_KEY}.testProxyConnection`, () => testProxyConnection()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.exportCorporateCerts`, async () => {
      const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
      const patterns = cfg.get('certSearchPatterns', ['*Zscaler*', '*Netskope*', '*Forcepoint*']);
      const out = getCorpCaBundlePath();
      const r = exportWindowsCorporateCerts(patterns, out);
      if (r.ok) {
        const setIt = await vscode.window.showInformationMessage(
          `Exported ${r.count} certificate(s) to ${out}`,
          'Use as caFile', 'Open File'
        );
        if (setIt === 'Use as caFile') {
          await cfg.update('caFile', out, vscode.ConfigurationTarget.Global);
        } else if (setIt === 'Open File') {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(out));
          vscode.window.showTextDocument(doc, { preview: false });
        }
      } else {
        vscode.window.showErrorMessage(`Cert export failed: ${r.reason || r.message || 'unknown'}`);
      }
    })
  );

  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const autoStart = cfg.get('autoStartProxy', true);
  const autoInstall = cfg.get('autoInstallInterceptor', true);

  // Mirror the bundled .exe to a stable path and repair any stale wrapper setting
  // left behind by a prior extension version. This runs BEFORE any proxy/preload branch
  // so a stale path doesn't live on past this activation.
  ensureStableWrapperCopy(context);

  // If the npm interceptor is missing and auto-install is on, pull it in via
  // whichever package manager owns the user's Node toolchain (volta if npm goes
  // through volta, else plain npm). Then continue with the proxy auto-start.
  // Wrapped in an IIFE so activate() returns synchronously.
  (async () => {
    // Auto-export Windows corporate certs (if enabled) BEFORE we compute proxy env,
    // so the resulting bundle path lands in the spawn env on first start.
    await maybeAutoExportCerts();

    let interceptorReady = isInterceptorInstalled();
    if (!interceptorReady && autoStart && autoInstall) {
      const r = await installInterceptor('installing claude-code-cache-fix');
      interceptorReady = r.ok && isInterceptorInstalled();
      if (!interceptorReady) {
        vscode.window.showWarningMessage(
          `Claude Code Cache Fix: auto-install failed (${r.reason || 'unknown'}). Run \`npm install -g claude-code-cache-fix@latest\` (or \`volta install claude-code-cache-fix@latest\`) manually.`
        );
      }
    }

    // Self-patch the upstream pipeline.mjs Windows path bug if needed. Idempotent.
    if (interceptorReady) {
      const pipelineFix = patchPipelineMjsIfNeeded();
      if (pipelineFix.patched) {
        getProxyChannel().appendLine(
          `[${new Date().toISOString()}] Patched upstream pipeline.mjs Windows path bug (pathToFileURL). ` +
          `Tracking: ANTHROPIC_BASE_URL still works, all 8 cache-fix extensions now load.`
        );
        if (pipelineFix.restart) {
          getProxyChannel().appendLine(`[${new Date().toISOString()}] Restarting proxy to pick up the patched pipeline.`);
          stopProxyServer();
        }
      } else if (pipelineFix.reason && pipelineFix.reason !== 'already patched' && pipelineFix.reason !== 'not windows' && pipelineFix.reason !== 'buggy line not found (upstream may have fixed)') {
        getProxyChannel().appendLine(`[${new Date().toISOString()}] Pipeline patch skipped: ${pipelineFix.reason}`);
      }
    }

    const proxyTakingOver = autoStart && interceptorReady && !!getProxyServerPath();
    await reconcileWrapperSetting(context, { proxyTakingOver }).catch(() => {});

    if (proxyTakingOver) {
      try { await enableProxy({ silent: true }); }
      catch (err) { getProxyChannel().appendLine(`[${new Date().toISOString()}] Auto-start failed: ${err && err.message}`); }
    } else if (isProxyEnabled() && interceptorReady) {
      const r = await startProxyServer();
      if (r.status === 'spawn-failed' || r.status === 'crashed' || r.status === 'not-found') {
        vscode.window.showWarningMessage(
          `Claude Code Cache Fix: proxy mode is enabled but the server could not start (${r.status}). Check the "Claude Code Cache Fix — Proxy" output channel.`
        );
      }
    }

    // Preload-wrapper auto-enable: only if proxy mode is NOT active.
    if (!autoStart && !isEnabled() && !isProxyEnabled() && interceptorReady && isClaudeCodeInstalled()) {
      const wrapperPath = getWrapperPath(context);
      if (wrapperPath) enable(context);
    }
  })().catch((err) => {
    getProxyChannel().appendLine(`[${new Date().toISOString()}] activate IIFE error: ${err && err.message}`);
  });
}

function deactivate() {
  stopProxyServer();
  if (proxyChannel) {
    try { proxyChannel.dispose(); } catch {}
    proxyChannel = null;
  }
}

module.exports = { activate, deactivate };
