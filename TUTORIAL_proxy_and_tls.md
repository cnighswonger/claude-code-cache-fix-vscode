# Tutorial: add HTTP-proxy and custom-CA support to `claude-code-cache-fix`

> Audience: an LLM that will apply these changes to a local clone of `claude-code-cache-fix` (the **npm package**, not the VS Code extension), then verify with the included tests.
> Output target: a forked / patched copy that can be `npm install -g`'d and used behind corporate egress proxies and TLS-MITM SSL inspection.

---

## 1. Why this work is being done (read before touching code)

The proxy server in `claude-code-cache-fix` listens on `127.0.0.1:9801`, accepts Anthropic API requests from Claude Code, applies cache-stability fixes, and forwards to `https://api.anthropic.com`. The forward call uses Node's built-in `https.request()` with **no agent**:

```js
// proxy/upstream.mjs (current)
const upstreamReq = transport.request(options, (upstreamRes) => { ... });
```

Consequences in a corporate environment:

- **`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are ignored.** Node's stdlib does not honor those env vars without an explicit agent. Outbound `:443` connect to `api.anthropic.com` either times out or is blocked at the firewall.
- **Windows system proxy is ignored.** Node never reads the IE/winhttp proxy.
- **`NODE_EXTRA_CA_CERTS`** *is* honored (Node-level), but only if it's in the env when the proxy process spawns. We need to make sure this is preserved when the VS Code extension launches the proxy. We also want a `CACHE_FIX_PROXY_CA_FILE` knob so users don't have to set a global env var.

Goal: make the proxy a well-behaved citizen behind corp egress proxies and SSL-inspecting MITM CAs, by wiring three industry-standard env vars (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) and one new package-specific knob (`CACHE_FIX_PROXY_CA_FILE`). No upstream API changes; default behavior with no env vars is identical to today.

Benefits:
- Works behind Zscaler / Netskope / Forcepoint / squid / corp Bluecoat without manual code editing.
- Works on machines with internal CA roots (banks, healthcare, gov, large enterprises).
- Drop-in: zero config needed for users without a corp proxy.

---

## 2. Files to read for full context (load all of these before editing)

These files together describe the proxy's request lifecycle, config loading, and existing dependencies. Read them top-to-bottom to understand the shape before changing anything.

1. `package.json` — current deps, scripts, engines.
2. `proxy/server.mjs` — entry point; HTTP server wiring; how `forwardRequest` is consumed.
3. `proxy/upstream.mjs` — **the file you will edit most.** Current outbound forwarder.
4. `proxy/config.mjs` — env-var-driven config; pattern to mirror for new env vars.
5. `proxy/stream.mjs` — how the streaming response is read after `forwardRequest` returns. (Read-only context — do not change.)
6. `proxy/pipeline.mjs` — extension loader. (Read-only context.)
7. `proxy/extensions.json` — extension enable/order config. (Read-only context.)
8. `README.md` — user-facing docs you will update.

If you cannot find any of these files, stop and report which is missing — the project layout has changed and the tutorial may not apply cleanly.

---

## 3. Add the proxy-agent dependencies

Edit `package.json`. Add to `dependencies`:

```json
"hpagent": "^1.2.0"
```

Use `hpagent` over `https-proxy-agent` because it has zero runtime deps, is maintained, and supports both HTTP and HTTPS upstream proxies in one package — keeps install size small, which matters for a globally-installed CLI tool.

After editing, run `npm install` once in the package root to populate `node_modules`. Do **not** check in `package-lock.json` changes that aren't strictly the new dep.

---

## 4. Extend `proxy/config.mjs`

Add four new fields (after the existing `debug` line). Match the existing `envInt` / inline-default style:

```js
function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

// ... existing config object, add:
  httpProxy:       process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY  || process.env.http_proxy  || "",
  noProxy:         process.env.NO_PROXY    || process.env.no_proxy    || "",
  caFile:          process.env.CACHE_FIX_PROXY_CA_FILE || "",
  rejectUnauthorized: envFlag("CACHE_FIX_PROXY_REJECT_UNAUTHORIZED", true),
