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

// Resolve Claude Code CLI path
// Priority: env override → Volta packages tree → npm root -g → common fallbacks
function resolveCliPath() {
  // 1. Explicit env override (escape hatch for any Node manager)
  if (process.env.CLAUDE_CODE_CACHE_FIX_CLI_JS) {
    const p = process.env.CLAUDE_CODE_CACHE_FIX_CLI_JS;
    if (fs.existsSync(p)) return p;
    process.stderr.write(`claude-code-cache-fix: CLAUDE_CODE_CACHE_FIX_CLI_JS path not found: ${p}\n`);
  }

  // 2. Volta packages tree (Volta keeps current version here, npm root -g hits stale tree)
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    const voltaPath = path.join(localAppData, 'Volta', 'tools', 'image', 'packages',
      '@anthropic-ai', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(voltaPath)) return voltaPath;
  }

  // 3. npm root -g (standard path for npm, nvm, fnm)
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const npmPath = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(npmPath)) return npmPath;
  } catch {}

  // 4. Common fallback locations
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  for (const dir of candidates) {
    const p = path.join(dir, '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// Resolve preload path (same priority minus Volta — cache-fix is always via npm)
function resolvePreloadPath() {
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const p = path.join(npmRoot, 'claude-code-cache-fix', 'preload.mjs');
    if (fs.existsSync(p)) return p;
  } catch {}

  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  for (const dir of candidates) {
    const p = path.join(dir, 'claude-code-cache-fix', 'preload.mjs');
    if (fs.existsSync(p)) return p;
  }

  return null;
}

const cliPath = resolveCliPath();
const preloadPath = resolvePreloadPath();

if (!preloadPath) {
  process.stderr.write('claude-code-cache-fix: preload.mjs not found.\nInstall with: npm install -g claude-code-cache-fix\n');
  process.exit(1);
}

if (!cliPath) {
  process.stderr.write('claude-code-cache-fix: Claude Code cli.js not found.\nInstall with: npm install -g @anthropic-ai/claude-code\nVolta users: volta install @anthropic-ai/claude-code\nOr set CLAUDE_CODE_CACHE_FIX_CLI_JS to the path.\n');
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
