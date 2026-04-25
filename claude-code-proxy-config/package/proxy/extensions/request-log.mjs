import { appendFile } from "node:fs/promises";

const LOG_PATH = process.env.CACHE_FIX_REQUEST_LOG || "";

export default {
  name: "request-log",
  description: "Optional NDJSON request timing log",
  enabled: false,
  order: 700,

  async onRequest(ctx) {
    ctx.meta._requestStart = Date.now();
    ctx.meta._requestModel = ctx.body.model || null;
  },

  async onResponseStart(ctx) {
    ctx.meta._responseStart = Date.now();
  },

  async onStreamEvent(ctx) {
    if (ctx.event?.type === "message_delta" && ctx.meta._requestStart && LOG_PATH) {
      const entry = {
        ts: new Date().toISOString(),
        model: ctx.meta._requestModel,
        latencyMs: (ctx.meta._responseStart || Date.now()) - ctx.meta._requestStart,
        outputTokens: ctx.event.usage?.output_tokens || 0,
        cacheRead: ctx.meta.cacheStats?.cacheRead || 0,
        cacheCreation: ctx.meta.cacheStats?.cacheCreation || 0,
      };
      try {
        await appendFile(LOG_PATH, JSON.stringify(entry) + "\n");
      } catch {}
    }
  },
};