```

Notes:
- Both `HTTPS_PROXY` and `https_proxy` are checked because shells differ (cmd preserves case, bash/zsh users often use lowercase).
- `caFile` is an explicit override when users don't want to set `NODE_EXTRA_CA_CERTS` system-wide.
- `rejectUnauthorized` defaults to `true`. Document loudly in the README that flipping it to `false` disables TLS verification — escape hatch only.

---

## 5. Rewrite `proxy/upstream.mjs`

Apply this diff. Keep the existing header-stripping logic untouched; only the agent setup and the `transport.request(options, ...)` call change.

### 5a. Add imports at top

```js
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { HttpProxyAgent, HttpsProxyAgent } from "hpagent";
import config from "./config.mjs";
```

### 5b. Add agent factory above `forwardRequest`

```js
let _httpsAgent = null;
let _httpAgent  = null;
let _agentInitTried = false;

function shouldBypassProxy(hostname) {
  if (!config.noProxy) return false;
  const list = config.noProxy.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  for (const pattern of list) {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) {
      // ".example.com" matches "foo.example.com" and "example.com"
      const bare = pattern.slice(1);
      if (host === bare || host.endsWith(pattern)) return true;
    } else if (host === pattern || host.endsWith("." + pattern)) {
      return true;
    }
  }
  return false;
}

function loadCa() {
  if (!config.caFile) return undefined;
  try {
    return readFileSync(config.caFile);
  } catch (err) {
    process.stderr.write(`[upstream] CACHE_FIX_PROXY_CA_FILE read failed: ${err.message}\n`);
    return undefined;
  }
}

function getAgent(isHTTPS, hostname) {
  if (!_agentInitTried) {
    _agentInitTried = true;
    if (config.httpProxy) {
      const ca = loadCa();
      const common = {
        keepAlive: true,
        proxy: config.httpProxy,
        rejectUnauthorized: config.rejectUnauthorized,
        ...(ca ? { ca } : {}),
      };
      _httpsAgent = new HttpsProxyAgent(common);
      _httpAgent  = new HttpProxyAgent(common);
      process.stderr.write(`[upstream] using proxy ${config.httpProxy} (rejectUnauthorized=${config.rejectUnauthorized}, ca=${config.caFile || "default"})\n`);
    } else if (config.caFile || !config.rejectUnauthorized) {
      // No HTTP proxy, but custom CA or insecure mode requested: build a plain agent.
      const ca = loadCa();
      _httpsAgent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: config.rejectUnauthorized,
        ...(ca ? { ca } : {}),
      });
    }
  }
  if (shouldBypassProxy(hostname)) {
    return isHTTPS
      ? new https.Agent({ keepAlive: true, rejectUnauthorized: config.rejectUnauthorized, ca: loadCa() })
      : new http.Agent({ keepAlive: true });
  }
  return isHTTPS ? _httpsAgent : _httpAgent;
}
```

### 5c. Use the agent in `forwardRequest`

Inside `forwardRequest`, where `options` is built:

```js
const options = {
  hostname: upstreamUrl.hostname,
  port: upstreamUrl.port || defaultPort,
  path: upstreamUrl.pathname + upstreamUrl.search,
  method: clientReq.method,
  headers,
  timeout: config.timeout,
  agent: getAgent(isHTTPS, upstreamUrl.hostname),  // <-- new line
};
```

Leave `agent: undefined` semantics as-is for the no-config case — `getAgent` returns `null` when no proxy/ca/insecure is configured, and Node treats `agent: null` as "no agent, use the global default", which is the current behavior. **Do not** change this to `agent: false` (that disables connection pooling and silently degrades performance).

---

## 6. Update `README.md`

Add a "Corporate environments" section. Use this exact markdown so users know what to set:

```markdown
## Corporate environments (proxies, custom CAs)

The proxy honors the following environment variables when forwarding to `api.anthropic.com`:

| Variable | Effect |
|----------|--------|
| `HTTPS_PROXY` / `HTTP_PROXY` (and lowercase variants) | Routes upstream requests through your corporate HTTP CONNECT proxy. |
| `NO_PROXY` | Comma-separated host list to bypass the proxy. Supports `*` and `.suffix.example.com`. |
| `CACHE_FIX_PROXY_CA_FILE` | Path to a PEM file with one or more extra CA certificates (for SSL-inspecting proxies). Alternative to setting `NODE_EXTRA_CA_CERTS` system-wide. |
| `NODE_EXTRA_CA_CERTS` | Standard Node mechanism — also honored. |
| `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0` | **Insecure escape hatch.** Disables TLS verification. Use only as a last resort while you wait for IT to provide the corp CA bundle. |

