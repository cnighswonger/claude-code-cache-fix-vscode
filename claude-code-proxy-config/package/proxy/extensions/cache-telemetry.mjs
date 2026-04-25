export default {
  name: "cache-telemetry",
  description: "Extract cache hit/miss stats from response stream for monitoring",
  order: 600,

  async onStreamEvent(ctx) {
    const { event, telemetry } = ctx;
    if (!event || !telemetry) return;

    if (event.type === "message_start" && event.message?.usage) {
      const usage = event.message.usage;
      ctx.meta.cacheStats = {
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        inputTokens: usage.input_tokens || 0,
      };
    }

    if (event.type === "message_delta" && event.usage) {
      if (!ctx.meta.cacheStats) ctx.meta.cacheStats = {};
      ctx.meta.cacheStats.outputTokens = event.usage.output_tokens || 0;
    }
  },
};
