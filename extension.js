const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execSync, spawn } = require('child_process');

// Legacy preload-mode setting we still touch only to clear stale entries left
// by 0.6.x. v0.7.0 dropped wrapper support entirely; there is no scenario where
// we want this to be set by us anymore.
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
 * Pick the package manager to use for installing claude-code-cache-fix.
 * Volta wins if both `volta` is on PATH AND `npm` resolves to a Volta-managed binary
 * (i.e. the user's whole Node toolchain is Volta — `npm install -g` would still work
 * but bypasses Volta's tracking, so we'd be silently inconsistent with `volta list`).
 */
function detectInstallerForPackage() {
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
async function installPackage(reason) {
  const installer = detectInstallerForPackage();
  if (!installer) {
    return { ok: false, reason: 'neither volta nor npm on PATH' };
  }
  const channel = getProxyChannel();
  const cmdline = `${installer.cmd} ${installer.args.join(' ')}`;
  channel.appendLine(`[${new Date().toISOString()}] Auto-install (${reason}): ${cmdline}`);
  // Reset caches so post-install the new path is picked up.
  _npmRoot = null;
  _packageDir = null;

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

  // v3.1.0 env-var-controlled extensions (not in extensions.json)
  if (cfg.get('prefixDiff', false)) {
    env.CACHE_FIX_PREFIXDIFF = '1';
  }
  if (cfg.get('skipDeferredToolsRestore', false)) {
    env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE = '1';
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
          const dir = getPackageDir();
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
  const dir = getPackageDir();
  if (!dir) return { patched: false, restart: false, reason: 'package dir not found' };
  const p = path.join(dir, 'proxy', 'pipeline.mjs');
  if (!fs.existsSync(p)) return { patched: false, restart: false, reason: 'pipeline.mjs not found' };
  let src;
  try { src = fs.readFileSync(p, 'utf-8'); }
  catch (err) { return { patched: false, restart: false, reason: `read failed: ${err.message}` }; }
  if (src.includes('pathToFileURL(') && src.includes('await import(pathToFileURL')) {
    return { patched: false, restart: false, reason: 'already patched' };
  }
  // The buggy form on @<=3.0.1: `await import(join(dir, file))`
  const buggy = 'await import(join(';
  if (!src.includes(buggy)) {
    return { patched: false, restart: false, reason: 'buggy line not found (upstream may have fixed)' };
  }
  // Inject the import for pathToFileURL if missing.
  if (!/pathToFileURL/.test(src)) {
    src = src.replace(/import\s*\{([^}]*)\}\s*from\s*['"]url['"]\s*;?/,
      (m, names) => `import { ${names.includes('pathToFileURL') ? names : names.trim() + ', pathToFileURL'} } from 'url';`);
    if (!/pathToFileURL/.test(src)) {
      src = `import { pathToFileURL } from 'url';\n` + src;
    }
  }
  src = src.split('await import(join(').join('await import(pathToFileURL(join(');
  // Close the extra paren we just opened. Convert `import(pathToFileURL(join(a, b))` → add `.href)`
  // The original line was `await import(join(a, b));` → now `await import(pathToFileURL(join(a, b)).href);`
  src = src.replace(/await import\(pathToFileURL\(join\(([^)]+)\)\)/g, 'await import(pathToFileURL(join($1)).href)');

  try { fs.writeFileSync(p, src, 'utf-8'); }
  catch (err) { return { patched: false, restart: false, reason: `write failed: ${err.message}` }; }
  // If the proxy is already running it loaded the broken module — needs respawn.
  const restart = !!(proxyProcess && proxyProcess.exitCode === null);
  return { patched: true, restart, reason: null };
}

/**
 * Sync our override of the proxy's extensions.json to v3.1.0 defaults, with VS Code
 * settings flipping individual extensions off when the user requested the "skip"
 * variant. Forces `request-log: enabled=true` so the proxy emits NDJSON telemetry
 * for every stream event (upstream defaults this to off; we want it on for the
 * "Open Proxy Request Log" command to do anything useful).
 *
 * Rewritten on each activate so upstream changes don't drift our override silently
 * and so users can flip a setting and see the effect on next proxy restart.
 *
 * Mapping: VS Code setting → extension key
 *   skipFingerprint            → fingerprint-strip
 *   skipToolSort               → sort-stabilization
 *   skipSessionStartNormalize  → fresh-session-sort
 *   skipSmooshSplit            → smoosh-split            (v3.1.0 default-on)
 *   skipContentStrip           → content-strip           (v3.1.0 default-on)
 *   skipToolInputNormalize     → tool-input-normalize    (v3.1.0 default-on)
 *   skipCacheControlNormalize  → cache-control-normalize
 *   skipTtl                    → ttl-management
 * (identity-normalization is always on; cache-telemetry is always on.)
 */
function ensureProxyExtensionsConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_KEY);
  const enabled = (skipKey) => !cfg.get(skipKey, false);
  const config = {
    'fingerprint-strip':       { enabled: enabled('skipFingerprint'),           order: 100 },
    'sort-stabilization':      { enabled: enabled('skipToolSort'),              order: 200 },
    'fresh-session-sort':      { enabled: enabled('skipSessionStartNormalize'), order: 250 },
    'identity-normalization':  { enabled: true,                                 order: 300 },
    'smoosh-split':            { enabled: enabled('skipSmooshSplit'),           order: 320 },
    'content-strip':           { enabled: enabled('skipContentStrip'),          order: 330 },
    'tool-input-normalize':    { enabled: enabled('skipToolInputNormalize'),    order: 340 },
    'cache-control-normalize': { enabled: enabled('skipCacheControlNormalize'), order: 400 },
    'ttl-management':          { enabled: enabled('skipTtl'),                   order: 500 },
    'cache-telemetry':         { enabled: true,                                 order: 600 },
    'request-log':             { enabled: true,                                 order: 700 },
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
  if (proxyCfg.env.CACHE_FIX_PREFIXDIFF) {
    channel.appendLine(`[${new Date().toISOString()}] prefix-diff snapshots enabled (~/.claude/cache-fix-snapshots/)`);
  }
  if (proxyCfg.env.CACHE_FIX_SKIP_DEFERRED_TOOLS_RESTORE) {
    channel.appendLine(`[${new Date().toISOString()}] deferred-tools-restore SKIPPED (skipDeferredToolsRestore=true)`);
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
let _packageDir = null;
function getPackageDir() {
  if (_packageDir) return _packageDir;
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
      _packageDir = p;
      return p;
    }
  }
  return null;
}

/**
 * Check if claude-code-cache-fix is installed AND ships the proxy server (v3.0.1+).
 * v0.7.0 only supports proxy mode — older packages without proxy/server.mjs are
 * effectively useless and we treat them as not-installed so auto-install kicks in.
 */
function isPackageInstalled() {
  return !!getProxyServerPath();
}

/**
 * Get the path to the proxy server script (proxy/server.mjs), or null.
 */
function getProxyServerPath() {
  const dir = getPackageDir();
  if (!dir) return null;
  const proxyPath = path.join(dir, 'proxy', 'server.mjs');
  if (fs.existsSync(proxyPath)) return proxyPath;
  return null;
}

/**
 * Clear any leftover claudeCode.claudeProcessWrapper that we (a prior 0.6.x version
 * of this extension) wrote. v0.7.0 dropped wrapper support entirely — proxy mode is
 * the only mode now. Only touches the setting if the value clearly belongs to us.
 */
async function clearOurWrapperSetting() {
  const config = vscode.workspace.getConfiguration();
  const current = config.get(WRAPPER_SETTING);
  if (typeof current !== 'string' || !current) return;
  const lc = current.toLowerCase();
  const looksLikeOurs =
    (lc.includes('claude-code-cache-fix') &&
      (lc.includes('.vscode\\extensions') || lc.includes('.vscode-insiders\\extensions') || lc.includes('cursor\\extensions') || lc.includes('cache-fix-bin')));
  if (!looksLikeOurs) return;
  await config.update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
  getProxyChannel().appendLine(
    `[${new Date().toISOString()}] Cleared legacy claudeCode.claudeProcessWrapper (was: ${current}). v0.7.0 dropped preload mode.`
  );
}

/**
 * Show current status.
 */
async function showStatus() {
  const installed = isPackageInstalled();
  const proxyEnabled = isProxyEnabled();
  const proxyPath = getProxyServerPath();
  const proxyListening = await probeProxyRunning(500);
  const proxyManaged = proxyProcess && proxyProcess.exitCode === null;
  const corpEnv = computeProxyEnv().summary;
  const caFileExists = corpEnv.caFile ? fs.existsSync(corpEnv.caFile) : false;

  const lines = [
    `Platform: ${process.platform}`,
    `claude-code-cache-fix npm package: ${installed ? 'installed (proxy server present)' : 'NOT INSTALLED'}`,
    `Mode: ${proxyEnabled ? 'Proxy' : 'Disabled'}`,
    proxyEnabled ? `Proxy URL: ${DEFAULT_PROXY_URL}` : '',
    `Proxy script: ${proxyPath ? proxyPath : 'Not found (run npm install -g claude-code-cache-fix@latest)'}`,
    `Proxy listening: ${proxyListening ? 'Yes' : 'No'}${proxyManaged ? ' (managed by extension)' : proxyListening ? ' (external process)' : ''}`,
    `Corp HTTP proxy: ${corpEnv.httpsProxy || '(none)'}`,
    `NO_PROXY: ${corpEnv.noProxy || '(none)'}`,
    `CA file: ${corpEnv.caFile || '(system default)'}${corpEnv.caFile ? (caFileExists ? ' OK' : ' MISSING') : ''}`,
    `TLS verify: ${corpEnv.rejectUnauthorized ? 'enabled' : 'DISABLED (insecure)'}`,
  ].filter(Boolean);

  vscode.window.showInformationMessage('Cache Fix Status:\n' + lines.join('\n'));
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
 * Enable proxy mode by setting ANTHROPIC_BASE_URL in Claude Code env vars.
 * @param {{silent?: boolean}} opts - silent mode suppresses popups and skips the external-URL prompt
 */
async function enableProxy(opts = {}) {
  const silent = !!opts.silent;

  if (!isPackageInstalled()) {
    if (silent) return;
    const action = await vscode.window.showWarningMessage(
      'claude-code-cache-fix npm package not found (v3.0.1+ required). Install with: npm install -g claude-code-cache-fix',
      'Copy Install Command'
    );
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText('npm install -g claude-code-cache-fix');
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

function activate(context) {
  // Restart proxy when any setting that feeds spawn env / extensions config changes,
  // so users see their toggle take effect on save without a VS Code restart.
  const RESTART_KEYS = [
    `${CONFIG_KEY}.httpsProxy`,
    `${CONFIG_KEY}.noProxy`,
    `${CONFIG_KEY}.caFile`,
    `${CONFIG_KEY}.rejectUnauthorized`,
    `${CONFIG_KEY}.autoExportCerts`,
    `${CONFIG_KEY}.certSearchPatterns`,
    `${CONFIG_KEY}.skipFingerprint`,
    `${CONFIG_KEY}.skipToolSort`,
    `${CONFIG_KEY}.skipSessionStartNormalize`,
    `${CONFIG_KEY}.skipSmooshSplit`,
    `${CONFIG_KEY}.skipContentStrip`,
    `${CONFIG_KEY}.skipToolInputNormalize`,
    `${CONFIG_KEY}.skipCacheControlNormalize`,
    `${CONFIG_KEY}.skipTtl`,
    `${CONFIG_KEY}.skipDeferredToolsRestore`,
    `${CONFIG_KEY}.prefixDiff`,
  ];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      const restartNeeded = RESTART_KEYS.some((k) => e.affectsConfiguration(k));
      if (!restartNeeded) return;
      await maybeAutoExportCerts();
      if (proxyProcess && proxyProcess.exitCode === null) {
        getProxyChannel().appendLine(`[${new Date().toISOString()}] Setting changed — restarting proxy.`);
        stopProxyServer();
        await startProxyServer();
      }
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_KEY}.status`, () => showStatus()),
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

  // v0.7.0 dropped wrapper/preload support. Clear any leftover wrapper setting we
  // wrote in 0.6.x so it doesn't keep pointing at a now-deleted .exe inside a stale
  // versioned extension folder.
  clearOurWrapperSetting().catch(() => {});

  // Wrapped in an IIFE so activate() returns synchronously.
  (async () => {
    // Auto-export Windows corporate certs (if enabled) BEFORE we compute proxy env,
    // so the resulting bundle path lands in the spawn env on first start.
    await maybeAutoExportCerts();

    let packageReady = isPackageInstalled();
    if (!packageReady && autoStart && autoInstall) {
      const r = await installPackage('installing claude-code-cache-fix');
      packageReady = r.ok && isPackageInstalled();
      if (!packageReady) {
        vscode.window.showWarningMessage(
          `Claude Code Cache Fix: auto-install failed (${r.reason || 'unknown'}). Run \`npm install -g claude-code-cache-fix@latest\` (or \`volta install claude-code-cache-fix@latest\`) manually.`
        );
      }
    }

    // Self-patch the upstream pipeline.mjs Windows path bug if needed. Idempotent.
    if (packageReady) {
      const pipelineFix = patchPipelineMjsIfNeeded();
      if (pipelineFix.patched) {
        getProxyChannel().appendLine(
          `[${new Date().toISOString()}] Patched upstream pipeline.mjs Windows path bug (pathToFileURL).`
        );
        if (pipelineFix.restart) {
          getProxyChannel().appendLine(`[${new Date().toISOString()}] Restarting proxy to pick up the patched pipeline.`);
          stopProxyServer();
        }
      } else if (pipelineFix.reason && pipelineFix.reason !== 'already patched' && pipelineFix.reason !== 'not windows' && pipelineFix.reason !== 'buggy line not found (upstream may have fixed)') {
        getProxyChannel().appendLine(`[${new Date().toISOString()}] Pipeline patch skipped: ${pipelineFix.reason}`);
      }
    }

    if (autoStart && packageReady) {
      try { await enableProxy({ silent: true }); }
      catch (err) { getProxyChannel().appendLine(`[${new Date().toISOString()}] Auto-start failed: ${err && err.message}`); }
    } else if (isProxyEnabled() && packageReady) {
      const r = await startProxyServer();
      if (r.status === 'spawn-failed' || r.status === 'crashed' || r.status === 'not-found') {
        vscode.window.showWarningMessage(
          `Claude Code Cache Fix: proxy mode is enabled but the server could not start (${r.status}). Check the "Claude Code Cache Fix — Proxy" output channel.`
        );
      }
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
