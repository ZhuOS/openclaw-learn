# Ch03 · Gateway 源码精读

> 整个系统的心脏。这一章你会看清：一个生产级 AI 控制面是怎么用 **单进程 + 单端口** 把 HTTP / WS / 渠道事件 / 路由 / 生命周期 全部串起来的。

## 3.1 从 `openclaw gateway` 出发

CLI 入口是 `packages/cli/src/bin.ts`，它是一个薄封装，真正的启动逻辑在 `packages/gateway/src/server.ts`（或类似名称的文件）。

追踪路径：

```
packages/cli/src/bin.ts              ← bin 入口
  └── commands/gateway.ts            ← 子命令 start/restart/stop/install
        └── import { startGateway }  from "@openclaw/gateway"
              └── packages/gateway/src/index.ts
                    └── startGateway() → 创建 HTTP server + 挂载 WS + 加载渠道
```

**🔍 建议你现在**：在仓库里 `grep -r "export.*startGateway" packages/gateway/src` 找到真正的启动函数。

## 3.2 单端口复用：一个 18789 挂了多少东西？

Gateway 设计的第一个精彩之处：**同一个端口同时跑 HTTP + WebSocket + 静态资源**。

```
http://127.0.0.1:18789/
├── /                                 → Control UI（静态 HTML/JS/CSS）
├── /v1/models                        → OpenAI 兼容：列 Agent
├── /v1/chat/completions              → OpenAI 兼容：对话
├── /v1/responses                     → OpenAI 兼容：响应 API
├── /v1/embeddings                    → 嵌入
├── /tools/invoke                     → 工具调用端点
├── /voiceclaw/realtime               → WS：实时语音 Brain
└── /                                 → WS（Upgrade）：控制平面
```

**实现机制**（Node.js 惯用模式）：

```ts
// 伪代码：packages/gateway/src/server.ts
import http from "node:http";
import { WebSocketServer } from "ws";

const httpServer = http.createServer(async (req, res) => {
  // HTTP 路由
  if (req.url?.startsWith("/v1/")) return openaiCompatHandler(req, res);
  if (req.url?.startsWith("/tools/")) return toolInvokeHandler(req, res);
  return staticUiHandler(req, res);   // 兜底：serve Control UI
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  // Upgrade 请求：根据路径分发到不同 WS handler
  if (req.url === "/voiceclaw/realtime") {
    voiceWss.handleUpgrade(req, socket, head, ws => voiceHandler(ws));
  } else {
    wss.handleUpgrade(req, socket, head, ws => controlHandler(ws));
  }
});

httpServer.listen(port);
```

**⚠️ 重点**：`noServer: true` + 手动 `handleUpgrade` 是 Node 原生 HTTP + WS 共存的**唯一正确姿势**，你自己写微服务时这招直接抄。

## 3.3 WS 控制协议：握手与事件

OpenClaw 的 Control UI / CLI 都通过 WS 连接 Gateway。协议规定：

### 握手（必须 connect 在先）

```
Client → { "type": "connect", "version": "...", "clientId": "..." }
Gateway → { "type": "hello-ok", "presence": {...}, "health": {...},
            "stateVersion": 42, "uptimeMs": 12345,
            "limits": {...}, "policy": {...}, "features": [...] }
```

**关键点**：

- 首帧**必须**是 `connect`，否则直接拒绝 + 关闭
- `hello-ok` 里的 `stateVersion` 用于后续增量同步
- 非 loopback 绑定时还需要 `connect.challenge` 做身份验证

### 请求 / 响应

```
Client → { "type": "req", "id": "xxx", "method": "agent.chat", "params": {...} }
Gateway → { "type": "res", "id": "xxx", "ok": true, "payload": {...} }
        或 { "type": "res", "id": "xxx", "ok": false, "error": {...} }
```

### 服务端推送事件

| 事件类型 | 说明 |
|---------|------|
| `agent` | Agent 状态变化 |
| `chat` | 对话流式内容 |
| `session.message` / `session.tool` | 会话内的消息/工具事件 |
| `sessions.changed` | 会话列表变更（广播） |
| `presence` | 在线状态 |
| `health` / `heartbeat` | 健康/心跳 |
| `tick` | 定时器 |
| `shutdown` | 优雅关闭 |

**⚠️ 重要约束**：事件**不重放**。如果客户端断线重连发现 `stateVersion` 跳跃，必须主动查询 `health` / `system-presence` 而不是指望服务端补事件。这是典型的**服务端无状态 + 客户端幂等刷新**设计。

## 3.4 OpenAI 兼容层：让 Gateway 变成可替换的 LLM

Gateway 暴露的 `/v1/*` 完全兼容 OpenAI API。这意味着：

**任何支持 OpenAI 的客户端都可以直接把 BASE_URL 指向 `http://127.0.0.1:18789/v1`，把 Gateway 当作一个"智能 LLM"来用。**

但这里有个精彩设计——**模型 ID 绑定到 Agent，不是暴露底层 LLM**：

