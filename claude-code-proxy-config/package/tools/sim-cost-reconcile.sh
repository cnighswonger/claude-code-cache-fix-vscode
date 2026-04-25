#!/usr/bin/env bash
# sim-cost-reconcile — One-liner wrapper for running cost-report.mjs against
# a simulation log with admin API cross-reference enabled.
#
# Usage:
#   sim-cost-reconcile <sim-dir-or-log> [extra cost-report.mjs args...]
#
# Examples:
#   sim-cost-reconcile ~/git_repos/kanfei_test/kanfei-nowcast/.test_cache/simulations/realtime_sim_harnett_county_qlcs_2026_20260411_024836
#   sim-cost-reconcile path/to/simulation.log --format md > report.md
#
# Reads admin key from $ANTHROPIC_ADMIN_KEY or ~/.config/anthropic/admin-key.
# If no admin key is available, runs with telemetry only and warns.
#
# NOTE on admin reconciliation: the admin API returns data at 1h-bucket
# resolution, so if multiple sims (or other API activity) overlap the same
# hour, the admin total will include all of it. For an accurate multi-sim
# aggregate, run this on each sim and sum the telemetry totals, then pull
# the admin total once over the full window.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COST_REPORT="$SCRIPT_DIR/cost-report.mjs"

if [[ $# -lt 1 ]]; then
    echo "Usage: $(basename "$0") <sim-dir-or-log> [extra cost-report args...]" >&2
    exit 1
fi

TARGET="$1"
shift

# Resolve a dir to its simulation.log
if [[ -d "$TARGET" ]]; then
    LOG="$TARGET/simulation.log"
    if [[ ! -f "$LOG" ]]; then
        echo "ERROR: no simulation.log in $TARGET" >&2
        exit 1
    fi
elif [[ -f "$TARGET" ]]; then
    LOG="$TARGET"
else
    echo "ERROR: $TARGET is neither a file nor a directory" >&2
    exit 1
fi

# Load admin key
ADMIN_KEY_FILE="${HOME}/.config/anthropic/admin-key"
if [[ -n "${ANTHROPIC_ADMIN_KEY:-}" ]]; then
    KEY="$ANTHROPIC_ADMIN_KEY"
elif [[ -r "$ADMIN_KEY_FILE" ]]; then
    KEY="$(cat "$ADMIN_KEY_FILE")"
else
    echo "WARNING: no admin key found ($ADMIN_KEY_FILE missing, ANTHROPIC_ADMIN_KEY unset)" >&2
    echo "         running telemetry-only — pass --admin-key or set env var to enable reconciliation" >&2
    exec node "$COST_REPORT" --sim-log "$LOG" "$@"
fi

exec node "$COST_REPORT" --sim-log "$LOG" --admin-key "$KEY" "$@"
