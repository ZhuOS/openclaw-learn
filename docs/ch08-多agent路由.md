# Ch08 · 多 Agent 路由源码精读

> "同一个 WhatsApp 号，怎么让老板走 A agent，家人走 B agent？" 答案藏在一个**确定性决策树**里——这是 OpenClaw 工程性最强的地方之一。

## 8.1 为什么不用 LLM 做路由？

很多人直觉会想：上个 LLM，读完消息自己决定该交给谁。OpenClaw 明确反对：

- **成本**：每条消息先过一次 LLM 再路由，开销 double
- **不确定性**：LLM 有可能把老板的消息路由到家人 agent，造成**数据/身份串扰**
- **不可审计**：决策日志像占卜，很难排错

OpenClaw 的决定：**路由完全走规则，确定 + 可解释 + 可测试**。

## 8.2 三层隔离模型

```
┌─────────────────────────────────────────────┐
│ ① 渠道层                                     │
│   (channel, accountId, peer, guild/team)    │
│   ↓ 决定"这条消息从哪进来"                   │
├─────────────────────────────────────────────┤
│ ② 绑定层（bindings）                         │
│   bindings[] 规则按优先级匹配                │
│   ↓ 决定"这条消息交给谁"                     │
├─────────────────────────────────────────────┤
│ ③ Agent 层                                  │
│   每个 agentId 独立 workspace/credential/   │
│   session，保证互不串扰                      │
└─────────────────────────────────────────────┘
```

### agentId = 大脑

每个 Agent 的"私有家当"：

| 路径 | 含义 |
|------|------|
| `~/.openclaw/workspace-<agentId>` | 工作区（默认 cwd） |
| `~/.openclaw/agents/<agentId>/agent/` | 状态目录 |
| `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` | 凭证 |
| `~/.openclaw/agents/<agentId>/sessions/` | 会话 JSONL |
| 工作区内的 `AGENTS.md` / `SOUL.md` / `USER.md` | 人设提示词 |

**⚠️ 硬性约束**：两个 Agent 不能共用同一个 `agentDir`，否则凭证 / 会话会互相覆盖。

## 8.3 路由决策树（核心）

当一条入站消息到达 Gateway，路由函数按**从最具体到最通用**的顺序匹配：

```
入站事件 (channel, accountId, peer, guildId?, teamId?, sender)
  │
  ▼
① peer 匹配              ← 精确私信 / 群组 / 渠道 id
  └─ 命中 → 返回 agentId
  └─ 未中 ↓
② parentPeer 匹配         ← 线程继承（Slack/Discord 回复线程）
  └─ 未中 ↓
③ guildId + roles         ← Discord 按角色
  └─ 未中 ↓
④ guildId                 ← Discord 整个服务器
  └─ 未中 ↓
⑤ teamId                  ← Slack 整个工作区
  └─ 未中 ↓
⑥ accountId 匹配          ← 按渠道账号实例
  └─ 未中 ↓
⑦ accountId = "*"        ← 渠道级通配
  └─ 未中 ↓
⑧ 默认 Agent              ← agents.list[].default，否则取第一项
```

**首个命中者获胜。同层级多条规则按配置顺序决定**。

## 8.4 代码结构推测

路由器大概在 `packages/gateway/src/router/`：

```
router/
├── index.ts               # 对外 route(event) → agentId
├── matcher.ts             # 各层匹配函数
├── compile.ts             # 配置里的 bindings 编译成高效的匹配结构
└── tests/                 # 单元测试（这块 test 应该很多）
```

伪代码：

```ts
export function route(event: InboundEvent, bindings: Binding[]): string {
  // ① peer
  for (const b of bindings) {
    if (matchPeer(b.match.peer, event.peer) &&
        matchChannel(b.match.channel, event.channel) &&
        matchAccount(b.match.accountId, event.accountId)) {
      return b.agentId;
    }
  }
  // ② parentPeer
  for (const b of bindings) {
    if (event.parentPeer && matchPeer(b.match.peer, event.parentPeer)) {
      return b.agentId;
    }
  }
  // ③ guild + roles（仅 Discord）
  // ...
  // ④-⑦ 同理
  // ⑧ fallback
  return findDefaultAgent(bindings);
}
```

**⚠️ 关键语义**：

- 同一 binding 内多个字段是 **AND**（都必须满足）
- 同一层级多个 binding 按配置顺序，**先者胜出**
- 省略 `accountId` → 只匹配默认账号
- `accountId: "*"` → 跨所有账号的渠道级回退

## 8.5 典型场景实战

### 场景 A：一个 WhatsApp 号 → 按发送者拆分

```json
{
  "agents": {
    "list": [
      { "id": "main", "default": true },
      { "id": "alex" },
      { "id": "mia" }
    ],
    "bindings": [
      { "agentId": "alex", "match": { "channel": "whatsapp",
          "peer": { "kind": "direct", "id": "+15551230001" } } },
      { "agentId": "mia",  "match": { "channel": "whatsapp",
          "peer": { "kind": "direct", "id": "+15551230002" } } }
    ]
  }
}
```

