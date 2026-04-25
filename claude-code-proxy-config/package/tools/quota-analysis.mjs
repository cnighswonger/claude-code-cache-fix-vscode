#!/usr/bin/env node
/**
 * quota-analysis — Test how Anthropic's 5-hour quota is actually computed
 * by analyzing your own per-call telemetry.
 *
 * Reads usage.jsonl (the per-call log written by claude-code-cache-fix v1.6.1+)
 * and answers three questions:
 *
 *   1. Does cache_read count toward your 5-hour quota?
 *      Tests three hypotheses (cache_read costs 0x / 0.1x / 1x of input rate)
 *      and reports which one best explains the q5h_pct trajectory across
 *      reset windows in your data.
 *
 *   2. Do peak hours (weekday 13:00–19:00 UTC) cost more quota per token?
 *      Splits windows into peak-dominant vs off-peak-dominant and compares
 *      the implied 100% quota under the best-fit counting model.
 *
 *   3. What is your account's effective 5-hour quota in token-equivalents?
 *      Reports a concrete number you can compare against your subscription
 *      tier or against what other users are seeing.
 *
 * Telemetry requirements:
 *   - usage.jsonl entries must include q5h_pct, q7d_pct, peak_hour fields
 *   - These were added in claude-code-cache-fix v1.6.1 (2026-04-09)
 *   - Older entries are silently filtered out
 *   - Need at least 2 q5h reset events in the data for meaningful analysis
 *     (typically 10+ hours of active use)
 *
 * Methodology and caveats:
 *   - q5h is a 5-hour SLIDING window. We approximate it as discrete reset
 *     boundaries by looking for drops in q5h_pct >= 5 percentage points.
 *   - Token-equivalent weights: uncached_input = 1.0, output = 5.0,
 *     cache_creation = 2.0 (treats all writes as 1h-tier; the 5m tier is
 *     1.25 but most writes are 1h with the interceptor's TTL injection).
 *   - Coefficient of variation (CV) is used to compare hypotheses: lower
 *     CV across windows = better fit. CV < 50% suggests a clear winner;
 *     CV > 80% suggests the model is wrong or sample is too small.
 *   - Single-account analysis. Sample is yours. Findings should be
 *     compared across multiple accounts before generalizing.
 *
 * Part of claude-code-cache-fix. Works with the interceptor's usage log.
 * https://github.com/cnighswonger/claude-code-cache-fix
 *
 * Reference: anthropics/claude-code#45756 (cache_read quota counting hypothesis)
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_USAGE_LOG = join(homedir(), '.claude', 'usage.jsonl');

// Token-equivalent weights for the H_zero counting model.
// (cache_read weight is the variable being tested.)
const W_UNCACHED_INPUT = 1.0;
const W_OUTPUT = 5.0;
const W_CACHE_CREATION = 2.0;  // 1h tier conservative; 5m would be 1.25

// Q5h window boundary detection threshold (in percentage points)
const RESET_THRESHOLD = 5;

// Window classification thresholds
const PEAK_WINDOW_MIN_PCT = 80;     // >= 80% peak calls = peak-dominant window
const OFFPEAK_WINDOW_MAX_PCT = 20;  // <= 20% peak calls = offpeak-dominant window

// Minimum delta_q5h for a window to be useful for extrapolation
const MIN_DELTA_Q5H = 5;

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { file: null, since: null, format: 'text', help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--file' || a === '-f') opts.file = args[++i];
    else if (a === '--since' || a === '-s') opts.since = args[++i];
    else if (a === '--format') opts.format = args[++i];
    else if (a === '--json') opts.format = 'json';
    else { console.error(`Unknown argument: ${a}`); opts.help = true; }
  }
  return opts;
}

function printUsage() {
  console.log(`quota-analysis — analyze 5-hour quota counting from usage telemetry

Usage:
  quota-analysis [options]

Options:
  -f, --file <path>      JSONL file to read (default: ~/.claude/usage.jsonl)
  -s, --since <duration> Filter to last N hours/days (e.g. 24h, 3d, 7d)
      --format <fmt>     Output format: text (default), json, markdown
      --json             Shorthand for --format json
  -h, --help             Show this help

Examples:
  quota-analysis                        # Analyze your default log
  quota-analysis --since 24h            # Last 24 hours only
  quota-analysis --file /tmp/team.jsonl # A different log file
  quota-analysis --json > report.json   # Machine-readable output

Methodology:
  Tests three counting hypotheses for cache_read in the 5-hour quota:
    H_zero   = cache_read costs nothing for quota
    H_billed = cache_read costs 0.1x of input rate (matches the billing rate)
    H_full   = cache_read costs 1.0x of input rate (the original concern)
  The hypothesis with the lowest coefficient of variation across reset
  windows is the best fit for your data.

  Then splits windows into peak (weekday 13:00–19:00 UTC) and off-peak
  groups and compares the effective quota multiplier between them.

Reference:
  anthropics/claude-code#45756 — original "cache_read counts at full rate"
  hypothesis from @molu0219.
`);
}

// ─── Data loading ───────────────────────────────────────────────────────────

function loadUsage(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Error: usage file not found: ${filePath}`);
    console.error(`Hint: claude-code-cache-fix writes its log to ${DEFAULT_USAGE_LOG} by default.`);
    process.exit(1);
  }
  const text = readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); }
    catch { /* skip malformed */ }
  }
  return rows;
}

