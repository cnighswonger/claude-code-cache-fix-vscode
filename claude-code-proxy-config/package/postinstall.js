#!/usr/bin/env node
console.log(`
┌─────────────────────────────────────────────────────────────────────┐
│  claude-code-cache-fix — SECURITY NOTICE                           │
│                                                                     │
│  This interceptor patches globalThis.fetch to fix prompt cache      │
│  bugs in Claude Code. By design, it has full read/write access      │
│  to all API requests and responses in the Claude Code process.      │
│                                                                     │
│  • All telemetry is LOCAL ONLY (no network calls from interceptor)  │
│  • Source is a single unminified file: preload.mjs (~1,700 lines)   │
│  • Review before use: github.com/cnighswonger/claude-code-cache-fix │
│                                                                     │
│  Independent audit: github.com/anthropics/claude-code/issues/38335  │
│  (search "TheAuditorTool" — assessed as LEGITIMATE TOOL)            │
└─────────────────────────────────────────────────────────────────────┘
`);
