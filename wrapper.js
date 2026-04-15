#!/usr/bin/env node
/**
 * Claude Code process wrapper for VS Code extension.
 *
 * This script is set as claudeCode.claudeProcessWrapper by the extension.
 * VS Code's Claude extension calls:
 *   spawn(wrapper, [originalClaudePath, ...args])
 *
 * We skip argv[2] (the original claude path), set NODE_OPTIONS to load
 * the cache-fix interceptor, and spawn node with cli.js directly.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Find npm global root
let npmRoot;
try {
  npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
} catch {
  // Fallback for common locations
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  npmRoot = candidates.find(p => fs.existsSync(path.join(p, 'claude-code-cache-fix')));
  if (!npmRoot) {
    process.stderr.write('claude-code-cache-fix: cannot find npm global root. Install with: npm install -g claude-code-cache-fix\n');
    process.exit(1);
  }
}

const preloadPath = path.join(npmRoot, 'claude-code-cache-fix', 'preload.mjs');
const cliPath = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');

if (!fs.existsSync(preloadPath)) {
  process.stderr.write(`claude-code-cache-fix: preload not found at ${preloadPath}\nInstall with: npm install -g claude-code-cache-fix\n`);
  process.exit(1);
}

if (!fs.existsSync(cliPath)) {
  process.stderr.write(`claude-code-cache-fix: Claude Code CLI not found at ${cliPath}\nInstall with: npm install -g @anthropic-ai/claude-code\n`);
  process.exit(1);
}

// Build file:// URL with forward slashes and space encoding
let preloadUrl = preloadPath.replace(/\\/g, '/');
preloadUrl = preloadUrl.replace(/ /g, '%20');
if (!preloadUrl.startsWith('/')) preloadUrl = '/' + preloadUrl;

// Read VS Code settings from a config file the extension writes on enable
// This bridges VS Code settings into env vars for the interceptor
const configPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'cache-fix-vscode-config.json');
try {
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.debug) process.env.CACHE_FIX_DEBUG = '1';
    if (config.stripGitStatus) process.env.CACHE_FIX_STRIP_GIT_STATUS = '1';
    if (config.outputEfficiencyReplacement) process.env.CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT = config.outputEfficiencyReplacement;
    if (config.imageKeepLast > 0) process.env.CACHE_FIX_IMAGE_KEEP_LAST = String(config.imageKeepLast);
  }
} catch {}

// Set NODE_OPTIONS
const existingOpts = process.env.NODE_OPTIONS || '';
process.env.NODE_OPTIONS = `--import file://${preloadUrl} ${existingOpts}`.trim();

// Skip argv[2] (original claude path passed by the extension)
// argv[0] = node, argv[1] = this script, argv[2] = original claude, argv[3+] = actual args
const args = [cliPath, ...process.argv.slice(3)];

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  process.stderr.write(`claude-code-cache-fix wrapper error: ${err.message}\n`);
  process.exit(1);
});