function filterSince(rows, since) {
  if (!since) return rows;
  const m = since.match(/^(\d+)([hd])$/);
  if (!m) {
    console.error(`Invalid --since format: ${since}. Expected like 24h, 3d.`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  const ms = m[2] === 'h' ? n * 3600 * 1000 : n * 86400 * 1000;
  const cutoff = new Date(Date.now() - ms).toISOString();
  return rows.filter(r => r.timestamp >= cutoff);
}

// ─── Window detection ───────────────────────────────────────────────────────

function findResetWindows(rows) {
  // Sort by timestamp (defensive — should already be sorted)
  rows = rows.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Find indices where q5h_pct drops by RESET_THRESHOLD or more
  // (these are window boundaries)
  const windowStarts = [0]; // first call is always a window start
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].q5h_pct;
    const cur = rows[i].q5h_pct;
    if (typeof prev === 'number' && typeof cur === 'number' && cur < prev - RESET_THRESHOLD) {
      windowStarts.push(i);
    }
  }
  windowStarts.push(rows.length); // sentinel for last window

  const windows = [];
  for (let i = 0; i < windowStarts.length - 1; i++) {
    const slice = rows.slice(windowStarts[i], windowStarts[i + 1]);
    if (slice.length === 0) continue;
    windows.push(slice);
  }
  return windows;
}

// ─── Token-equivalent calculation ───────────────────────────────────────────

function callEquivalent(r, cacheReadWeight) {
  return (
    (r.input_tokens || 0) * W_UNCACHED_INPUT
    + (r.output_tokens || 0) * W_OUTPUT
    + (r.cache_creation_input_tokens || 0) * W_CACHE_CREATION
    + (r.cache_read_input_tokens || 0) * cacheReadWeight
  );
}

function windowEquivalent(window, cacheReadWeight) {
  let sum = 0;
  for (const r of window) sum += callEquivalent(r, cacheReadWeight);
  return sum;
}

function windowDeltaQ5h(window) {
  const start = window[0].q5h_pct ?? 0;
  let peak = start;
  for (const r of window) {
    if (typeof r.q5h_pct === 'number' && r.q5h_pct > peak) peak = r.q5h_pct;
  }
  return peak - start;
}

function windowPeakFraction(window) {
  let peakCount = 0;
  for (const r of window) if (r.peak_hour) peakCount++;
  return peakCount / window.length;
}

// ─── Statistics helpers ─────────────────────────────────────────────────────

function mean(xs) {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sq = xs.map(x => (x - m) ** 2);
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / (xs.length - 1));
}

function cv(xs) {
  const m = mean(xs);
  if (m === 0) return Infinity;
  return stdev(xs) / m;
}

// ─── Counting model fit ─────────────────────────────────────────────────────

