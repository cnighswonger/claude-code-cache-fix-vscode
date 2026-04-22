const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const WRAPPER_SETTING = 'claudeCode.claudeProcessWrapper';
const ENV_SETTING = 'claudeCode.environmentVariables';
const CONFIG_KEY = 'claude-code-cache-fix';
const DEFAULT_PROXY_URL = 'http://127.0.0.1:9801';

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
 * Check if the interceptor npm package is installed globally.
 */
function isInterceptorInstalled() {
  const npmRoot = getNpmRoot();
  if (!npmRoot) return false;
  return fs.existsSync(path.join(npmRoot, 'claude-code-cache-fix', 'preload.mjs'));
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
 * Get the path to the appropriate wrapper for this platform.
 * Windows: bundled .exe native bridge
 * Linux/macOS: wrapper.js (Node.js script)
 */
function getWrapperPath(context) {
  if (process.platform === 'win32') {
    // Windows needs a native .exe because spawn() doesn't support .js/.bat
    // Check npm global first — stable across extension updates
    const npmRoot = getNpmRoot();
    if (npmRoot) {
      const npmExe = path.join(npmRoot, 'claude-code-cache-fix', 'tools', 'ClaudeCodeCacheFixWrapper.exe');
      if (fs.existsSync(npmExe)) return npmExe;
    }
    // Fallback: bundled in extension directory (changes on every update)
    const exePath = path.join(context.extensionPath, 'ClaudeCodeCacheFixWrapper.exe');
    if (fs.existsSync(exePath)) {
      return exePath;
    }
    return null; // No exe available
  }
  return path.join(context.extensionPath, 'wrapper.js');
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

  const wrapperPath = getWrapperPath(context);

  // Windows-specific: need the .exe bridge
  if (process.platform === 'win32' && !wrapperPath) {
    const action = await vscode.window.showWarningMessage(
      'Windows requires a native .exe wrapper. Compile it from the C source in the claude-code-cache-fix package, or download from GitHub Releases.',
      'Copy Compile Command', 'Open Releases'
    );
    if (action === 'Copy Compile Command') {
      const npmRoot = getNpmRoot();
      const src = npmRoot ? path.join(npmRoot, 'claude-code-cache-fix', 'tools', 'claude-vscode-wrapper.c') : 'claude-vscode-wrapper.c';
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

  const lines = [
    `Platform: ${process.platform}`,
    `Interceptor installed: ${interceptorInstalled ? 'Yes' : 'No'}`,
    `Claude Code (npm) installed: ${ccInstalled ? 'Yes' : 'No'}`,
    `Mode: ${proxyEnabled ? 'Proxy' : enabled ? 'Preload (wrapper)' : 'Disabled'}`,
    proxyEnabled ? `Proxy URL: ${DEFAULT_PROXY_URL}` : `Wrapper path: ${wrapperPath || 'Not available'}`,
    `Proxy server: ${proxyPath ? 'Available (v3.0.1+)' : 'Not found (update npm package)'}`,
  ];

  vscode.window.showInformationMessage('Cache Fix Status:\n' + lines.join('\n') + statsInfo);
}

/**
 * Check if proxy mode is currently enabled.
 */
function isProxyEnabled() {
  const config = vscode.workspace.getConfiguration();
  const envVars = config.get(ENV_SETTING);
  return envVars && envVars.ANTHROPIC_BASE_URL && envVars.ANTHROPIC_BASE_URL.includes('127.0.0.1');
}

/**
 * Get the path to the proxy server script.
 */
function getProxyServerPath() {
  const npmRoot = getNpmRoot();
  if (!npmRoot) return null;
  const proxyPath = path.join(npmRoot, 'claude-code-cache-fix', 'proxy', 'server.mjs');
  if (fs.existsSync(proxyPath)) return proxyPath;
  return null;
}

/**
 * Enable proxy mode by setting ANTHROPIC_BASE_URL in Claude Code env vars.
 */
async function enableProxy() {
  if (!isInterceptorInstalled()) {
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
    vscode.window.showWarningMessage(
      'Proxy server not found. Update to v3.0.1+: npm install -g claude-code-cache-fix@latest'
    );
    return;
  }

  const config = vscode.workspace.getConfiguration();
  const envVars = config.get(ENV_SETTING) || {};

  if (envVars.ANTHROPIC_BASE_URL && !envVars.ANTHROPIC_BASE_URL.includes('127.0.0.1')) {
    const choice = await vscode.window.showWarningMessage(
      `ANTHROPIC_BASE_URL is already set to: ${envVars.ANTHROPIC_BASE_URL}. Replace with proxy?`,
      'Replace', 'Cancel'
    );
    if (choice !== 'Replace') return;
  }

  envVars.ANTHROPIC_BASE_URL = DEFAULT_PROXY_URL;
  await config.update(ENV_SETTING, envVars, vscode.ConfigurationTarget.Global);

  const action = await vscode.window.showInformationMessage(
    `Proxy mode enabled (${DEFAULT_PROXY_URL}). Start the proxy server, then restart any active Claude Code session.`,
    'Copy Start Command'
  );
  if (action === 'Copy Start Command') {
    await vscode.env.clipboard.writeText(`node "${proxyPath}" &`);
    vscode.window.showInformationMessage('Proxy start command copied to clipboard.');
  }
}

/**
 * Disable proxy mode by removing ANTHROPIC_BASE_URL.
 */
async function disableProxy() {
  const config = vscode.workspace.getConfiguration();
  const envVars = config.get(ENV_SETTING) || {};

  if (!envVars.ANTHROPIC_BASE_URL) {
    vscode.window.showInformationMessage('Proxy mode is not currently enabled.');
    return;
  }

  delete envVars.ANTHROPIC_BASE_URL;
  const hasOtherVars = Object.keys(envVars).length > 0;
  await config.update(ENV_SETTING, hasOtherVars ? envVars : undefined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'Proxy mode disabled. Restart any active Claude Code session to apply.'
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
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CONFIG_KEY)) syncSettings();
    })
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_KEY}.enable`, () => enable(context)),
    vscode.commands.registerCommand(`${CONFIG_KEY}.disable`, () => disable()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.status`, () => showStatus(context)),
    vscode.commands.registerCommand(`${CONFIG_KEY}.enableProxy`, () => enableProxy()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.disableProxy`, () => disableProxy())
  );

  // Auto-enable on first install if interceptor is available
  // Skip auto-enable on Windows without .exe — user needs to set up the bridge first
  if (!isEnabled() && isInterceptorInstalled() && isClaudeCodeInstalled()) {
    const wrapperPath = getWrapperPath(context);
    if (wrapperPath) {
      enable(context);
    } else if (process.platform === 'win32') {
      vscode.window.showInformationMessage(
        'Claude Code Cache Fix: Windows requires a native .exe wrapper for VS Code integration. See the Enable command for setup instructions.'
      );
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