Example (Windows PowerShell):

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:NO_PROXY    = 'localhost,127.0.0.1,.corp.example'
$env:CACHE_FIX_PROXY_CA_FILE = 'C:\corp\zscaler-root.pem'
node "$(npm root -g)\claude-code-cache-fix\proxy\server.mjs"
```

Stderr will print `[upstream] using proxy http://proxy.corp.example:8080 ...` on first request if the agent is wired correctly.
```

---

## 7. Tests

Create `proxy/upstream.test.mjs`. Use `node --test` (already used by the project — see `package.json` `scripts.test`).

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// IMPORTANT: env vars must be set BEFORE importing config / upstream because
// config is read at module load. Reset modules between tests via a child process
// in real CI; for this single-file demo we set up before each import.

function runWithEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// Reusable: spin up a tiny HTTP "fake corp proxy" that just records the
// CONNECT or absolute-URL it receives, then closes the socket.
function startFakeHttpProxy() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ method: req.method, url: req.url, host: req.headers.host });
      res.statusCode = 502;
      res.end("fake proxy intercept");
    });
    server.on("connect", (req, socket) => {
      hits.push({ method: "CONNECT", url: req.url, host: req.headers.host });
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test("forwardRequest routes through HTTPS_PROXY when set", async () => {
  const fake = await startFakeHttpProxy();
  try {
    await runWithEnv(
      { HTTPS_PROXY: `http://127.0.0.1:${fake.port}`, NO_PROXY: "" },
      async () => {
        // Fresh import to pick up env-driven config.
        const { forwardRequest } = await import(`./upstream.mjs?bust=${Date.now()}`);
        const fakeClientReq = {
          url: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "x-test": "1" },
        };
        const body = Buffer.from('{"model":"x","messages":[]}');
        await forwardRequest(fakeClientReq, body, null).catch(() => {}); // expect failure (502)
      }
    );
    assert.ok(fake.hits.length > 0, "fake proxy should have received a CONNECT or request");
    const first = fake.hits[0];
    // For HTTPS upstream, an HTTP proxy receives a CONNECT to host:443.
    assert.equal(first.method, "CONNECT");
    assert.match(first.url, /^api\.anthropic\.com:443$/);
  } finally {
    await fake.close();
  }
});

test("forwardRequest bypasses proxy when host is in NO_PROXY", async () => {
  const fake = await startFakeHttpProxy();
  try {
    await runWithEnv(
      {
        HTTPS_PROXY: `http://127.0.0.1:${fake.port}`,
        NO_PROXY: "api.anthropic.com",
      },
      async () => {
        const { forwardRequest } = await import(`./upstream.mjs?bust=${Date.now()}`);
        await forwardRequest(
          { url: "/v1/messages", method: "POST", headers: {} },
          Buffer.from("{}"),
          null
        ).catch(() => {});
      }
    );
    assert.equal(fake.hits.length, 0, "fake proxy should NOT have been hit when NO_PROXY matches");
  } finally {
    await fake.close();
  }
});

test("forwardRequest with no proxy env vars uses default agent (no regression)", async () => {
  await runWithEnv(
    {
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      https_proxy: "",
      http_proxy: "",
      NO_PROXY: "",
      CACHE_FIX_PROXY_CA_FILE: "",
    },
    async () => {
      const upstream = await import(`./upstream.mjs?bust=${Date.now()}`);
      // Smoke: just verify the module exports and the function doesn't throw at import time.
      assert.equal(typeof upstream.forwardRequest, "function");
    }
  );
});
```

Run with:

```bash
node --test proxy/upstream.test.mjs
```

All three tests must pass before considering the change complete.

---

## 8. Manual smoke test (mandatory; the unit tests can't catch real-network behavior)

### 8a. Without a proxy (regression check)

```bash
unset HTTPS_PROXY HTTP_PROXY NO_PROXY CACHE_FIX_PROXY_CA_FILE
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs" &
curl -s http://127.0.0.1:9801/health  # → {"status":"ok"}
# kill the proxy
```

Stderr should NOT contain `[upstream] using proxy ...`. Behavior identical to pre-change.

### 8b. With a fake local proxy (positive case)

In one terminal:

```bash
# install mitmproxy or use a tiny node script:
npx -y http-proxy --port 18888  # if this package isn't available, write a 30-line node script
```

In another terminal:

```bash
export HTTPS_PROXY=http://127.0.0.1:18888
export NO_PROXY=localhost,127.0.0.1
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs"
```

Stderr should print `[upstream] using proxy http://127.0.0.1:18888 (rejectUnauthorized=true, ca=default)` on first forwarded request. The mitmproxy/http-proxy log should show a CONNECT to `api.anthropic.com:443`.

