const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const CONFIG_KEY = 'claude-code-proxy-config';
let outputChannel = null;

function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Claude Code Proxy Config');
  }
  return outputChannel;
}

function log(message) {
  const channel = getOutputChannel();
  channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Get the config value, with fallback to environment variable
 */
function getConfigValue(config, key, envNames = []) {
  const value = config.get(key);
  if (value) return value;
  
  for (const envName of envNames) {
    const envValue = process.env[envName];
    if (envValue) return envValue;
  }
  return '';
}

/**
 * Export certificates from Windows certificate store to a PEM file
 */
function exportWindowsCerts(patterns, outputPath) {
  if (process.platform !== 'win32') {
    return { success: false, error: 'Only supported on Windows' };
  }

  const patternsArg = patterns.map(p => `"${p}"`).join(',');
  
  const script = `
$patterns = @(${patternsArg})
$allCerts = @()
foreach ($pattern in $patterns) {
  $allCerts += Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Subject -like $pattern }
  $allCerts += Get-ChildItem Cert:\\LocalMachine\\CA | Where-Object { $_.Subject -like $pattern }
}
$allCerts = $allCerts | Sort-Object -Property Thumbprint -Unique
$pemContent = ""
foreach ($cert in $allCerts) {
  $pemContent += "# Subject: $($cert.Subject)\`n"
  $pemContent += "-----BEGIN CERTIFICATE-----\`n"
  $pemContent += [Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
  $pemContent += "\`n-----END CERTIFICATE-----\`n\`n"
}
if ($allCerts.Count -gt 0) {
  $pemContent | Out-File -FilePath "${outputPath.replace(/\\/g, '\\\\')}" -Encoding ascii -NoNewline
  Write-Output "Exported $($allCerts.Count) certificates"
} else {
  Write-Output "No matching certificates found"
}
`;

  try {
    const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    
    if (result.includes('Exported')) {
      return { success: true, message: result };
    } else {
      return { success: false, error: result };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Apply proxy configuration to environment
 */
function applyConfiguration() {
  const config = vscode.workspace.getConfiguration(CONFIG_KEY);
  
  const httpsProxy = getConfigValue(config, 'httpsProxy', ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
  const noProxy = config.get('noProxy') || 'localhost,127.0.0.1,::1,.local';
  const caFile = getConfigValue(config, 'caFile', ['CACHE_FIX_PROXY_CA_FILE', 'NODE_EXTRA_CA_CERTS']);
  const rejectUnauthorized = config.get('rejectUnauthorized');

  // Set environment variables that the cache-fix proxy will read
  if (httpsProxy) {
    process.env.HTTPS_PROXY = httpsProxy;
    process.env.HTTP_PROXY = httpsProxy;
    log(`Set HTTPS_PROXY=${httpsProxy}`);
  }
  
  if (noProxy) {
    process.env.NO_PROXY = noProxy;
    log(`Set NO_PROXY=${noProxy}`);
  }
  
  if (caFile) {
    process.env.CACHE_FIX_PROXY_CA_FILE = caFile;
    process.env.NODE_EXTRA_CA_CERTS = caFile;
    log(`Set CACHE_FIX_PROXY_CA_FILE=${caFile}`);
  }
  
  if (!rejectUnauthorized) {
    process.env.CACHE_FIX_PROXY_REJECT_UNAUTHORIZED = '0';
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    log('WARNING: TLS verification disabled!');
  }
  
  return { httpsProxy, noProxy, caFile, rejectUnauthorized };
}

/**
 * Auto-export certificates if configured
 */
async function autoExportCerts() {
  const config = vscode.workspace.getConfiguration(CONFIG_KEY);
  
  if (!config.get('autoExportCerts')) return;
  if (process.platform !== 'win32') return;
  
  const patterns = config.get('certSearchPatterns') || ['*Zscaler*'];
  const homeDir = require('os').homedir();
  const outputPath = path.join(homeDir, 'claude-proxy-ca-bundle.pem');
  
  log(`Auto-exporting certificates matching: ${patterns.join(', ')}`);
  const result = exportWindowsCerts(patterns, outputPath);
  
  if (result.success) {
    log(result.message);
    
    // Update the caFile setting if not already set
    const currentCaFile = config.get('caFile');
    if (!currentCaFile) {
      await config.update('caFile', outputPath, vscode.ConfigurationTarget.Global);
      log(`Updated caFile setting to: ${outputPath}`);
    }
  } else {
    log(`Certificate export failed: ${result.error}`);
  }
}

/**
 * Show current proxy configuration status
 */
function showStatus() {
  const config = vscode.workspace.getConfiguration(CONFIG_KEY);
  
  const httpsProxy = getConfigValue(config, 'httpsProxy', ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
  const noProxy = config.get('noProxy') || process.env.NO_PROXY || '';
  const caFile = getConfigValue(config, 'caFile', ['CACHE_FIX_PROXY_CA_FILE', 'NODE_EXTRA_CA_CERTS']);
  const rejectUnauthorized = config.get('rejectUnauthorized');
  
  const caFileExists = caFile ? fs.existsSync(caFile) : false;
  
  const lines = [
    `Platform: ${process.platform}`,
    ``,
    `Proxy Configuration:`,
    `  HTTPS_PROXY: ${httpsProxy || '(not set)'}`,
    `  NO_PROXY: ${noProxy || '(not set)'}`,
    `  CA File: ${caFile || '(not set)'}${caFile ? (caFileExists ? ' ✓' : ' ✗ FILE NOT FOUND') : ''}`,
    `  TLS Verify: ${rejectUnauthorized ? 'enabled' : 'DISABLED (insecure!)'}`,
    ``,
    `Environment Variables (effective):`,
    `  HTTPS_PROXY: ${process.env.HTTPS_PROXY || '(not set)'}`,
    `  NO_PROXY: ${process.env.NO_PROXY || '(not set)'}`,
    `  CACHE_FIX_PROXY_CA_FILE: ${process.env.CACHE_FIX_PROXY_CA_FILE || '(not set)'}`,
    `  NODE_EXTRA_CA_CERTS: ${process.env.NODE_EXTRA_CA_CERTS || '(not set)'}`,
  ];
  
  const channel = getOutputChannel();
  channel.appendLine('--- Proxy Configuration Status ---');
  lines.forEach(line => channel.appendLine(line));
  channel.appendLine('---');
  channel.show();
  
  vscode.window.showInformationMessage(
    `Proxy: ${httpsProxy || 'none'} | CA: ${caFile ? (caFileExists ? '✓' : '✗') : 'none'} | TLS: ${rejectUnauthorized ? '✓' : '✗'}`,
    'Show Details'
  ).then(choice => {
    if (choice === 'Show Details') channel.show();
  });
}

/**
 * Test connection to Anthropic API through the configured proxy
 */
async function testConnection() {
  const config = vscode.workspace.getConfiguration(CONFIG_KEY);
  const channel = getOutputChannel();
  
  channel.appendLine('--- Connection Test ---');
  channel.show();
  
  const httpsProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const caFile = process.env.CACHE_FIX_PROXY_CA_FILE || process.env.NODE_EXTRA_CA_CERTS;
  const rejectUnauthorized = config.get('rejectUnauthorized');
  
  channel.appendLine(`Testing connection to api.anthropic.com...`);
  channel.appendLine(`  Using proxy: ${httpsProxy || 'direct'}`);
  channel.appendLine(`  CA file: ${caFile || 'system default'}`);
  channel.appendLine(`  TLS verify: ${rejectUnauthorized}`);
  
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing Anthropic API connection...' },
    async () => {
      try {
        // If proxy is configured, we need hpagent
        let agent = null;
        
        if (httpsProxy) {
          try {
            // Try to use hpagent from the cache-fix package
            const npmRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
            const hpagentPath = path.join(npmRoot, 'claude-code-cache-fix', 'node_modules', 'hpagent');
            
            if (fs.existsSync(hpagentPath)) {
              const { HttpsProxyAgent } = require(hpagentPath);
              const agentOptions = {
                keepAlive: true,
                proxy: httpsProxy,
                rejectUnauthorized: rejectUnauthorized,
              };
              if (caFile && fs.existsSync(caFile)) {
                agentOptions.ca = fs.readFileSync(caFile);
              }
              agent = new HttpsProxyAgent(agentOptions);
              channel.appendLine(`  Using hpagent from cache-fix package`);
            }
          } catch (e) {
            channel.appendLine(`  hpagent not available: ${e.message}`);
          }
        }
        
        const options = {
          hostname: 'api.anthropic.com',
          port: 443,
          path: '/',
          method: 'GET',
          timeout: 10000,
          rejectUnauthorized: rejectUnauthorized,
        };
        
        if (agent) {
          options.agent = agent;
        }
        
        if (caFile && fs.existsSync(caFile) && !agent) {
          options.ca = fs.readFileSync(caFile);
        }
        
        return new Promise((resolve) => {
          const req = https.request(options, (res) => {
            channel.appendLine(`  Response: ${res.statusCode} ${res.statusMessage}`);
            channel.appendLine(`  Server: ${res.headers['server'] || 'unknown'}`);
            channel.appendLine('--- Connection successful! ---');
            vscode.window.showInformationMessage(`Connection to Anthropic API successful (${res.statusCode})`);
            resolve();
          });
          
          req.on('error', (err) => {
            channel.appendLine(`  ERROR: ${err.message}`);
            if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'CERT_HAS_EXPIRED' || err.message.includes('certificate')) {
              channel.appendLine(`  This looks like a certificate issue. Make sure your CA file includes all corporate proxy certificates.`);
            }
            channel.appendLine('--- Connection failed ---');
            vscode.window.showErrorMessage(`Connection failed: ${err.message}`, 'Show Details').then(choice => {
              if (choice === 'Show Details') channel.show();
            });
            resolve();
          });
          
          req.on('timeout', () => {
            req.destroy();
            channel.appendLine(`  ERROR: Connection timeout`);
            channel.appendLine('--- Connection failed ---');
            vscode.window.showErrorMessage('Connection timeout. Check your proxy settings.');
            resolve();
          });
          
          req.end();
        });
      } catch (err) {
        channel.appendLine(`  ERROR: ${err.message}`);
        channel.appendLine('--- Connection failed ---');
        vscode.window.showErrorMessage(`Test failed: ${err.message}`);
      }
    }
  );
}

/**
 * Extension activation
 */
async function activate(context) {
  log('Activating Claude Code Proxy Config extension...');
  
  // Auto-export certificates if configured (Windows only)
  await autoExportCerts();
  
  // Apply configuration to environment
  const applied = applyConfiguration();
  
  log(`Configuration applied: proxy=${applied.httpsProxy || 'none'}, ca=${applied.caFile || 'none'}, tlsVerify=${applied.rejectUnauthorized}`);
  
  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_KEY)) {
        log('Configuration changed, reapplying...');
        applyConfiguration();
        vscode.window.showInformationMessage('Claude Code Proxy Config updated. Restart the cache-fix proxy for changes to take effect.');
      }
    })
  );
  
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-proxy-config.showStatus', showStatus),
    vscode.commands.registerCommand('claude-code-proxy-config.testConnection', testConnection)
  );
  
  // Show warning if TLS verification is disabled
  if (!applied.rejectUnauthorized) {
    vscode.window.showWarningMessage(
      'Claude Code Proxy Config: TLS verification is DISABLED. This is insecure!',
      'Open Settings'
    ).then(choice => {
      if (choice === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'claude-code-proxy-config.rejectUnauthorized');
      }
    });
  }
  
  log('Extension activated');
}

function deactivate() {
  if (outputChannel) {
    outputChannel.dispose();
  }
}

module.exports = { activate, deactivate };
