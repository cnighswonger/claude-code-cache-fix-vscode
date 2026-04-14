const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const WRAPPER_SETTING = 'claudeCode.claudeProcessWrapper';
const CONFIG_KEY = 'claude-code-cache-fix';

/**
 * Get the path to our bundled wrapper.js
 */
function getWrapperPath(context) {
  return path.join(context.extensionPath, 'wrapper.js');
}

/**
 * Check if the interceptor npm package is installed globally.
 */
function isInterceptorInstalled() {
  try {
    const { execSync } = require('child_process');
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    return fs.existsSync(path.join(npmRoot, 'claude-code-cache-fix', 'preload.mjs'));
  } catch {
    return false;
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
  if (!isInterceptorInstalled()) {
    const action = await vscode.window.showWarningMessage(
      'claude-code-cache-fix npm package not found. Install it first.',
      'Copy Install Command'
    );
    if (action === 'Copy Install Command') {
      await vscode.env.clipboard.writeText('npm install -g claude-code-cache-fix');
      vscode.window.showInformationMessage('Install command copied to clipboard.');
    }
    return;
  }

  const wrapperPath = getWrapperPath(context);
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
  const installed = isInterceptorInstalled();
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

  vscode.window.showInformationMessage(
    `Cache Fix Status:\n` +
    `  Interceptor installed: ${installed ? 'Yes' : 'No'}\n` +
    `  Wrapper enabled: ${enabled ? 'Yes' : 'No'}\n` +
    `  Wrapper path: ${wrapperPath}` +
    statsInfo
  );
}

function activate(context) {
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_KEY}.enable`, () => enable(context)),
    vscode.commands.registerCommand(`${CONFIG_KEY}.disable`, () => disable()),
    vscode.commands.registerCommand(`${CONFIG_KEY}.status`, () => showStatus(context))
  );

  // Auto-enable on first install if interceptor is available
  if (!isEnabled() && isInterceptorInstalled()) {
    enable(context);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
