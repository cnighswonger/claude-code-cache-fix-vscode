# Claude Code Proxy Config

Configure HTTP proxy and custom CA certificates for the [Claude Code Cache Fix](https://github.com/cnighswonger/claude-code-cache-fix) proxy in corporate environments.

## Why This Exists

The cache-fix proxy forwards requests to `api.anthropic.com`. In corporate environments with:

- **HTTP egress proxies** (Zscaler, Netskope, Forcepoint, Bluecoat, Squid)
- **SSL-inspecting proxies** that use custom CA certificates

...the proxy will fail to connect because Node.js doesn't automatically use system proxy settings or trust corporate CA certificates.

This extension solves both problems by:
1. Configuring the proxy environment variables (`HTTPS_PROXY`, `NO_PROXY`)
2. Pointing to your corporate CA bundle (`CACHE_FIX_PROXY_CA_FILE`)
3. Optionally auto-exporting certificates from Windows certificate store

## Installation

### From VSIX

1. Download the `.vsix` file from releases
2. In VS Code: Extensions → `...` menu → "Install from VSIX..."
3. Select the downloaded file

### Build from Source

```bash
cd claude-code-proxy-config
npm install -g @vscode/vsce
vsce package
code --install-extension claude-code-proxy-config-1.0.0.vsix
```

## Prerequisites

You need the **patched** `claude-code-cache-fix` npm package with proxy support:

```bash
npm install -g claude-code-cache-fix
```

The patched version adds these environment variable support:
- `HTTPS_PROXY` / `HTTP_PROXY` — routes upstream requests through your corporate proxy
- `NO_PROXY` — bypasses proxy for listed hosts
- `CACHE_FIX_PROXY_CA_FILE` — path to PEM file with extra CA certificates

## Configuration

Open VS Code Settings and search for "Claude Code Proxy":

| Setting | Description | Default |
|---------|-------------|---------|
| `httpsProxy` | HTTP(S) proxy URL (e.g., `http://proxy.corp.example:8080`) | Uses system `HTTPS_PROXY` |
| `noProxy` | Comma-separated hosts to bypass proxy | `localhost,127.0.0.1,::1,.local` |
| `caFile` | Path to PEM file with corporate CA certificates | (none) |
| `rejectUnauthorized` | Verify TLS certificates | `true` |
| `autoExportCerts` | (Windows) Auto-export certs from Windows store | `false` |
| `certSearchPatterns` | Certificate subject patterns to export | `["*Zscaler*", "*Netskope*", "*Forcepoint*"]` |

### Example: Zscaler on Windows

1. Get your proxy address:
   ```powershell
   ([System.Net.WebRequest]::GetSystemWebProxy().GetProxy([System.Uri]"https://api.anthropic.com")).AbsoluteUri
   # Example output: http://203.0.113.10:8080/
   ```

2. Export Zscaler certificates (one-time):
   ```powershell
   $certPath = "$env:USERPROFILE\corporate-bundle.pem"
   $certs = @()
   $certs += Get-ChildItem Cert:\LocalMachine\Root | Where-Object {$_.Subject -like "*Zscaler*"}
   $certs += Get-ChildItem Cert:\LocalMachine\CA | Where-Object {$_.Subject -like "*Zscaler*"}
   
   $pem = ""
   foreach($cert in $certs) {
       $pem += "# $($cert.Subject)`n-----BEGIN CERTIFICATE-----`n"
       $pem += [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
       $pem += "`n-----END CERTIFICATE-----`n`n"
   }
   $pem | Out-File -FilePath $certPath -Encoding ascii
   Write-Host "Exported $($certs.Count) certs to $certPath"
   ```

3. Configure the extension:
   ```json
   {
     "claude-code-proxy-config.httpsProxy": "http://203.0.113.10:8080",
     "claude-code-proxy-config.noProxy": "localhost,127.0.0.1,::1,.local,.corp.example",
     "claude-code-proxy-config.caFile": "C:\\Users\\YourName\\corporate-bundle.pem"
   }
   ```

4. Restart VS Code

### Auto-Export Certificates (Windows)

Enable automatic certificate export:

```json
{
  "claude-code-proxy-config.autoExportCerts": true,
  "claude-code-proxy-config.certSearchPatterns": ["*Zscaler*", "*YourCorp*"]
}
```

The extension will export matching certificates to `~/claude-proxy-ca-bundle.pem` on activation.

## Commands

- **Claude Code Proxy Config: Show Status** — Display current proxy configuration
- **Claude Code Proxy Config: Test Connection** — Test connection to `api.anthropic.com`

## Verification

After configuring, check the cache-fix proxy output channel. On first API request, you should see:

```
[upstream] using proxy http://proxy.corp.example:8080 (rejectUnauthorized=true, ca=C:\Users\YourName\corporate-bundle.pem)
```

## Troubleshooting

### "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" or "CERT_HAS_EXPIRED"

Your CA bundle is missing the proxy's root certificate. Re-export including all corporate CAs.

### "ECONNREFUSED" or "ETIMEDOUT"

Proxy address is wrong or proxy is blocking the connection. Check with IT.

### Connection works in browser but not here

Browsers read system proxy and trust Windows certificate store automatically. Node.js doesn't — that's why this extension exists.

### Last resort: Disable TLS verification

**NOT RECOMMENDED** — only use temporarily while waiting for IT to provide certificates:

```json
{
  "claude-code-proxy-config.rejectUnauthorized": false
}
```

## How It Works

1. On activation, the extension reads your settings
2. Sets environment variables (`HTTPS_PROXY`, `NO_PROXY`, `CACHE_FIX_PROXY_CA_FILE`)
3. The cache-fix proxy (started by the main cache-fix extension) reads these env vars
4. Upstream requests to `api.anthropic.com` route through your corporate proxy with proper CA trust

## License

MIT