function fitCountingModels(windows) {
  // For each window, compute equivalent tokens under each hypothesis,
  // then extrapolate to 100% quota using the observed delta_q5h.
  // The model whose extrapolations are most consistent (lowest CV) wins.
  const models = {
    zero:   { weight: 0.0, label: 'H_zero (cache_read = 0.0x)',   extrapolations: [] },
    billed: { weight: 0.1, label: 'H_billed (cache_read = 0.1x)', extrapolations: [] },
    full:   { weight: 1.0, label: 'H_full (cache_read = 1.0x)',   extrapolations: [] },
  };

  for (const w of windows) {
    const delta = windowDeltaQ5h(w);
    if (delta < MIN_DELTA_Q5H) continue;

    for (const key of Object.keys(models)) {
      const eq = windowEquivalent(w, models[key].weight);
      const implied100 = eq / (delta / 100);
      models[key].extrapolations.push(implied100);
    }
  }

  // Compute CV for each model
  const usableWindows = models.zero.extrapolations.length;
  const fits = {};
  for (const key of Object.keys(models)) {
    const xs = models[key].extrapolations;
    fits[key] = {
      label: models[key].label,
      weight: models[key].weight,
      mean: mean(xs),
      stdev: stdev(xs),
      cv: cv(xs),
      values: xs,
    };
  }

  // Determine the best fit
  let bestKey = null;
  let bestCv = Infinity;
  for (const key of Object.keys(fits)) {
    if (fits[key].cv < bestCv) {
      bestCv = fits[key].cv;
      bestKey = key;
    }
  }

  return { fits, bestKey, usableWindows };
}

// ─── Peak vs off-peak analysis ─────────────────────────────────────────────

function peakSplit(windows, weight) {
  // Returns { peakWindows: [...], offPeakWindows: [...], skipped: [...] }
  // and computes mean implied 100% quota for each group under the given
  // cache_read weight.
  const peakDom = [];
  const offDom = [];
  const skipped = [];

  for (const w of windows) {
    const delta = windowDeltaQ5h(w);
    if (delta < MIN_DELTA_Q5H) {
      skipped.push({ reason: 'delta_q5h too small', window: w });
      continue;
    }
    const eq = windowEquivalent(w, weight);
    const implied100 = eq / (delta / 100);
    const pf = windowPeakFraction(w) * 100;

    const entry = {
      start: w[0].timestamp,
      end: w[w.length - 1].timestamp,
      calls: w.length,
      delta,
      peakFraction: pf,
      eq,
      implied100,
    };

    if (pf >= PEAK_WINDOW_MIN_PCT) peakDom.push(entry);
    else if (pf <= OFFPEAK_WINDOW_MAX_PCT) offDom.push(entry);
    else skipped.push({ reason: 'mixed peak/off-peak', ...entry });
  }

  return { peakDom, offDom, skipped };
}

// ─── Output rendering ───────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  if (n === null || n === undefined || !isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(decimals) + 'K';
  return n.toFixed(decimals);
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }

function printText(report) {
  const { meta, windows, fit, peak } = report;

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  CLAUDE 5-HOUR QUOTA ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();
  console.log(`Data source:      ${meta.file}`);
  console.log(`Total entries:    ${meta.totalRows}`);
  console.log(`With q5h_pct:     ${meta.withQuota} (${pct(meta.withQuota / meta.totalRows)})`);
  console.log(`Time range:       ${meta.timeStart}`);
  console.log(`             →    ${meta.timeEnd}`);
  console.log(`Reset windows:    ${windows.total} detected, ${windows.usable} usable for fit`);
  console.log();

  if (windows.usable < 2) {
    console.log('⚠  Not enough usable reset windows to fit counting models.');
    console.log('   Need at least 2 windows with q5h_pct increase ≥ 5%.');
    console.log('   Run the interceptor through more activity and try again.');
    return;
  }

  console.log('───────────────────────────────────────────────────────────────────────');
  console.log('  Per-window breakdown');
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log();
  console.log('  ' + 'Window'.padEnd(34) + 'Calls'.padStart(6) + 'Δq5h'.padStart(6) + 'Peak%'.padStart(7) + 'EqToks'.padStart(10) + '100%impl'.padStart(11));
  for (const wr of report.windowRows) {
    console.log('  ' + wr.label.padEnd(34) + String(wr.calls).padStart(6) + (wr.delta + '%').padStart(6) + (wr.peakFraction.toFixed(0) + '%').padStart(7) + fmt(wr.eq).padStart(10) + fmt(wr.implied100).padStart(11));
  }
  console.log();

  console.log('───────────────────────────────────────────────────────────────────────');
  console.log('  Q1: Does cache_read count toward 5h quota?');
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log();
  console.log('  Tests three hypotheses against your data. Lower CV = better fit.');
  console.log();
  console.log('  ' + 'Hypothesis'.padEnd(34) + 'Mean impl 100%'.padStart(18) + 'CV'.padStart(10));
  for (const key of ['zero', 'billed', 'full']) {
    const f = fit.fits[key];
    const marker = key === fit.bestKey ? ' ★' : '';
    console.log('  ' + f.label.padEnd(34) + (fmt(f.mean) + ' tok').padStart(18) + (f.cv === Infinity ? 'inf' : (f.cv * 100).toFixed(1) + '%').padStart(10) + marker);
  }
  console.log();
  console.log('  ★ = best fit (lowest coefficient of variation)');
  console.log();
  const bestFit = fit.fits[fit.bestKey];
  if (bestFit.cv < 0.5) {
    console.log(`  Verdict: ${bestFit.label} is the best fit (CV ${(bestFit.cv * 100).toFixed(1)}%).`);
    if (fit.bestKey === 'zero') {
      console.log('  Interpretation: cache_read does NOT meaningfully count toward your 5h quota.');
      console.log('  The cache really is saving you quota, not just billing.');
    } else if (fit.bestKey === 'billed') {
      console.log('  Interpretation: cache_read counts at the BILLING rate (0.1x of input).');
      console.log('  Quota and billing are aligned for cache reads.');
    } else {
      console.log('  Interpretation: cache_read counts at the FULL input rate for quota purposes.');
      console.log('  This means cache hits save you billing but NOT quota — a stealth multiplier.');
    }
  } else {
    console.log(`  Verdict: No clear winner. Best fit (${fit.fits[fit.bestKey].label}) has CV ${(fit.fits[fit.bestKey].cv * 100).toFixed(1)}%.`);
    console.log('  Likely cause: small sample, mixed-model traffic, or sliding-window noise.');
    console.log('  Run for longer and try again.');
  }
  console.log();

  console.log('───────────────────────────────────────────────────────────────────────');
  console.log('  Q2: Do peak hours cost more quota per token?');
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log();
  console.log(`  Peak hours: weekday 13:00–19:00 UTC (interceptor default)`);
  console.log();
  if (peak.peakDom.length === 0 && peak.offDom.length === 0) {
    console.log('  Not enough peak-dominant or off-peak-dominant windows to compare.');
    console.log('  Need at least 1 of each (≥80% same-bucket calls per window).');
  } else {
    console.log('  ' + 'Group'.padEnd(20) + 'Windows'.padStart(10) + 'Mean impl 100%'.padStart(20));
    if (peak.peakDom.length > 0) {
      const m = mean(peak.peakDom.map(p => p.implied100));
      console.log('  ' + 'Peak-dominant'.padEnd(20) + String(peak.peakDom.length).padStart(10) + (fmt(m) + ' tok').padStart(20));
    }
    if (peak.offDom.length > 0) {
      const m = mean(peak.offDom.map(p => p.implied100));
      console.log('  ' + 'Off-peak'.padEnd(20) + String(peak.offDom.length).padStart(10) + (fmt(m) + ' tok').padStart(20));
    }
    if (peak.peakDom.length > 0 && peak.offDom.length > 0) {
      const peakMean = mean(peak.peakDom.map(p => p.implied100));
      const offMean = mean(peak.offDom.map(p => p.implied100));
      const ratio = peakMean / offMean;
      console.log();
      if (ratio < 0.85) {
        console.log(`  ⚠  Peak windows imply ${pct(ratio)} of off-peak quota.`);
        console.log(`     That's a ${pct(1 - ratio)} effective quota REDUCTION during peak hours.`);
        console.log('     Same usage pattern, fewer tokens until you hit 100%.');
      } else if (ratio > 1.15) {
        console.log(`  Peak windows imply ${pct(ratio)} of off-peak quota — peak is MORE generous?`);
        console.log('  Unusual. Check your sample size and time range.');
      } else {
        console.log(`  Peak / off-peak ratio is ${pct(ratio)} — no significant peak penalty detected.`);
      }
    } else {
      console.log();
      console.log('  Need both peak-dominant AND off-peak-dominant windows for the comparison.');
    }
  }
  console.log();

  console.log('───────────────────────────────────────────────────────────────────────');
  console.log('  Q3: Implied 5h quota for your account');
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log();
  console.log(`  Under best-fit model (${fit.fits[fit.bestKey].label}):`);
  console.log(`    Mean implied 100% quota: ${fmt(fit.fits[fit.bestKey].mean)} token-equivalents`);
  console.log();
  console.log('  Token-equivalent weights used:');
  console.log(`    uncached input  × ${W_UNCACHED_INPUT}`);
  console.log(`    output          × ${W_OUTPUT}   (Opus output is 5x input rate)`);
  console.log(`    cache_creation  × ${W_CACHE_CREATION}   (1h tier; 5m tier would be 1.25)`);
  console.log(`    cache_read      × ${fit.fits[fit.bestKey].weight}   (this hypothesis)`);
  console.log();
  console.log('  Compare against your subscription tier and plan estimate. If your');
  console.log('  number is wildly different from other reports, your sample may be');
  console.log('  too small or your model mix may differ significantly.');
  console.log();

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();
  console.log('Caveats:');
  console.log('  • q5h is a 5-hour SLIDING window; we approximate as discrete resets');
  console.log('  • Single account; aggregate findings need cross-validation');
  console.log('  • cache_creation TTL weight averaged at 2.0; mixed 5m/1h would lower it');
  console.log('  • Only Anthropic knows the exact quota formula');
  console.log();
  console.log('Reference: anthropics/claude-code#45756');
  console.log('Report your findings: open an issue or PR on cnighswonger/claude-code-cache-fix');
}

