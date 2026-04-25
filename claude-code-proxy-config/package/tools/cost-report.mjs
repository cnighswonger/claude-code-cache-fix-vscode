#!/usr/bin/env node
/**
 * cost-report — Calculate Claude API costs from usage telemetry.
 *
 * Input sources (in priority order):
 *   1. Default: reads interceptor usage log at ~/.claude/usage.jsonl
 *   2. --file / -f: any JSONL file (SDK output, proxy captures, etc.)
 *   3. --sim-log: extract from simulation logs (Token telemetry: {...} lines)
 *   4. stdin: pipe JSON-lines from any source
 *
 * Pricing sources (best → fallback):
 *   1. Admin API actual billed usage  (--admin-key)
 *   2. Live rates from Anthropic docs  (--live-rates)
 *   3. Bundled rates.json              (default)
 *
 * Part of claude-code-cache-fix. Works standalone or with the interceptor.
 * https://github.com/cnighswonger/claude-code-cache-fix
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATES_PATH = join(__dirname, 'rates.json');
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const ADMIN_API_BASE = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const DEFAULT_USAGE_LOG = join(homedir(), '.claude', 'usage.jsonl');

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    simLog: null, file: null, adminKey: null,
    liveRates: false, updateRates: false, help: false,
    date: null, since: null, format: 'text',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sim-log':    opts.simLog = args[++i]; break;
      case '--file':
      case '-f':           opts.file = args[++i]; break;
      case '--admin-key':  opts.adminKey = args[++i]; break;
      case '--live-rates': opts.liveRates = true; break;
      case '--update-rates': opts.updateRates = true; break;
      case '--date':       opts.date = args[++i]; break;
      case '--since':      opts.since = args[++i]; break;
      case '--format':     opts.format = args[++i]; break;
      case '--json':       opts.format = 'json'; break;
      case '--md':
      case '--markdown':   opts.format = 'md'; break;
      case '--help':
      case '-h':           opts.help = true; break;
      default:
        if (!args[i].startsWith('-') && !opts.file && !opts.simLog) {
          opts.file = args[i];
        }
    }
  }

  opts.adminKey = opts.adminKey || process.env.ANTHROPIC_ADMIN_KEY;
  return opts;
}

function printUsage() {
  console.log(`
cost-report — Calculate Claude API costs from usage telemetry.

Usage:
  node cost-report.mjs                                   From interceptor log (~/.claude/usage.jsonl)
  node cost-report.mjs --date 2026-04-08                 Filter to a specific date
  node cost-report.mjs --since 2h                        Filter to last N hours/minutes
  node cost-report.mjs --file <path>                     From any JSONL file
  node cost-report.mjs --sim-log <path>                  From a simulation log
  node cost-report.mjs --admin-key <key>                 Cross-reference with Admin API
  cat telemetry.jsonl | node cost-report.mjs             From JSON-lines on stdin
  node cost-report.mjs --update-rates                    Refresh bundled rates

Input sources (checked in order):
  Default              Reads ~/.claude/usage.jsonl (written by the interceptor)
  --file, -f <path>    Any JSONL file (SDK output, proxy captures, etc.)
  --sim-log <path>     Extract from simulation logs (Token telemetry lines)
  stdin                Pipe JSON-lines from any source

Filtering:
  --date <YYYY-MM-DD>  Show only entries from this date
  --since <duration>   Show entries from last Nh, Nm, or Nd (e.g. 2h, 30m, 1d)

Output:
  --format <fmt>       Output format: text (default), json, md
  --json               Shorthand for --format json
  --md, --markdown     Shorthand for --format md

Pricing:
  --admin-key <key>    Anthropic Admin API key for actual billed usage
                       (or set ANTHROPIC_ADMIN_KEY env var)
  --live-rates         Fetch current rates from Anthropic docs
  --update-rates       Fetch and save current rates to rates.json

Input JSON format (one object per line):
  Required: model, input_tokens, output_tokens
  Optional: cache_read_input_tokens, cache_creation_input_tokens,
            ephemeral_1h_input_tokens, ephemeral_5m_input_tokens,
            timestamp, preflight_input_tokens, degradation_steps

Example JSONL (as written by the interceptor):
  {"timestamp":"2026-04-09T01:23:45Z","model":"claude-sonnet-4-5-20250929","input_tokens":50000,"output_tokens":1200,"cache_read_input_tokens":13000,"cache_creation_input_tokens":0,"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}

For SDK users — log usage from API responses:
  const msg = await anthropic.messages.create({...});
  fs.appendFileSync('usage.jsonl', JSON.stringify({
    timestamp: new Date().toISOString(),
    model: msg.model,
    ...msg.usage
  }) + '\\n');
`);
}

// ─── Rates ──────────────────────────────────────────────────────────────────

function loadBundledRates() {
  if (!existsSync(RATES_PATH)) {
    console.error('WARNING: No bundled rates.json found. Use --update-rates to create one.');
    return null;
  }
  const data = JSON.parse(readFileSync(RATES_PATH, 'utf8'));

  // Check staleness
  const lastUpdated = new Date(data.last_updated);
  const daysSince = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 30) {
    console.error(`WARNING: Bundled rates are ${Math.floor(daysSince)} days old (last updated ${data.last_updated}).`);
    console.error('         Run with --update-rates to refresh, or --live-rates to fetch once.');
  }
  return data;
}

async function fetchLiveRates() {
  try {
    const resp = await fetch(PRICING_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    return parsePricingPage(html);
  } catch (err) {
    console.error(`WARNING: Failed to fetch live rates: ${err.message}`);
    console.error('         Falling back to bundled rates.');
    return null;
  }
}

function parsePricingPage(html) {
  // The docs page renders as HTML table rows with <td> elements.
  // Pattern: model name in one <td>, then rates as "$X / MTok" in subsequent <td>s.
  // We extract: Model | Base Input | 5m Cache Write | 1h Cache Write | Cache Read | Output
  //
  // The HTML has rows like:
  //   Opus 4.6</td><td ...>$5 / MTok</td><td ...>$6.25 / MTok</td>...

  const models = {};
  const parseRate = (s) => {
    const m = s.match(/\$([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  };

  // Strategy: find model name followed by 5 rate cells in the pricing table.
  // Match: "ModelName</td><td...>$X / MTok</td>..." pattern
  const rowPattern = /((?:Opus|Sonnet|Haiku)\s+[\d.]+(?:\s*\([^)]*\))?)\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok/g;
  let match;

  while ((match = rowPattern.exec(html)) !== null) {
    let name = match[1].trim();
    // Strip "(deprecated)" etc.
    name = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    // Skip if it contains HTML
    if (name.includes('<')) continue;

    const input = parseFloat(match[2]);
    const write5m = parseFloat(match[3]);
    const write1h = parseFloat(match[4]);
    const cacheRead = parseFloat(match[5]);
    const output = parseFloat(match[6]);

    if (isNaN(input) || isNaN(output)) continue;

    const idMap = resolveModelId(name);
    for (const id of idMap) {
      models[id] = {
        input, output,
        cache_read: cacheRead,
        cache_write_5m: write5m,
        cache_write_1h: write1h,
      };
    }
  }

  if (Object.keys(models).length === 0) {
    console.error('WARNING: Could not parse any model pricing from docs page.');
    console.error('         The page format may have changed. Falling back to bundled rates.');
    return null;
  }

  return {
    last_updated: new Date().toISOString().slice(0, 10),
    source: PRICING_URL,
    notes: 'Auto-fetched from Anthropic docs.',
    models,
  };
}

function resolveModelId(displayName) {
  // Map display names like "Opus 4.6" to API model IDs
  const map = {
    'Opus 4.6': ['claude-opus-4-6'],
    'Opus 4.5': ['claude-opus-4-5-20251101'],
    'Opus 4.1': ['claude-opus-4-1-20250805'],
    'Opus 4': ['claude-opus-4-20250514'],
    'Opus 3': ['claude-3-opus-20240229'],
    'Sonnet 4.6': ['claude-sonnet-4-6'],
    'Sonnet 4.5': ['claude-sonnet-4-5-20250929'],
    'Sonnet 4': ['claude-sonnet-4-20250514'],
    'Sonnet 3.7': ['claude-sonnet-3-7-20250219'],
    'Haiku 4.5': ['claude-haiku-4-5-20251001'],
    'Haiku 3.5': ['claude-haiku-3-5-20241022'],
    'Haiku 3': ['claude-3-haiku-20240307'],
  };
  return map[displayName] || [`claude-${displayName.toLowerCase().replace(/\s+/g, '-')}`];
}

function lookupRates(ratesData, modelId) {
  if (!ratesData || !ratesData.models) return null;

  // Direct match
  if (ratesData.models[modelId]) return ratesData.models[modelId];

  // Try prefix match (e.g. "claude-sonnet-4-5-20250929" matches "claude-sonnet-4-5-*")
  for (const [key, rates] of Object.entries(ratesData.models)) {
    // Match if the stored key is a prefix or shares the same base
    if (modelId.startsWith(key) || key.startsWith(modelId)) return rates;
  }

  // Try matching by family (strip date suffix)
  const base = modelId.replace(/-\d{8}$/, '');
  if (ratesData.models[base]) return ratesData.models[base];

  return null;
}

// ─── Input parsing ──────────────────────────────────────────────────────────

function extractFromSimLog(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const entries = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(/Token telemetry:\s*(\{.+\})/);
    if (match) {
      try {
        const obj = JSON.parse(match[1]);
        // Extract timestamp from log line
        const tsMatch = line.match(/\[([^\]]+)\]/);
        if (tsMatch) obj._timestamp = tsMatch[1];
        entries.push(obj);
      } catch { /* skip malformed */ }
    }
  }

  if (entries.length === 0) {
    console.error('WARNING: No "Token telemetry" entries found in sim log.');
    console.error('         This log may use an older format without structured telemetry.');
  }

  return entries;
}

