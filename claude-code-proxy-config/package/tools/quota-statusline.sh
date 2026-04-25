#!/bin/bash
# Status line: show quota % and burn rate from claude-meter JSONL
# Rate is calculated from window start (reset_time - window_size) to now
# No prev file needed — each reading is self-contained

input=$(cat)

JSONL="$HOME/.claude/claude-meter.jsonl"
QS="$HOME/.claude/quota-status.json"

# Primary source: claude-meter.jsonl (requires claude-code-meter package)
# Fallback: quota-status.json (written by claude-code-cache-fix interceptor)
if [ -f "$JSONL" ]; then
  last=$(tail -1 "$JSONL" 2>/dev/null)
elif [ -f "$QS" ]; then
  # Translate quota-status.json into the same shape the Python expects
  last=$(python3 -c "
import json, pathlib
qs = json.load(open(pathlib.Path.home() / '.claude' / 'quota-status.json'))
fh = qs.get('five_hour', {})
sd = qs.get('seven_day', {})
print(json.dumps({
    'q5h': fh.get('utilization', 0),
    'q7d': sd.get('utilization', 0),
    'q5h_reset': fh.get('resets_at', 0),
    'q7d_reset': sd.get('resets_at', 0),
    'qoverage': qs.get('overage_status', ''),
    'ts': qs.get('timestamp', ''),
}))
" 2>/dev/null)
else
  exit 0
fi

if [ -z "$last" ]; then exit 0; fi

  result=$(echo "$last" | python3 -c "
import sys, json
from datetime import datetime, timezone

r = json.load(sys.stdin)
q5h = int(r['q5h'] * 100)
q7d = int(r.get('q7d', 0) * 100)
overage = r.get('qoverage', '')
ts = r.get('ts', '')
q5h_reset = r.get('q5h_reset', 0)
q7d_reset = r.get('q7d_reset', 0)

now = datetime.fromisoformat(ts.replace('Z', '+00:00'))

# Q5h: 5-hour window, rate = pct / minutes elapsed since window start
rate5 = ''
if q5h_reset > 0:
    window_start = datetime.fromtimestamp(q5h_reset, tz=timezone.utc) - __import__('datetime').timedelta(hours=5)
    elapsed_min = (now - window_start).total_seconds() / 60
    if elapsed_min > 1 and q5h > 0:
        rate5 = '{:+.1f}'.format(q5h / elapsed_min)

# Q7d: 7-day window
rate7 = ''
if q7d_reset > 0:
    window_start_7d = datetime.fromtimestamp(q7d_reset, tz=timezone.utc) - __import__('datetime').timedelta(days=7)
    elapsed_min_7d = (now - window_start_7d).total_seconds() / 60
    if elapsed_min_7d > 1 and q7d > 0:
        rate7 = '{:+.1f}'.format(q7d / (elapsed_min_7d / 60))

label = 'Q5h: {}%'.format(q5h)
if rate5:
    label += ' ({}%/m)'.format(rate5)
label += ' | Q7d: {}%'.format(q7d)
if rate7:
    label += ' ({}%/hr)'.format(rate7)
if overage == 'active':
    label += ' | OVERAGE'

# Add TTL tier from quota-status.json (written by interceptor)
import os, pathlib
qs_path = pathlib.Path.home() / '.claude' / 'quota-status.json'
try:
    qs = json.load(open(qs_path))
    ttl = qs.get('cache', {}).get('ttl_tier', '')
    hit = qs.get('cache', {}).get('hit_rate', '')
    if ttl:
        if ttl == '5m':
            label += ' | \033[31mTTL:5m\033[0m'  # red
            # When on 5m tier, show the cold-rebuild size so users know
            # the cost of idling past 5 minutes
            cache_cr = qs.get('cache', {}).get('cache_creation', 0)
            cache_rd = qs.get('cache', {}).get('cache_read', 0)
            prefix = cache_cr + cache_rd
            if prefix > 0:
                if prefix >= 1_000_000:
                    label += ' \033[31m\u26A0 idle >5m = {:.1f}M rebuild\033[0m'.format(prefix / 1_000_000)
                else:
                    label += ' \033[31m\u26A0 idle >5m = {:.0f}K rebuild\033[0m'.format(prefix / 1_000)
        else:
            label += ' | TTL:' + ttl
    if hit and hit != 'N/A':
        label += ' ' + hit + '%'
    peak = qs.get('peak_hour', False)
    if peak:
        label += ' | \033[33mPEAK\033[0m'  # yellow
except:
    pass

print(label)
" 2>/dev/null)

  [ -n "$result" ] && echo "$result"