function printJson(report) {
  console.log(JSON.stringify(report, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();
  if (opts.help) { printUsage(); return; }

  const filePath = opts.file || DEFAULT_USAGE_LOG;
  const rawRows = loadUsage(filePath);
  const filtered = filterSince(rawRows, opts.since);
  const withQuota = filtered.filter(r => typeof r.q5h_pct === 'number');

  if (withQuota.length === 0) {
    console.error('No entries with q5h_pct field found.');
    console.error('This field was added in claude-code-cache-fix v1.6.1 (2026-04-09).');
    console.error('Older log entries are silently filtered out.');
    process.exit(1);
  }

  withQuota.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const allWindows = findResetWindows(withQuota);
  const fit = fitCountingModels(allWindows);

  // Use the best-fit weight for the peak/off-peak analysis
  const bestWeight = fit.fits[fit.bestKey].weight;
  const peak = peakSplit(allWindows, bestWeight);

  // Build per-window rows for the breakdown table
  const windowRows = [];
  for (const w of allWindows) {
    const delta = windowDeltaQ5h(w);
    if (delta < MIN_DELTA_Q5H) continue;
    const eq = windowEquivalent(w, bestWeight);
    const implied100 = eq / (delta / 100);
    const pf = windowPeakFraction(w) * 100;
    windowRows.push({
      label: `${w[0].timestamp.slice(5, 16)} → ${w[w.length - 1].timestamp.slice(5, 16)}`,
      calls: w.length,
      delta,
      peakFraction: pf,
      eq,
      implied100,
    });
  }

  const report = {
    meta: {
      file: filePath,
      totalRows: rawRows.length,
      filteredRows: filtered.length,
      withQuota: withQuota.length,
      timeStart: withQuota[0].timestamp,
      timeEnd: withQuota[withQuota.length - 1].timestamp,
      since: opts.since,
    },
    windows: { total: allWindows.length, usable: fit.usableWindows },
    windowRows,
    fit,
    peak,
  };

  if (opts.format === 'json') printJson(report);
  else printText(report);
}

main();