### 8c. With a custom CA file

Generate a self-signed CA, drop the cert in `/tmp/test-ca.pem`, then:

```bash
export CACHE_FIX_PROXY_CA_FILE=/tmp/test-ca.pem
node "$(npm root -g)/claude-code-cache-fix/proxy/server.mjs"
```

Stderr should mention `ca=/tmp/test-ca.pem`. If the file is unreadable, stderr should show the read error and the proxy should still start (graceful degrade).

---

## 9. Acceptance criteria

The change is done when **all** of these are true:

- [ ] `node --test proxy/upstream.test.mjs` exits 0 with all three tests passing.
- [ ] Smoke test 8a shows the proxy starts and `/health` returns 200 with no proxy-related stderr noise.
- [ ] Smoke test 8b shows the fake proxy receives a `CONNECT api.anthropic.com:443` from the upstream forwarder.
- [ ] Smoke test 8c shows the CA file is loaded (per stderr line) and a malformed file produces a graceful warning, not a crash.
- [ ] `README.md` has the new "Corporate environments" section.
- [ ] `package.json` has `"hpagent": "^1.2.0"` in `dependencies` and the install size grew by less than 100 KB (`du -sh node_modules/hpagent`).
- [ ] `git diff` shows changes only in: `package.json`, `package-lock.json` (only the new dep), `proxy/config.mjs`, `proxy/upstream.mjs`, `proxy/upstream.test.mjs` (new), `README.md`. Nothing else.

---

## 10. Common pitfalls (read these before debugging a failing test)

1. **`config.mjs` is read at module load.** If your test imports `upstream.mjs` once and then sets env vars, the config is already frozen with empty values. Either set env vars before the very first import, or use a query-string busting suffix (`?bust=${Date.now()}`) to force a fresh module instance — that's why the tests above do it.
2. **`agent: null` vs `agent: undefined` vs `agent: false`** — keep it `null`/`undefined` for the no-config path. `false` disables keep-alive globally and tanks throughput.
3. **`hpagent` proxy URL must include scheme** — `http://proxy:8080`, not `proxy:8080`. Validate and prefix `http://` if missing if you want to be friendly, but don't accept arbitrary garbage.
4. **`NODE_EXTRA_CA_CERTS` is read by Node at startup** — if a user expects to set it in their shell after the proxy is already running, it won't take effect. Document this clearly.
5. **`rejectUnauthorized: false`** — never set this implicitly. Only honor it when the user explicitly sets `CACHE_FIX_PROXY_REJECT_UNAUTHORIZED=0`. Print a one-time warning to stderr if it's set, so users can't accidentally ship insecure config.
6. **Streaming responses** — the existing `streamResponse` code in `stream.mjs` consumes the upstream `IncomingMessage` directly. Do not change that consumer. The agent change is purely about the connection layer; it must remain transparent to the streaming pipeline.

---

## 11. When you're done

1. Commit the changes to a fresh branch named `corp-proxy-and-ca-support`.
2. Push the branch.
3. Open a PR titled "Honor HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS / CACHE_FIX_PROXY_CA_FILE in proxy upstream forwarder" with a body that links to the relevant issue (cnighswonger/claude-code-cache-fix-vscode#8 mentions corp-environment failure modes — the upstream issue for this specific problem may not exist yet; if so, file one first using the symptoms from section 1 of this tutorial).
4. Report back with: the commit SHA, the test output (all three passing), and screenshots/logs of smoke test 8b's CONNECT line.

If anything in this tutorial doesn't match the actual repo state (e.g., the buggy line in `pipeline.mjs` already has `pathToFileURL`, a separate issue is being fixed in parallel), STOP and report what diverged before applying further changes.
