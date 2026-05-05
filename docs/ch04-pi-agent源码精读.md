# Ch04 · Pi Agent 内嵌运行时源码精读

> Gateway 是骨架，Pi Agent 是灵魂。这一章你会看清：OpenClaw 到底怎么把"别人家的 Agent SDK"缝进自己的架构，**既保留所有能力，又换上自己的皮肤**。

## 4.1 Pi 是谁？

Pi 是 **Mario Zechner** 开源的一组 Agent SDK：`@mariozechner/pi-ai` / `pi-agent-core` / `pi-coding-agent` / `pi-tui`，仓库在 [badlogic/pi-mono](https://github.com/badlogic/pi-mono)。它提供了一套**完整的编码 Agent 运行时**（工具调用循环、消息流、压缩、故障转移），和 Claude Code / Aider 是一个级别的东西。

OpenClaw 的做法是：**不 fork，不 spawn，直接 import**。

## 4.2 两种集成姿势的取舍

```
┌─────────────────────────────────────────────────────────────┐
│ Pi CLI 模式                                                  │
│   child_process.spawn("pi", ["..."])                         │
│   ├── 优点：进程隔离、崩溃不影响父                             │
│   └── 缺点：IPC 开销、难以注入工具、难以自定义事件处理         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ OpenClaw Embedded 模式（采用）                                │
│   import { createAgentSession } from "@mariozechner/pi-agent-core"│
│   ├── 优点：同进程调用、工具随便注、事件直接订阅              │
│   └── 缺点：Pi 崩溃带垮整个 Gateway（所以要认真处理错误）     │
└─────────────────────────────────────────────────────────────┘
```

对于"控制面一定要常驻"的 Gateway 而言，Embedded 模式把 SDK 当库用，**灵活度碾压 CLI 模式**。

## 4.3 入口函数：`runEmbeddedPiAgent`

真实代码位置可能在 `packages/agent/src/embedded.ts`（或类似）。签名大概长这样：

```ts
export async function runEmbeddedPiAgent(opts: {
  sessionId: string;
  sessionKey: string;      // 形如 "agent:main:whatsapp:+155..."
  sessionFile: string;     // JSONL 文件路径
  workspaceDir: string;    // 这个 Agent 的工作区
  config: OpenClawConfig;
  prompt: string;
  images?: Buffer[];
  provider: "anthropic" | "openai" | "google" | ...;
  model: string;
  timeoutMs: number;
  onBlockReply: (payload: BlockReply) => Promise<void>;
  // 还有 abortSignal、channelCtx、authProfile 等
}): Promise<AgentResult>
```

**一次完整的调用做了 6 件事**，下面逐个拆。

## 4.4 流程一：创建会话

```ts
// 伪代码
const loader = new DefaultResourceLoader({ workspaceDir });
const session = await createAgentSession({
  loader,
  model: resolveModel(opts.provider, opts.model),
  sessionFile: opts.sessionFile,
  tools: assembleTools(opts),          // ← 关键：工具装配，见 4.6
});

applySystemPromptOverrideToSession(session, renderPrompt(opts));
```

几个细节：

- **`DefaultResourceLoader`**：Pi 提供的资源加载器，负责读取工作区里的 `AGENTS.md` / `SOUL.md` / `TOOLS.md` 并注入 system prompt
- **`createAgentSession`**：Pi 的核心工厂函数，返回一个带 `prompt()` / `on()` / `compact()` 的会话对象
- **`applySystemPromptOverrideToSession`**：OpenClaw 的**按渠道/上下文动态覆盖系统提示词**的扩展

## 4.5 流程二：订阅事件（这是"内嵌模式"最值回票价的地方）

```ts
subscribeEmbeddedPiSession(session, {
  message_start:          e => { /* 新 assistant 消息开始 */ },
  message_update:         e => streamToChannel(e.delta),   // 流式打字
  message_end:            e => { /* 消息完成 */ },

  tool_execution_start:   e => notifyChannelTyping(),
  tool_execution_update:  e => { /* 工具执行中 */ },
  tool_execution_end:     e => logToolResult(e),

  turn_start:             e => { /* 一轮对话开始 */ },
  turn_end:               e => persistSession(session),

  agent_start:            e => { /* 整个 agent 运行开始 */ },
  agent_end:              e => finalizeReply(),

  compaction_start:       e => notifyCompacting(),
  compaction_end:         e => { /* 压缩完成 */ },
});
```

**为什么这个设计优雅**：

1. **渠道差异化反应**：WhatsApp 需要发"正在输入..."，Discord 需要发 typing indicator，Telegram 需要实时编辑消息——都在事件回调里做，Pi SDK 本身不用知道渠道存在
2. **可观测性**：Control UI 的"实时对话流"就是把这些事件原封不动推给 WS 客户端
3. **可中断**：通过 `AbortSignal` 传递到 tool execution，任何时刻可以打断

## 4.6 流程三：工具装配（六阶段流水线）

这是 Pi Agent 最复杂也最精彩的部分。工具不是一股脑塞给模型的，而是**过六道工序**：

```
阶段 1：基础工具
   Pi 内置 codingTools：read / bash / edit / write
   ↓
阶段 2：自定义替换
   用 exec / process 替换 bash（沙箱集成）
   重写 read/edit/write 以适配 Docker/SSH 沙箱
   ↓
阶段 3：OpenClaw 工具注入
   message / sessions_* / browser / canvas / cron / gateway ...
   ↓
阶段 4：渠道工具注入
   仅对应渠道生效（e.g. telegram.reply_with_markdown）
   ↓
阶段 5：策略过滤
   读取 tools.allow / tools.deny / profile / byProvider
   Deny 优先于 Allow；空 allow 默认拒绝运行
   ↓
阶段 6：Schema 标准化 + AbortSignal 包装
   - Gemini 需要特殊的 schema 清理
   - OpenAI 的 apply_patch 特殊处理
   - 所有工具包一层 AbortSignal
```

**代码定位建议**：找 `packages/agent/src/tools/assemble.ts` 或类似文件。一般会是一个 `assembleTools(opts)` 函数，一层层 `push` / `filter`。

**⚠️ 踩坑提醒**：阶段 5 的"空 allow 默认拒绝运行"非常重要——如果你的配置里写了 `tools.allow: ["query_db"]` 但没装对应插件，Gateway **在调 LLM 之前就停了**，不会让模型编造出"query_db 返回了 xxx"的幻觉。

## 4.7 流程四：提示词发送 + 工具循环

```ts
await session.prompt(effectivePrompt, { images: imageResult.images });
// ↑ 这一句内部是一个完整的 tool-calling 循环
```

内部简化流程：

```
while (not done) {
  llmResult = await callLLM(conversation, tools);
  if (llmResult.tool_calls) {
    for (const tc of llmResult.tool_calls) {
      emit("tool_execution_start", tc);
      result = await executeTool(tc);      // 这里可能调到 exec/browser/...
      emit("tool_execution_end", { tc, result });
      conversation.push({ role: "tool", content: result });
    }
    continue;
  }
  // 纯文本响应，结束
  emit("message_end");
  break;
}
```

**Pi SDK 做的事**：把这个循环、流式、重试、故障转移全部封装好。
**OpenClaw 做的事**：在循环外层包：事件订阅、工具装配、prompt 覆盖、错误分类、渠道回流。

## 4.8 流程五：压缩（长对话不爆上下文）

会话越来越长，迟早会 `context length exceeded`。OpenClaw 的处理路径大致是：**捕获超限错误 → 压缩历史 → 重新 prompt 原问题**。

```ts
if (isContextOverflowError(err)) {
  emit("compaction_start");
  await compactEmbeddedPiSessionDirect(session, {
    tokenBudget: computeAdaptiveBudget(),
  });
  emit("compaction_end");
  await session.prompt(originalPrompt);
}
```

此外还有两个关键 Hook（`compaction-safeguard` / `context-pruning`）在 `packages/agent/src/hooks/` 下，是 OpenClaw **在 Pi SDK 之外加的私货**。

> 📖 **完整的压缩机制、Hook 细节、以及"压缩后信息怎么找回"等问题**，在 [Ch05 · 记忆体系 §5.3.4~5.3.7](./ch05-记忆体系.md#534-自动压缩compaction) 有系统讲解。

## 4.9 流程六：认证轮换与故障转移

每个 provider 可以配多个 API Key：

```json
{
  "providers": {
    "anthropic": {
      "authProfiles": [
        { "id": "primary",   "apiKey": "sk-ant-A...", "priority": 1 },
        { "id": "backup",    "apiKey": "sk-ant-B...", "priority": 2 },
        { "id": "emergency", "apiKey": "sk-ant-C...", "priority": 3 }
      ]
    }
  }
}
```

运行时行为：

```
调 Anthropic → 429 rate limit
  ↓
isRateLimitAssistantError(err)? → 是
  ↓
冷却当前 profile（e.g. 60s）
  ↓
切到 priority=2 的 backup
  ↓
成功
```

如果**所有 profile 都失败**，抛 `FailoverError`，触发跨 provider 故障转移（anthropic → openai 之类）。

**错误分类器全家桶**：

| 分类函数 | 作用 |
|---------|------|
| `isContextOverflowError` | 上下文超限 |
| `isCompactionFailureError` | 压缩失败 |
| `isAuthAssistantError` | 认证错 |
| `isRateLimitAssistantError` | 限流 |
| `isFailoverAssistantError` | 故障转移信号 |

这些函数在 `packages/agent/src/errors/` 下，是**纯字符串匹配**（因为各家 LLM 厂商的错误格式完全不统一）。你改源码遇到新的错误文案，就在这里加一行。

## 4.10 会话持久化

> 📖 会话存储用的是 **JSONL 树**（支持分支、按需加载、压缩不丢原始记录），完整设计见 [Ch05 · 记忆体系 §5.3](./ch05-记忆体系.md#53-会话记忆jsonl-树)。这里只强调一点：

**精妙的地方**：用 `id / parentId` 形成**树状结构**——不仅支持线性历史，还支持**分支**（想象 ChatGPT 的"重新生成"功能）。`SessionManager` 维护缓存，避免每次都全量解析 JSONL。压缩、分支、checkpoint 都在这里实现。

## 4.11 提供商特殊处理

不同 LLM 厂商的脾气不一样，Pi / OpenClaw 做了适配层：

| 提供商 | 特殊处理 |
|--------|---------|
| **Anthropic** | 拒绝字符串里的"magic cleanup"、连续同角色消息合并 |
| **Google/Gemini** | 工具 schema 清洗（Gemini 不接受 `additionalProperties` 等字段） |
| **OpenAI Codex** | 专用 `apply_patch` 工具替代普通 edit |
| **所有** | 思考等级（thinking level）降级逻辑 |

这部分代码是**最容易随模型更新而变化的**，想贡献代码的话这里是最需要 PR 的地方之一。

## 4.12 本章小结

- OpenClaw 选择**内嵌 Pi SDK**（而非 CLI/RPC），换来同进程调用的灵活性
- `runEmbeddedPiAgent` 是外层封装，六阶段工具装配 + 事件订阅是两个核心点
- 压缩 / 认证轮换 / 错误分类 / 故障转移 全是 OpenClaw 在 Pi 之上加的生产级能力
- 会话用 JSONL 树持久化，支持分支、缓存、压缩（详见 Ch05）
- Provider 特殊处理是脏活累活，但关乎稳定性

👉 Pi Agent 的"记忆"是一个跨模块的大主题，下一章 **[Ch05 · 记忆体系](./ch05-记忆体系.md)** 会把瞬时 / 会话 / 人设 / 长期 四层记忆一次性讲清楚。

---

⬅️ [Ch03 · Gateway 源码精读](./ch03-gateway源码精读.md) | ➡️ [Ch05 · 记忆体系](./ch05-记忆体系.md)