**路由结果**：
- `+15551230001` 发来 → `alex`
- `+15551230002` 发来 → `mia`
- `+15551230003` 发来 → `main`（默认 fallback）

**⚠️ 坑**：DM 的配对 / allowlist 是**按 WhatsApp 账号全局生效**，不是按 Agent——换句话说，`+15551230003` 如果没被配对，是**整号被拒**，不会因为有 fallback agent 就放行。

### 场景 B：按渠道拆分

```json
{
  "bindings": [
    { "agentId": "chat", "match": { "channel": "whatsapp" } },
    { "agentId": "opus", "match": { "channel": "telegram" } }
  ]
}
```

WhatsApp 来 → `chat`（快速日常）
Telegram 来 → `opus`（深度工作）

### 场景 C：peer 覆盖优先

```json
{
  "bindings": [
    { "agentId": "opus", "match": { "channel": "whatsapp",
        "peer": { "kind": "direct", "id": "+15551234567" } } },
    { "agentId": "chat", "match": { "channel": "whatsapp" } }
  ]
}
```

**注意顺序**：peer 精确匹配的 binding **必须放前面**，否则会被"channel 通配"binding 先匹走。

### 场景 D：群组 + mention 门控

```json
{
  "id": "family",
  "groupChat": {
    "mentionPatterns": ["@family", "@familybot"]
  },
  "sandbox": { "mode": "all", "scope": "agent" },
  "tools": {
    "allow": ["exec", "read", "sessions_list", "sessions_history"],
    "deny":  ["write", "edit", "apply_patch", "browser"]
  }
}
```

家庭群里，不 @ 不理；@ 了才走路由 → `family` agent；这个 agent 用沙箱 + 只读工具，防止被家人不小心指挥它改东西。

## 8.6 mainKey：直接聊天的会话收敛

不是每条消息都建新会话。私信会**收敛到一个"主会话"**：

```
session key = "agent:<agentId>:<mainKey>"
```

比如 WhatsApp 私信（`+15551230001` → `alex` agent）：

```
session key = "agent:alex:whatsapp:personal:+15551230001"
```

同一个对话框里的所有消息都进这个 session，**不会每条建新会话**。这是让 Agent 有"连续记忆"的关键。

**群组**则不同，通常一个 session 对应一个群组（而不是群里每个人）。

## 8.7 跨 Agent 资源共享（罕见但存在）

默认 Agent 之间数据完全隔离，但可以显式开口：

### QMD 记忆搜索（跨 Agent 只读）

```json
{
  "agents": {
    "list": [{
      "id": "main",
      "memorySearch": {
        "qmd": {
          "extraCollections": [
            { "path": "~/agents/family/sessions", "name": "family-sessions" }
          ]
        }
      }
    }]
  }
}
```

`main` 可以搜到 `family` 的会话历史（只读）。

> 📖 QMD 是 OpenClaw 的**语义检索层**，完整机制（Qdrant 存储、索引流程、`memory_search` 工具、踩坑点）在 [Ch05 · §5.5 长期记忆](./ch05-记忆体系.md#55-长期记忆qmd-向量检索) 有详细讲解。

### Agent-to-Agent 通信

```json
{
  "tools": {
    "agentToAgent": { "enabled": false, "allow": ["home", "work"] }
  }
}
```

**默认关闭**。打开后，`home` 和 `work` 两个 Agent 之间可以互相发消息。

## 8.8 管理命令

```bash
openclaw agents add <name>                    # 添加新 Agent
openclaw agents list --bindings               # 查看绑定
openclaw channels login --channel whatsapp --account biz
openclaw channels status --probe              # 验证
openclaw gateway restart                      # 应用改动
```

`agents.json` / `openclaw.json` 改完**一定要 restart**——路由表在 Gateway 启动时编译进内存，不热更。

## 8.9 设计哲学小结

这套路由体系体现了**典型的工业级 Agent 设计原则**：

1. **确定性优于智能**：关键路径不让 LLM 判断
2. **显式优于隐式**：bindings 必须明写，没写就走默认
3. **分层优于杂糅**：渠道 / 绑定 / Agent 三层各司其职
4. **AND 语义优于 OR**：同一规则内所有条件必须全中，避免"以为匹配其实漏了"
5. **最具体优先**：从 peer 到通配，符合人的直觉

## 8.10 本章小结

- 三层隔离：**渠道 → 绑定 → Agent**
- 路由决策 8 级匹配树，**peer → accountId → 默认**
- 同 binding 多字段 AND；同层级多 binding 按配置顺序先胜
- `session key = agent:<agentId>:<mainKey>` 实现私信会话收敛
- 默认完全隔离，跨 Agent 共享需要显式开口
- 配置改完**必须 restart gateway**

---

⬅️ [Ch07 · Tools/Skills/Plugins](./ch07-tools-skills-plugins.md) | ➡️ [Ch09 · 动手扩展](./ch09-动手扩展.md)
