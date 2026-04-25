# claude-code-cache-fix

[English](./README.md) | 中文

修复 [Claude Code](https://github.com/anthropics/claude-code) 中导致恢复会话时**成本增加高达 20 倍**的提示缓存回归问题，同时监控静默上下文降级。已在 v2.1.92 至 v2.1.97 上验证。

## 问题描述

当你在 Claude Code 中使用 `--resume` 或 `/resume` 时，提示缓存会静默失效。API 不再读取已缓存的 token（廉价），而是每一轮都从头重建（昂贵）。原本每小时约 $0.50 的会话可能在无任何提示的情况下飙升至 $5-10/小时。

三个 bug 导致了这个问题：

1. **附件块散布** — 技能列表、MCP 服务器、延迟工具、钩子等附件块应当位于 `messages[0]` 中。恢复会话时，它们会漂移到后续消息中，改变缓存前缀。

2. **指纹不稳定** — `cc_version` 指纹（如 `2.1.92.a3f`）是根据 `messages[0]` 的内容计算的，包括元数据/附件块。当这些块发生偏移时，指纹改变，系统提示改变，缓存失效。

3. **工具定义排序不确定** — 工具定义在不同轮次间可能以不同顺序到达，改变请求字节并使缓存键失效。

此外，通过 Read 工具读取的图片会以 base64 形式持久化在对话历史中，在每次后续 API 调用时一并发送，悄然增加 token 成本。

## 安装

需要 Node.js >= 18，且 Claude Code 通过 npm 安装（非独立二进制文件）。

```bash
npm install -g claude-code-cache-fix
```

## 使用方法

本修复以 Node.js 预加载模块的形式工作，在 API 请求离开本机之前进行拦截。

### 方式 A：包装脚本（推荐）

创建包装脚本（如 `~/bin/claude-fixed`）：

```bash
#!/bin/bash
CLAUDE_NPM_CLI="$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js"

if [ ! -f "$CLAUDE_NPM_CLI" ]; then
  echo "Error: Claude Code npm package not found at $CLAUDE_NPM_CLI" >&2
  echo "Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

exec env NODE_OPTIONS="--import claude-code-cache-fix" node "$CLAUDE_NPM_CLI" "$@"
```

```bash
chmod +x ~/bin/claude-fixed
```

如果你的 npm 全局前缀不同，请相应调整 `CLAUDE_NPM_CLI`。使用以下命令查找：

```bash
npm root -g
```

### 方式 B：Shell 别名

```bash
alias claude='NODE_OPTIONS="--import claude-code-cache-fix" node "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
```

### 方式 C：直接调用

```bash
NODE_OPTIONS="--import claude-code-cache-fix" claude
```

> **注意**：仅在 `claude` 指向 npm/Node 安装时有效。独立二进制文件使用不同的执行路径，会绕过 Node.js 预加载。

## 工作原理

模块在 Claude Code 向 `/v1/messages` 发起 API 调用前拦截 `globalThis.fetch`。每次调用时：

1. **扫描所有用户消息**中的附件块（技能、MCP、延迟工具、钩子），将每种类型的最新版本移回 `messages[0]`，匹配全新会话的布局
2. **按名称字母顺序排列工具定义**，确保确定性排序
3. **重新计算 cc_version 指纹**，基于真实用户消息文本而非元数据/附件内容

所有修复都是幂等的 — 如果无需修复，请求将原样传递。拦截器对你的对话是只读的；它只在请求到达 API 之前规范化请求结构。

## 图片剥离

通过 Read 工具读取的图片以 base64 编码存储在对话历史的 `tool_result` 块中。它们会**在每次后续 API 调用中**随行发送，直到压缩。单张 500KB 的图片每轮带来约 62,500 token 的额外开销。

启用图片剥离以移除旧的工具结果中的图片：

```bash
export CACHE_FIX_IMAGE_KEEP_LAST=3
```

这将保留最近 3 条用户消息中的图片，并将较早的替换为文本占位符。仅针对 `tool_result` 块（Read 工具输出）中的图片 — 用户粘贴的图片不受影响。文件仍保留在磁盘上，需要时可重新读取。

设为 `0`（默认）以禁用。

## 系统提示词重写（可选）

拦截器还可以在请求发出前，重写 Claude Code 的 `# Output efficiency` 系统提示词段落。

此功能是**可选的**，并且**默认关闭**。如果未设置 `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT`，则不会做任何修改。

通过设置替换文本启用：

```bash
export CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT=$'# Output efficiency\n\n...'
```

该重写被刻意限制在很小的范围内：

- 只替换 Claude Code 的 `# Output efficiency` 这一节
- 其他系统提示词段落会被保留
- 现有的 system block 结构以及 `cache_control` 等字段会被保留

这对那些希望继续使用较新版本的 Claude Code、但又想尝试不同 `Output efficiency` 指令集而不是降级到旧版本的用户，可能会有帮助。

### 提示词版本

<details>
<summary>Anthropic 内部 / <code>USER_TYPE=ant</code> 版本</summary>

```text
# Output efficiency

When sending user-facing text, you're writing for a person, not logging to a console. Assume users can't see most tool calls or thinking - only your text output. Before your first tool call, briefly state what you're about to do. While working, give short updates at key moments: when you find something load-bearing (a bug, a root cause), when changing direction, when you've made progress without an update.

When you give updates, assume the recipient may have stepped away and lost the thread. They do not know your internal shorthand, codenames, or half-formed plan. Write in complete, grammatical sentences that can be understood cold. Spell out technical terms when helpful. If unsure, err on the side of a bit more explanation. Adapt to the user's expertise: experts can handle denser updates, but don't make novice users reconstruct context on their own.

User-facing text should read like natural prose. Avoid clipped sentence fragments, excessive dashes, symbolic shorthand, or formatting that reads like console output. Use tables only when they genuinely improve scanability, such as compact facts (files, lines, pass/fail) or quantitative comparisons. Keep explanatory reasoning in prose around the table, not inside it. Avoid semantic backtracking: structure sentences so the user can follow them linearly without having to reinterpret earlier clauses after reading later ones.

Optimize for fast human comprehension, not minimal surface area. If the user has to reread your summary or ask a follow-up just to understand what happened, you saved the wrong tokens. Match the level of structure to the task: for a simple question, answer in plain prose without unnecessary headings or numbered lists. While staying clear and direct, also be concise and avoid fluff. Skip filler, obvious restatements, and throat-clearing. Get to the point. Don't over-focus on low-signal details from your process. When it helps, use an inverted pyramid structure with the conclusion first and details later.

These user-facing text instructions do not apply to code or tool calls.
```

</details>

<details>
<summary>公开 / 默认 Claude Code 版本</summary>

```text
# Output efficiency

IMPORTANT: Go straight to the point. Try the simplest approach first without going in circles. Do not overdo it. Be extra concise.

Your text output is brief, direct, and to the point. Lead with the answer or action, not the reasoning. Omit filler, preamble, and unnecessary transitions. Do not restate the user's request; move directly to the work. When explanation is needed, include only what helps the user understand the outcome.

Prioritize user-facing text for:
- decisions that require user input
- high-signal progress updates at natural milestones
- errors or blockers that change the plan

If a sentence can do the job, do not turn it into three. Favor short, direct constructions over long explanatory prose. These instructions do not apply to code or tool calls.
```

</details>

<details>
<summary>自定义替换示例（结合上面两版的折中版本）</summary>

```text
# Output efficiency

When sending user-facing text, write for a person, not a log file. Assume the user cannot see most tool calls or hidden reasoning - only your text output.

Keep user-facing text clear, direct, and reasonably concise. Lead with the answer or action. Skip filler, repetition, and unnecessary preamble.

Explain enough for the user to understand the reasoning, tradeoffs, or root cause when that would help them learn or make a decision, but do not turn simple answers into long writeups.

These instructions apply to user-facing text only. They do not apply to investigation, code reading, tool use, or verification.

Before making changes, read the relevant code and understand the surrounding context. Check types, signatures, call sites, and error causes before editing. Do not confuse brevity with rushing, and do not replace understanding with trial and error.

While working, give short updates at meaningful moments: when you find the root cause, when the plan changes, when you hit a blocker, or when a meaningful milestone is complete. Do not narrate every step.

When reporting results, be accurate and concrete. If you did not verify something, say so plainly. If a check failed, say that plainly too.
```

</details>

## 监控功能

拦截器包含社区发现的多项额外问题的监控：

### 微压缩 / 预算执行

Claude Code 通过服务器控制机制（GrowthBook 标志）静默替换旧的工具结果为 `[Old tool result content cleared]`。200,000 字符的聚合上限和每工具上限（Bash: 30K, Grep: 20K）会截断较早的结果且无通知。

拦截器检测已清除的工具结果并记录计数。当总工具结果字符数接近 200K 阈值时，会记录警告。

### 虚假速率限制器

客户端可以在不发起 API 调用的情况下生成合成的 "Rate limit reached" 错误，可通过 `"model": "<synthetic>"` 识别。拦截器会记录这些事件。

### 配额追踪

解析响应头中的 `anthropic-ratelimit-unified-5h-utilization` 和 `7d-utilization`，保存到 `~/.claude/quota-status.json`，供状态栏钩子或其他工具使用。

### 高峰时段检测

Anthropic 在工作日高峰时段（UTC 13:00-19:00，周一至周五）会提高配额消耗速率。拦截器检测高峰窗口并将 `peak_hour: true/false` 写入 `quota-status.json`。详见 `docs/peak-hours-reference.md`。

### 使用量遥测与成本报告

拦截器将每次调用的使用数据记录到 `~/.claude/usage.jsonl` — 每次 API 调用一行 JSON，包含模型、token 计数和缓存明细。使用内置的成本报告工具分析费用：

```bash
node tools/cost-report.mjs                    # 从拦截器日志查看今日费用
node tools/cost-report.mjs --date 2026-04-08  # 指定日期
node tools/cost-report.mjs --since 2h         # 最近 2 小时
node tools/cost-report.mjs --admin-key <key>  # 与 Admin API 交叉验证
```

同样适用于任何包含 Anthropic 使用量字段的 JSONL（`--file`、stdin）— 适合 SDK 用户和代理设置。支持文本、JSON 和 Markdown 输出格式。详见 `docs/cost-report.md`。

## 调试模式

启用调试日志以验证修复是否生效：

```bash
CACHE_FIX_DEBUG=1 claude-fixed
```

日志写入 `~/.claude/cache-fix-debug.log`。重点关注：

- `APPLIED: resume message relocation` — 块散布已检测并修复
- `APPLIED: tool order stabilization` — 工具已重新排序
- `APPLIED: fingerprint stabilized from XXX to YYY` — 指纹已被纠正
- `APPLIED: stripped N images from old tool results` — 已从旧工具结果中剥离图片
- `APPLIED: output efficiency section rewritten` — `output efficiency` 段已被替换
- `MICROCOMPACT: N/M tool results cleared` — 检测到微压缩降级
- `BUDGET WARNING: tool result chars at N / 200,000 threshold` — 接近预算上限
- `FALSE RATE LIMIT: synthetic model detected` — 检测到客户端侧虚假速率限制
- `GROWTHBOOK FLAGS: {...}` — 首次调用时记录的服务器控制标志
- `PROMPT SIZE: system=N tools=N injected=N (skills=N mcp=N ...)` — 每次调用的提示体积明细
- `CACHE TTL: tier=1h create=N read=N hit=N% (1h=N 5m=N)` — TTL 档位和每次调用的缓存命中率
- `PEAK HOUR: weekday 13:00-19:00 UTC` — Anthropic 高峰时段限流生效
- `SKIPPED: resume relocation (not a resume or already correct)` — 无需修复
- `SKIPPED: output efficiency rewrite (section not found)` — 未找到匹配的 `output efficiency` 段

### Prefix diff mode

启用跨进程前缀快照差异对比，以诊断重启后的缓存失效：

```bash
CACHE_FIX_PREFIXDIFF=1 claude-fixed
```

快照会保存到 `~/.claude/cache-fix-snapshots/`，并在重启后的第一次 API 调用时生成差异报告。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CACHE_FIX_DEBUG` | `0` | 启用调试日志 |
| `CACHE_FIX_PREFIXDIFF` | `0` | 启用前缀快照差异对比 |
| `CACHE_FIX_IMAGE_KEEP_LAST` | `0` | 保留最近 N 条用户消息中的图片（0 = 禁用） |
| `CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT` | unset | 在请求发出前替换 Claude Code 的 `# Output efficiency` 系统提示词段落 |
| `CACHE_FIX_USAGE_LOG` | `~/.claude/usage.jsonl` | 每次调用使用量遥测日志路径 |

## 限制

- **仅支持 npm 安装** — 独立 Claude Code 二进制文件具有 Zig 级别的证明机制，会绕过 Node.js。本修复仅适用于 npm 包（`npm install -g @anthropic-ai/claude-code`）。
- **超额 TTL 降级** — 超过 5 小时配额的 100% 会触发服务器端 TTL 从 1h 降级至 5m。这是服务器端决策，无法在客户端修复。拦截器通过防止缓存不稳定来避免你首先进入超额状态。
- **微压缩不可阻止** — 监控功能可以检测上下文降级，但无法阻止。微压缩和预算执行机制是通过 GrowthBook 标志进行服务器控制的，没有客户端禁用选项。
- **系统提示词重写是实验性的** — 此 hook 只会重写一个系统提示词段落，并且默认关闭，但仍存在未知因素：目前并未证明这段提示词文本本身就是社区报告中行为差异的根因，也无法确认未来服务端校验是否会对修改后的系统提示词作出反应。使用风险由用户自行承担。
- **版本耦合** — 指纹 salt 和块检测启发式规则都来自 Claude Code 内部实现。重大重构可能需要更新此包。

## 相关问题

- [#34629](https://github.com/anthropics/claude-code/issues/34629) — 恢复缓存回归的原始报告
- [#40524](https://github.com/anthropics/claude-code/issues/40524) — 会话内指纹失效，图片持久化
- [#42052](https://github.com/anthropics/claude-code/issues/42052) — 社区拦截器开发，TTL 降级发现
- [#43044](https://github.com/anthropics/claude-code/issues/43044) — 恢复会话后在 v2.1.91 上仅加载 0% 上下文
- [#43657](https://github.com/anthropics/claude-code/issues/43657) — 在 v2.1.92 上确认恢复会话导致缓存失效
- [#44045](https://github.com/anthropics/claude-code/issues/44045) — SDK 层面的复现与 token 测量
- [#32508](https://github.com/anthropics/claude-code/issues/32508) — 关于 `Output efficiency` 系统提示词变更及其可能影响模型行为的社区讨论

## 生产环境使用

- **[Crunchloop DAP](https://dap.crunchloop.ai)** — Agent SDK / DAP 开发环境。首个将本拦截器合入 trunk 并团队级部署的生产团队（2026-04-10）。通过真实环境测试发现两类不同的缓存回归问题——工具排序抖动与 fresh-session 排序漏洞，并贡献了驱动 v1.5.1 与 v1.6.2 修复的调试日志。

## 贡献者

- **[@VictorSun92](https://github.com/VictorSun92)** — 原始 v2.1.88 monkey-patch 修复作者，识别出 v2.1.90 中的部分块散布问题，并贡献了前向扫描检测、正确的块排序、更严格的块匹配器，以及可选的 output-efficiency 重写 hook
- **[@bilby91](https://github.com/bilby91)** ([Crunchloop DAP](https://dap.crunchloop.ai)) — Agent SDK / DAP 生产环境验证、1h 缓存 TTL 确认、通过调试日志发现工具排序抖动（v1.5.1 修复）、通过 SKILLS SORT 诊断发现 fresh-session 排序 bug（v1.6.2 修复）。首个将本拦截器合入 trunk 的生产团队。
- **[@jmarianski](https://github.com/jmarianski)** — 通过 MITM 代理抓包和 Ghidra 逆向分析定位根因，并提供多模式缓存测试脚本
- **[@cnighswonger](https://github.com/cnighswonger)** — 指纹稳定化、工具顺序修复、图片剥离、监控功能、超额 TTL 降级发现，本包维护者
- **[@ArkNill](https://github.com/ArkNill)** — 微压缩机制分析、GrowthBook 标志文档整理、虚假速率限制识别
- **[@Renvect](https://github.com/Renvect)** — 图片重复发送问题发现、跨项目目录污染分析

如果你参与了这些问题的社区协作但尚未被列出，欢迎开 issue 或 PR，我们希望正确致谢每一位贡献者。

## 许可证

MIT