function parseJsonLines(text) {
  return text.split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

async function readStdin() {
  const chunks = [];
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) chunks.push(line);
  return chunks.join('\n');
}

function normalizeEntry(raw) {
  // Accept multiple naming conventions:
  //   - Interceptor: input_tokens, output_tokens, timestamp
  //   - Sim telemetry: actual_input_tokens, actual_output_tokens, _timestamp
  //   - SDK: input_tokens, output_tokens (from usage object)
  return {
    model: raw.model || 'unknown',
    timestamp: raw.timestamp || raw._timestamp || null,
    input_tokens: raw.actual_input_tokens ?? raw.input_tokens ?? 0,
    output_tokens: raw.actual_output_tokens ?? raw.output_tokens ?? 0,
    cache_read: raw.cache_read_input_tokens ?? 0,
    cache_create: raw.cache_creation_input_tokens ?? 0,
    eph_1h: raw.ephemeral_1h_input_tokens ?? 0,
    eph_5m: raw.ephemeral_5m_input_tokens ?? 0,
    preflight: raw.preflight_input_tokens ?? null,
    degradation: raw.degradation_steps ?? [],
    would_have_exceeded: raw.would_have_exceeded ?? false,
    sys_prompt_est: raw.system_prompt_tokens_est ?? null,
  };
}