```bash
curl http://127.0.0.1:18789/v1/models
# 返回:
# [
#   { "id": "openclaw",         "owned_by": "openclaw" },
#   { "id": "openclaw/default", "owned_by": "openclaw" },
#   { "id": "openclaw/main",    "owned_by": "openclaw" },
#   { "id": "openclaw/family",  "owned_by": "openclaw" }
# ]
```

- `openclaw/default` → 默认 Agent（稳定别名）
- `openclaw/<agentId>` → 特定 Agent

**为什么这么设计**：Agent = workspace + credentials + skills + tools，不仅仅是 model。你调 `openclaw/family` 相当于激活了 family Agent 的整套环境。

**覆盖底层 model**：特殊场景下，请求头加 `x-openclaw-model: anthropic/claude-opus` 可以临时换模型。

## 3.5 生命周期管理：跨平台服务

Gateway 要能作为后台服务长期运行，OpenClaw 封装了一层跨平台抽象：

| 平台 | 实现 | 文件位置（推测） |
|------|------|-----------------|
| macOS | LaunchAgent (`ai.openclaw.gateway`) | `packages/cli/src/daemon/macos.ts` |
| Linux (user) | systemd user unit | `.../daemon/linux.ts` |
| Linux (system) | systemd system unit | 同上 |
| Windows | 计划任务 + Startup 回退 | `.../daemon/windows.ts` |

统一命令：

```bash
openclaw gateway install     # 注册为服务
openclaw gateway restart
openclaw gateway stop
openclaw doctor              # 检测漂移、自动修复
```

**源码学习建议**：看 `daemon/` 下三个平台实现的差异，是学"如何写跨平台 Node CLI"的好案例——尤其是 macOS plist 生成、Linux systemd unit 模板、Windows schtasks 调用。

## 3.6 配置解析优先级（代码怎么实现的）

配置加载通常在 `packages/shared/src/config/` 或 `packages/gateway/src/config/`。典型实现：

```ts
// 伪代码
function resolvePort(opts: CliOpts): number {
  return opts.port                                // ① --port
      ?? num(process.env.OPENCLAW_GATEWAY_PORT)   // ② 环境变量
      ?? readJson("~/.openclaw/openclaw.json")?.gateway?.port  // ③ 配置文件
      ?? 18789;                                   // ④ 默认
}
```

**每一层都带类型校验 + 默认回退**。你改源码时这套模板直接复用。

## 3.7 `gateway` 工具：配置的自我服务

一个很精妙的设计：Gateway 内部**把自己的配置当作工具暴露给 Agent**，让 Agent 可以在聊天中修改配置：

```
session_status.gateway.config.schema.lookup
session_status.gateway.config.get
session_status.gateway.config.patch
session_status.gateway.config.apply
session_status.gateway.update.run
```

但这个工具**有硬保护**：
- ❌ 不允许修改 `tools.exec.ask` / `tools.exec.security`（防止 Agent 把自己的安全护栏拆了）
- ✅ 优先用 `config.patch`（局部改），`config.apply` 仅用于整体替换

**🔍 深挖思考题**：如果你要做类似"可以自我修改"的 Agent 系统，怎么防止 Agent 把自己的权限扩大？OpenClaw 给出的答案：**关键安全字段在工具层级就拒绝写入**，不依赖 Agent 的 prompt 自律。

## 3.8 实战追踪：一条 HTTP 请求的完整路径

假设你 `curl POST /v1/chat/completions` 发了 "hello"：

```
1. httpServer 收到请求
      ↓
2. 路由到 openaiCompatHandler（packages/gateway/src/http/openai.ts）
      ↓
3. 解析 body，提取 model="openclaw/main"、messages
      ↓
4. 查找 agentId="main" 的 Pi 实例（若未启动则 lazy init）
      ↓
5. 调用 runEmbeddedPiAgent 或类似入口（见 Ch04）
      ↓
6. Pi 内部做 tool calling 循环，流式回调
      ↓
7. 把回调的每个 chunk 转成 OpenAI SSE 格式（data: {...}\n\n）写回
      ↓
8. turn_end 后发 data: [DONE]
```

**推荐你现在做的事**：
- `pnpm gateway:watch` 跑起来
- 在 `http/openai.ts` 或等价文件里加几个 `console.log`
- `curl` 一次，观察日志流

## 3.9 本章小结

- Gateway = **单进程 + 单端口 + 多协议复用**，Node 原生 `http + ws` 的标准组合
- WS 控制协议严格要求 `connect` 首帧、事件不重放、`stateVersion` 同步
- OpenAI 兼容层把 Agent 伪装成 model，让任何 OpenAI 客户端能接入
- 跨平台 daemon 抽象：macOS/Linux/Windows 三套实现，`doctor` 做漂移检测
- Gateway 自己的配置也被包成工具暴露给 Agent，但关键安全字段硬性不可改

---

⬅️ [Ch02 · 环境搭建](./ch02-环境搭建与跑通.md) | ➡️ [Ch04 · Pi Agent 内嵌运行时](./ch04-pi-agent源码精读.md)
