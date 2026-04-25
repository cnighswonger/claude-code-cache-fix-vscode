import { watch } from "node:fs";
import { loadExtensions } from "./pipeline.mjs";

let debounceTimer = null;

export function startWatcher(extensionsDir, configPath, opts = {}) {
  const debounceMs = opts.debounceMs ?? 100;
  const onReload = opts.onReload;

  function scheduleReload() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const exts = await loadExtensions(extensionsDir, configPath);
        if (onReload) onReload(exts);
      } catch (err) {
        process.stderr.write(`[watcher] reload failed: ${err.message}\n`);
      }
    }, debounceMs);
  }

  const dirWatcher = watch(extensionsDir, { persistent: false }, (eventType, filename) => {
    if (filename && filename.endsWith(".mjs")) {
      scheduleReload();
    }
  });

  let configWatcher = null;
  try {
    configWatcher = watch(configPath, { persistent: false }, () => {
      scheduleReload();
    });
  } catch {}

  return {
    close() {
      dirWatcher.close();
      if (configWatcher) configWatcher.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}