// ─── Admin API ──────────────────────────────────────────────────────────────

async function fetchAdminUsage(adminKey, startTime, endTime) {
  // Round start down and end up to hour boundaries
  const start = new Date(startTime);
  start.setMinutes(0, 0, 0);
  const end = new Date(endTime);
  end.setHours(end.getHours() + 1, 0, 0, 0);

  const url = `${ADMIN_API_BASE}?bucket_width=1h` +
    `&starting_at=${start.toISOString()}` +
    `&ending_at=${end.toISOString()}` +
    `&group_by[]=model`;

  try {
    const resp = await fetch(url, {
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return await resp.json();
  } catch (err) {
    console.error(`WARNING: Admin API query failed: ${err.message}`);
    return null;
  }
}

function summarizeAdminData(apiData, ratesData) {
  const byModel = {};
  let totalCost = 0;

  for (const bucket of (apiData.data || [])) {
    for (const r of (bucket.results || [])) {
      const model = r.model || 'unknown';
      if (!byModel[model]) {
        byModel[model] = { uncached: 0, cache_read: 0, cache_1h: 0, cache_5m: 0, output: 0, cost: 0 };
      }
      const m = byModel[model];
      m.uncached += r.uncached_input_tokens || 0;
      m.cache_read += r.cache_read_input_tokens || 0;
      const cc = r.cache_creation || {};
      m.cache_1h += cc.ephemeral_1h_input_tokens || 0;
      m.cache_5m += cc.ephemeral_5m_input_tokens || 0;
      m.output += r.output_tokens || 0;
    }
  }

  // Calculate costs per model
  for (const [model, m] of Object.entries(byModel)) {
    const rates = lookupRates(ratesData, model);
    if (rates) {
      m.cost = (m.uncached * rates.input + m.cache_read * rates.cache_read +
                m.cache_1h * rates.cache_write_1h + m.cache_5m * rates.cache_write_5m +
                m.output * rates.output) / 1_000_000;
    }
    totalCost += m.cost;
  }

  return { byModel, totalCost };
}

// ─── Cost calculation ───────────────────────────────────────────────────────

function calculateCosts(entries, ratesData) {
  const results = [];
  const summary = {
    calls: 0,
    byModel: {},
    totals: { input: 0, output: 0, cache_read: 0, cache_1h: 0, cache_5m: 0, preflight: 0 },
    totalCost: 0,
    degradedCalls: 0,
    exceededCalls: 0,
    degradationSteps: {},
  };

  for (const entry of entries) {
    const rates = lookupRates(ratesData, entry.model);
    if (!rates) {
      console.error(`WARNING: No rates found for model "${entry.model}". Skipping cost calculation.`);
      results.push({ ...entry, cost: null, rateSource: 'missing' });
      continue;
    }

    // Determine cache write tier for cache_creation tokens.
    // eph_1h/eph_5m are READ tokens (cache hits per tier), not write tokens.
    // But they tell us which tier the request was on — and cache creation on
    // that request uses the same tier's write rate.
    // Fix for #7: previously assigned all creation to 5m when eph fields were 0.
    let cw1h = 0;
    let cw5m = 0;
    if (entry.cache_create > 0) {
      if (entry.eph_1h > 0) {
        // Request was on 1h tier — creation charged at 1h write rate
        cw1h = entry.cache_create;
      } else if (entry.eph_5m > 0) {
        // Request was on 5m tier — creation charged at 5m write rate
        cw5m = entry.cache_create;
      } else {
        // No tier signal available; assume 5m (conservative — lower rate)
        cw5m = entry.cache_create;
      }
    }

    const cost = (
      entry.input_tokens * rates.input +
      entry.output_tokens * rates.output +
      entry.cache_read * rates.cache_read +
      cw1h * rates.cache_write_1h +
      cw5m * rates.cache_write_5m
    ) / 1_000_000;

    results.push({ ...entry, cost, cw1h, cw5m });

    // Accumulate summary
    summary.calls++;
    summary.totals.input += entry.input_tokens;
    summary.totals.output += entry.output_tokens;
    summary.totals.cache_read += entry.cache_read;
    summary.totals.cache_1h += cw1h;
    summary.totals.cache_5m += cw5m;
    if (entry.preflight != null) summary.totals.preflight += entry.preflight;

    if (!summary.byModel[entry.model]) {
      summary.byModel[entry.model] = { calls: 0, cost: 0 };
    }
    summary.byModel[entry.model].calls++;
    summary.byModel[entry.model].cost += cost;

    summary.totalCost += cost;

    if (entry.degradation.length > 0) {
      summary.degradedCalls++;
      for (const step of entry.degradation) {
        summary.degradationSteps[step] = (summary.degradationSteps[step] || 0) + 1;
      }
    }
    if (entry.would_have_exceeded) summary.exceededCalls++;
  }

  return { results, summary };
}

// ─── Report formatting ──────────────────────────────────────────────────────

function fmt(n) {
  return n.toLocaleString('en-US');
}

function fmtCost(n) {
  if (n == null) return '  N/A';
  return `$${n.toFixed(4)}`;
}

function printReport(results, summary, ratesData, adminSummary, format) {
  if (format === 'json') return printJsonReport(results, summary, ratesData, adminSummary);
  if (format === 'md') return printMarkdownReport(results, summary, ratesData, adminSummary);
  return printTextReport(results, summary, ratesData, adminSummary);
}

// ─── JSON output ────────────────────────────────────────────────────────────

function printJsonReport(results, summary, ratesData, adminSummary) {
  const report = {
    generated: new Date().toISOString(),
    pricing: { source: ratesData?.source || 'bundled', last_updated: ratesData?.last_updated },
    calls: results.map(r => ({
      timestamp: r.timestamp,
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read: r.cache_read,
      cache_write_1h: r.cw1h || 0,
      cache_write_5m: r.cw5m || 0,
      cost: r.cost,
      degradation_steps: r.degradation.length > 0 ? r.degradation : undefined,
    })),
    summary: {
      total_calls: summary.calls,
      total_cost: summary.totalCost,
      avg_cost_per_call: summary.totalCost / summary.calls,
      tokens: summary.totals,
      cost_factor: (function () {
        // fgrosswig-style overhead ratio: gross tokens / output tokens
        const gross = summary.totals.input + summary.totals.output +
                      summary.totals.cache_read + summary.totals.cache_1h + summary.totals.cache_5m;
        return summary.totals.output > 0 ? gross / summary.totals.output : null;
      })(),
      by_model: summary.byModel,
      degradation: summary.degradedCalls > 0 ? {
        degraded_calls: summary.degradedCalls,
        exceeded_calls: summary.exceededCalls,
        steps: summary.degradationSteps,
      } : undefined,
    },
  };
  if (adminSummary) {
    report.admin_api = {
      total_cost: adminSummary.totalCost,
      delta: adminSummary.totalCost - summary.totalCost,
      by_model: adminSummary.byModel,
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

// ─── Markdown output ────────────────────────────────────────────────────────

function printMarkdownReport(results, summary, ratesData, adminSummary) {
  const rateSource = ratesData?.last_updated ? `rates from ${ratesData.last_updated}` : 'unknown rates';
  const lines = [];

  lines.push('# Claude API Cost Report');
  lines.push('');
  lines.push(`Pricing: ${rateSource} (${ratesData?.source || 'bundled'})`);
  lines.push('');

  // Per-call table
  if (results.length <= 50) {
    lines.push('## Per-Call Breakdown');
    lines.push('');
    lines.push('| # | Timestamp | Model | Input | Output | Cache Rd | Cache Wr | Cost | Degradation |');
    lines.push('|---|-----------|-------|------:|-------:|---------:|---------:|-----:|-------------|');

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const ts = r.timestamp ? r.timestamp.slice(0, 19) : '—';
      const modelShort = r.model.replace('claude-', '').replace(/-\d{8}$/, '');
      const cacheWr = (r.cw1h || 0) + (r.cw5m || 0);
      const deg = r.degradation.length > 0 ? r.degradation.length + ' steps' : '';
      lines.push(`| ${i + 1} | ${ts} | ${modelShort} | ${fmt(r.input_tokens)} | ${fmt(r.output_tokens)} | ${fmt(r.cache_read)} | ${fmt(cacheWr)} | ${fmtCost(r.cost)} | ${deg} |`);
    }
    lines.push('');
  }

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Total API calls | ${summary.calls} |`);
  lines.push(`| Total input tokens | ${fmt(summary.totals.input)} |`);
  lines.push(`| Total output tokens | ${fmt(summary.totals.output)} |`);
  lines.push(`| Total cache read | ${fmt(summary.totals.cache_read)} |`);
  lines.push(`| Total cache write 1h | ${fmt(summary.totals.cache_1h)} |`);
  lines.push(`| Total cache write 5m | ${fmt(summary.totals.cache_5m)} |`);
  lines.push(`| **Total cost** | **${fmtCost(summary.totalCost)}** |`);
  lines.push(`| Avg cost per call | ${fmtCost(summary.totalCost / summary.calls)} |`);
  {
    // Cost factor: popularized by @fgrosswig's claude-usage-dashboard
    // (https://github.com/fgrosswig/claude-usage-dashboard)
    const grossTokens = summary.totals.input + summary.totals.output +
                        summary.totals.cache_read + summary.totals.cache_1h + summary.totals.cache_5m;
    if (summary.totals.output > 0) {
      lines.push(`| Cost factor (tokens/output) | ${(grossTokens / summary.totals.output).toFixed(1)}× |`);
    }
  }
  lines.push('');

  // By model
  lines.push('## By Model');
  lines.push('');
  lines.push('| Model | Calls | Cost |');
  lines.push('|-------|------:|-----:|');
  for (const [model, info] of Object.entries(summary.byModel)) {
    lines.push(`| ${model} | ${info.calls} | ${fmtCost(info.cost)} |`);
  }
  lines.push('');

  // Degradation
  if (summary.degradedCalls > 0) {
    lines.push('## Degradation');
    lines.push('');
    lines.push(`Calls with degradation: ${summary.degradedCalls}/${summary.calls}`);
    lines.push('');
    lines.push('| Step | Count |');
    lines.push('|------|------:|');
    for (const [step, count] of Object.entries(summary.degradationSteps).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${step} | ${count}/${summary.calls} |`);
    }
    lines.push('');
  }

  // Admin API
  if (adminSummary) {
    const delta = adminSummary.totalCost - summary.totalCost;
    lines.push('## Admin API (Actual Billed)');
    lines.push('');
    lines.push(`| Source | Cost |`);
    lines.push(`|--------|-----:|`);
    lines.push(`| API-reported | ${fmtCost(adminSummary.totalCost)} |`);
    lines.push(`| Telemetry | ${fmtCost(summary.totalCost)} |`);
    lines.push(`| Delta | ${fmtCost(Math.abs(delta))} (${delta > 0 ? 'API higher' : 'telemetry higher'}) |`);
    lines.push('');
    lines.push('> Note: Admin API reports all usage for the time window, which may include other concurrent API activity.');
    lines.push('');
  }

  console.log(lines.join('\n'));
}

// ─── Text output ────────────────────────────────────────────────────────────

function printTextReport(results, summary, ratesData, adminSummary) {
  const rateSource = ratesData?.last_updated ? `rates from ${ratesData.last_updated}` : 'unknown rates';

  console.log('');
  console.log('='.repeat(80));
  console.log('  CLAUDE API COST REPORT');
  console.log('='.repeat(80));
  console.log(`  Pricing: ${rateSource} (${ratesData?.source || 'bundled'})`);
  console.log('');

  // ── Per-call table ──
  if (results.length <= 50) {
    console.log('─── Per-Call Breakdown ─────────────────────────────────────────────────────────');
    console.log(
      '  #'.padEnd(5) +
      'Timestamp'.padEnd(28) +
      'Model'.padEnd(10) +
      'Input'.padStart(10) +
      'Output'.padStart(9) +
      'CacheRd'.padStart(9) +
      'CacheWr'.padStart(9) +
      'Cost'.padStart(10) +
      '  Degradation'
    );
    console.log('  ' + '─'.repeat(78));

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const ts = r.timestamp ? r.timestamp.slice(0, 19) : '—';
      const modelShort = r.model.replace('claude-', '').replace(/-\d{8}$/, '').slice(0, 8);
      const cacheWr = (r.cw1h || 0) + (r.cw5m || 0);
      const deg = r.degradation.length > 0 ? r.degradation.length + ' steps' : '';

      console.log(
        `  ${String(i + 1).padStart(2)}  ` +
        ts.padEnd(28) +
        modelShort.padEnd(10) +
        fmt(r.input_tokens).padStart(10) +
        fmt(r.output_tokens).padStart(9) +
        fmt(r.cache_read).padStart(9) +
        fmt(cacheWr).padStart(9) +
        fmtCost(r.cost).padStart(10) +
        '  ' + deg
      );
    }
    console.log('');
  }

  // ── Summary ──
  console.log('─── Summary ────────────────────────────────────────────────────────────────────');
  console.log(`  Total API calls:      ${summary.calls}`);
  console.log(`  Total input tokens:   ${fmt(summary.totals.input)}`);
  console.log(`  Total output tokens:  ${fmt(summary.totals.output)}`);
  console.log(`  Total cache read:     ${fmt(summary.totals.cache_read)}`);
  console.log(`  Total cache write 1h: ${fmt(summary.totals.cache_1h)}`);
  console.log(`  Total cache write 5m: ${fmt(summary.totals.cache_5m)}`);
  if (summary.totals.preflight > 0) {
    const saved = summary.totals.preflight - summary.totals.input;
    const pct = (saved / summary.totals.preflight * 100).toFixed(1);
    console.log(`  Preflight estimate:   ${fmt(summary.totals.preflight)} (degradation saved ${fmt(saved)} tokens, ${pct}%)`);
  }
  console.log('');

  // ── By model ──
  console.log('  By model:');
  for (const [model, info] of Object.entries(summary.byModel)) {
    const modelShort = model.replace('claude-', '');
    console.log(`    ${modelShort}: ${info.calls} calls, ${fmtCost(info.cost)}`);
  }
  console.log('');

  // ── Cost ──
  console.log('─── Cost ───────────────────────────────────────────────────────────────────────');
  console.log(`  Telemetry-calculated:  ${fmtCost(summary.totalCost)}`);
  console.log(`  Avg cost per call:     ${fmtCost(summary.totalCost / summary.calls)}`);

  // Cache savings estimate
  if (summary.totals.cache_read > 0) {
    // What cache reads would have cost at full input rate
    const models = Object.keys(summary.byModel);
    if (models.length === 1) {
      const rates = lookupRates(ratesData, models[0]);
      if (rates) {
        const fullCost = summary.totals.cache_read * rates.input / 1_000_000;
        const cacheCost = summary.totals.cache_read * rates.cache_read / 1_000_000;
        const saved = fullCost - cacheCost;
        console.log(`  Cache read savings:    ${fmtCost(saved)} (${(saved / summary.totalCost * 100).toFixed(1)}% of total)`);
      }
    }
  }

  // ── Cost factor (overhead ratio) ──
  // Credit: this metric was popularized by @fgrosswig's claude-usage-dashboard
  // (https://github.com/fgrosswig/claude-usage-dashboard). It divides total
  // tokens processed (input + output + cache_read + cache_creation) by useful
  // output tokens, giving a single-number "how much context am I carrying
  // per useful word of output" multiplier. Values climb over long sessions
  // due to resume/compaction cycles; a rising curve is a signal that cache
  // efficiency is degrading.
  const totalCacheCreate = summary.totals.cache_1h + summary.totals.cache_5m;
  const grossTokens = summary.totals.input + summary.totals.output +
                      summary.totals.cache_read + totalCacheCreate;
  if (summary.totals.output > 0) {
    const costFactor = grossTokens / summary.totals.output;
    console.log(`  Cost factor:           ${costFactor.toFixed(1)}× (tokens/output)`);
  }
  console.log('');

  // ── Degradation ──
  if (summary.degradedCalls > 0) {
    console.log('─── Degradation ────────────────────────────────────────────────────────────────');
    console.log(`  Calls with degradation: ${summary.degradedCalls}/${summary.calls}`);
    console.log(`  Budget exceeded:        ${summary.exceededCalls}/${summary.calls}`);
    for (const [step, count] of Object.entries(summary.degradationSteps).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${step}: ${count}/${summary.calls}`);
    }
    console.log('');
  }

  // ── Admin API comparison ──
  if (adminSummary) {
    console.log('─── Admin API (Actual Billed) ──────────────────────────────────────────────────');
    console.log(`  API-reported total:    ${fmtCost(adminSummary.totalCost)}`);
    console.log(`  Telemetry total:       ${fmtCost(summary.totalCost)}`);
    const delta = adminSummary.totalCost - summary.totalCost;
    console.log(`  Delta:                 ${fmtCost(Math.abs(delta))} (${delta > 0 ? 'API higher' : 'telemetry higher'})`);
    console.log('');
    console.log('  API breakdown by model:');
    for (const [model, m] of Object.entries(adminSummary.byModel)) {
      const modelShort = model.replace('claude-', '');
      console.log(`    ${modelShort}:`);
      console.log(`      Uncached input:    ${fmt(m.uncached)}`);
      console.log(`      Cache read:        ${fmt(m.cache_read)}`);
      console.log(`      Cache write (1h):  ${fmt(m.cache_1h)}`);
      console.log(`      Cache write (5m):  ${fmt(m.cache_5m)}`);
      console.log(`      Output:            ${fmt(m.output)}`);
      console.log(`      Cost:              ${fmtCost(m.cost)}`);
    }
    console.log('');
    console.log('  NOTE: Admin API reports all usage for the sim\'s time window,');
    console.log('        which may include other concurrent API activity.');
  }

  console.log('='.repeat(80));
  console.log('');
}

// ─── Time window extraction ─────────────────────────────────────────────────

function getTimeWindow(entries) {
  const timestamps = entries
    .filter(e => e.timestamp)
    .map(e => new Date(e.timestamp));

  if (timestamps.length === 0) return null;

  return {
    start: new Date(Math.min(...timestamps)),
    end: new Date(Math.max(...timestamps)),
  };
}

// ─── Time filtering ─────────────────────────────────────────────────────────

function parseSinceDuration(since) {
  const match = since.match(/^(\d+)\s*(h|m|d)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 'h' ? n * 3600000 : unit === 'm' ? n * 60000 : n * 86400000;
  return new Date(Date.now() - ms);
}

function filterByTime(entries, opts) {
  if (!opts.date && !opts.since) return entries;

  let cutoff = null;
  let dateEnd = null;

  if (opts.date) {
    // Filter to a specific date (YYYY-MM-DD)
    cutoff = new Date(opts.date + 'T00:00:00');
    dateEnd = new Date(opts.date + 'T23:59:59.999');
  } else if (opts.since) {
    cutoff = parseSinceDuration(opts.since);
    if (!cutoff) {
      console.error(`WARNING: Could not parse --since "${opts.since}". Use format like 2h, 30m, 1d.`);
      return entries;
    }
  }

  const before = entries.length;
  const filtered = entries.filter(e => {
    if (!e.timestamp) return true; // keep entries without timestamps
    const ts = new Date(e.timestamp);
    if (cutoff && ts < cutoff) return false;
    if (dateEnd && ts > dateEnd) return false;
    return true;
  });

  if (filtered.length < before) {
    console.error(`Filtered: ${before} → ${filtered.length} entries (${opts.date ? 'date ' + opts.date : 'since ' + opts.since}).`);
  }

  return filtered;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.help) { printUsage(); process.exit(0); }

  // ── Update rates mode ──
  if (opts.updateRates) {
    console.log(`Fetching rates from ${PRICING_URL}...`);
    const live = await fetchLiveRates();
    if (live) {
      writeFileSync(RATES_PATH, JSON.stringify(live, null, 2) + '\n');
      console.log(`Updated ${RATES_PATH} with ${Object.keys(live.models).length} models (${live.last_updated}).`);
    } else {
      console.error('Failed to fetch rates. Bundled rates unchanged.');
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Load rates ──
  let ratesData;
  if (opts.liveRates) {
    ratesData = await fetchLiveRates();
  }
  if (!ratesData) {
    ratesData = loadBundledRates();
  }
  if (!ratesData) {
    console.error('ERROR: No rate data available. Run with --update-rates first.');
    process.exit(1);
  }

  // ── Load telemetry ──
  let rawEntries;
  if (opts.simLog) {
    rawEntries = extractFromSimLog(opts.simLog);
  } else if (opts.file) {
    rawEntries = parseJsonLines(readFileSync(opts.file, 'utf8'));
  } else if (!process.stdin.isTTY) {
    rawEntries = parseJsonLines(await readStdin());
  } else if (existsSync(DEFAULT_USAGE_LOG)) {
    // Default: read interceptor usage log
    rawEntries = parseJsonLines(readFileSync(DEFAULT_USAGE_LOG, 'utf8'));
    if (rawEntries.length > 0) {
      console.error(`Reading from ${DEFAULT_USAGE_LOG}`);
    }
  } else {
    console.error(`ERROR: No input found. Expected interceptor log at ${DEFAULT_USAGE_LOG}`);
    console.error('       Use --file, --sim-log, or pipe JSON-lines to stdin.');
    printUsage();
    process.exit(1);
  }

  if (!rawEntries || rawEntries.length === 0) {
    console.error('ERROR: No telemetry entries found.');
    process.exit(1);
  }

  // ── Apply time filters ──
  rawEntries = filterByTime(rawEntries, opts);

  if (rawEntries.length === 0) {
    console.error('ERROR: No entries match the time filter.');
    process.exit(1);
  }

  console.error(`Loaded ${rawEntries.length} telemetry entries.`);

  // ── Normalize and calculate ──
  const entries = rawEntries.map(normalizeEntry);
  const { results, summary } = calculateCosts(entries, ratesData);

  // ── Admin API cross-reference ──
  let adminSummary = null;
  if (opts.adminKey) {
    const window = getTimeWindow(entries);
    if (window) {
      console.error(`Querying Admin API for ${window.start.toISOString()} → ${window.end.toISOString()}...`);
      const apiData = await fetchAdminUsage(opts.adminKey, window.start, window.end);
      if (apiData) {
        adminSummary = summarizeAdminData(apiData, ratesData);
      }
    } else {
      console.error('WARNING: No timestamps in telemetry; cannot query Admin API.');
    }
  }

  // ── Output ──
  printReport(results, summary, ratesData, adminSummary, opts.format);
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
