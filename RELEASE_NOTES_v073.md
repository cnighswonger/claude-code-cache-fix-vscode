## What's new

### Auto-update on every activate

Previously the auto-install only triggered when `claude-code-cache-fix` was *missing*. Result: you'd install once, get a version pinned, and never see upstream releases. v0.7.3 fixes that — every activate hits `registry.npmjs.org/claude-code-cache-fix/latest` (~200ms direct HTTPS, no `npm` spawn), compares against the locally installed version, and runs `volta install claude-code-cache-fix@latest` (or `npm install -g`) if there's a newer release.

Honors corporate `httpsProxy` / `caFile` / `rejectUnauthorized` for users behind Zscaler / Netskope.

### Self-lock guard

The package directory is locked while our proxy runs out of it. If `volta`/`npm` tried to `rm -rf` mid-update, it would leave the install half-removed (zombie state). v0.7.3 probes port 9801 first — if anything is listening (proxy from another VS Code window, or a zombie from a prior session), it skips the update for this activate and retries on the next one. The check runs *before* we spawn our own proxy, so there's no self-lock.

### Settings section titles shortened

`Claude Code Cache Fix: Activation` → `CCC: Activation`, etc. VS Code already groups settings under "Claude Code Cache Fix" as the parent — the duplicated prefix was pushing the actual section name off-screen on narrow Settings panels.

## What you'll see in the proxy output channel

Up to date:
```
[2026-04-25T...] Update check: installed 3.1.1 is up to date (latest 3.1.1).
```

Update found:
```
[2026-04-25T...] Update available: 3.1.0 → 3.1.1. Installing.
[2026-04-25T...] Cache Fix: updating 3.1.0 → 3.1.1 via volta…
[2026-04-25T...] Updated to 3.1.1.
```

Locked (multi-window or zombie proxy):
```
[2026-04-25T...] Update check skipped: port 9801 is already in use, can't safely upgrade. Will retry next activate.
```

## Install

```
code --install-extension claude-code-cache-fix-0.7.3.vsix
```

If you're on `claude-code-cache-fix@3.1.0` (or older), reload VS Code after install — v0.7.3 will detect 3.1.1 is out and upgrade automatically before spawning the proxy.

## If you ever land in a half-uninstalled state

If a `volta install` was interrupted (Ctrl+C, system crash, etc.) and the package dir is partial, just run from a terminal:

```
volta install claude-code-cache-fix@latest
```

It cleans up and reinstalls. No need to do anything in VS Code.
