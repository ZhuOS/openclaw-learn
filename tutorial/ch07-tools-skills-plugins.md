# Ch07 · Tools / Skills / Plugins 扩展机制

> 三层解耦是 OpenClaw 最值得学的设计之一。看懂了这一章，你会真切感受到"能改 prompt 就别改代码"的威力。

## 7.1 三层再复述一遍（很重要）

| 层 | 本质 | 代码形态 | 何时起效 |
|----|------|---------|---------|
| **Tools** | 函数签名 + 实现 | TypeScript（必须） | LLM 在 tool-calling 循环中调用 |
| **Skills** | 使用指南 | `SKILL.md`（纯 Markdown） | 拼入 system prompt，不执行代码 |
| **Plugins** | 打包分发单元 | npm 包（含 Tools + Skills + 元数据） | 运行时动态 import |

**一句话记忆**：
- Tools 给 Agent "**手**"（能做什么）
- Skills 给 Agent "**脑**"（知道何时做、怎么做）
- Plugins 给 OpenClaw "**接口**"（怎么让别人装上你的东西）

## 7.2 Tool 的定义形态

一个 Tool 最终要变成 LLM 能理解的 JSON Schema。OpenClaw 的 Tool 定义大概长这样（典型位置：`packages/tools/src/builtins/*.ts`）：

```ts
// 伪代码
import { defineTool } from "@openclaw/tools";
import { z } from "zod";

export const webFetchTool = defineTool({
  name: "web_fetch",
  description: "抓取 URL 并返回 Markdown 格式的内容。",
  schema: z.object({
    url: z.string().url(),
    extractInfo: z.string().optional(),
  }),
  async execute({ url, extractInfo }, ctx) {
    const html = await fetch(url).then(r => r.text());
    const md = htmlToMarkdown(html);
    return { ok: true, content: md };
  },
});
```

**关键要素**：

- `name`：LLM 看到的唯一标识，全局不能重
- `description`：LLM 决定要不要调这个工具的**主要依据**，写得烂等于白加
- `schema`：用 Zod 定义入参（背后转 JSON Schema 交给 LLM）
- `execute`：实际执行函数，`ctx` 里有 `abortSignal` / `workspaceDir` / `sessionId` 等

### Tool 分组（Group）

内置工具按功能分组，配置里可用 `group:*` 批量引用：

| Group | 含内容 |
|-------|-------|
| `group:runtime` | exec / process / code_execution（bash 是 exec 别名） |
| `group:fs` | read / write / edit / apply_patch |
| `group:sessions` | sessions_* 全系列 + subagents + session_status |
| `group:memory` | memory_search / memory_get |
| `group:web` | web_search / x_search / web_fetch |
| `group:ui` | browser / canvas |
| `group:automation` | cron / gateway |
| `group:messaging` | message |
| `group:media` | image / image_generate / music_generate / video_generate / tts |
| `group:openclaw` | 所有内置（不含插件） |

**代码位置**：大概率在 `packages/tools/src/groups.ts`，一个常量表 + 运行时展开。

## 7.3 Skills 的定义形态

Skill 是一个目录，核心文件是 `SKILL.md`：

```
my-awesome-skill/
├── SKILL.md              # 主描述（必须）
├── scripts/              # 可选：辅助脚本
│   └── query.py
├── references/           # 可选：参考资料
│   └── api-spec.md
└── assets/               # 可选：图片、模板
```

### SKILL.md 的 frontmatter

```markdown
---
name: finance-data-retrieval
description: |
  金融数据检索。覆盖股票行情、基金净值、宏观指标。
  触发词：查股价、看行情、财报、基金净值、CPI、GDP、K线、涨停股
---

# Finance Data Retrieval

## 何时使用
- 用户问到任何 A股/港股/美股的行情、财报、技术指标
- 用户询问宏观经济数据（CPI、GDP、PPI 等）

## 使用方法
1. 先调 `web_search` 确认股票代码
2. 根据代码调 `query.py`（在本 skill 的 scripts/ 下）
3. 用 Markdown 表格展示

## 避坑
- ts_code 必须带交易所后缀（000001.SZ）
- 分钟线 freq 只接受 1min/5min/15min/30min/60min
```

**关键机制**：

- `description` 里的**触发词**决定 Skill 是否被自动调起（语义匹配）
- 正文内容**完整注入 system prompt**，所以不要太长（几百到一千多 token 比较合适）
- 正文可以包含具体示例、避坑经验、命令调用模板——Agent 会按你写的执行

### Skill 装载优先级

```
workspace skills（~/.openclaw/workspace-<agentId>/skills/）
  > 用户 skills（~/.openclaw/skills/）
    > 内置 skills（打包在 OpenClaw 内）
```

**新 Skill 会在下一个 session 才加载**——不是实时的。

## 7.4 Plugin 的定义形态

Plugin 是 npm 包 + 特定元数据：

```json
{
  "name": "@myorg/openclaw-finance-plugin",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "runtimeExtensions": ["./dist/index.js"],
    "compat": {
      "pluginApi": ">=2026.3.24-beta.2",
      "minGatewayVersion": "2026.3.24-beta.2"
    }
  }
}
```

入口文件 `src/index.ts`：

```ts
import { definePlugin } from "@openclaw/plugin-sdk";
import { stockQuoteTool, stockHistoryTool } from "./tools";
import financeSkill from "./skills/finance-data-retrieval";

export default definePlugin({
  id: "finance",
  tools: [stockQuoteTool, stockHistoryTool],
  skills: [financeSkill],
  providers: [],          // 可选：自定义 LLM provider
  channels: [],           // 可选：自定义渠道
});
```

### 插件装载流程

```
openclaw plugins install clawhub:finance
  ↓
从 ClawHub 拉 tarball
  ↓
检查 pluginApi 与 minGatewayVersion 兼容性
  ↓
验证签名 / 警告（非官方包）
  ↓
解压到 ~/.openclaw/plugins/@myorg/openclaw-finance-plugin/
  ↓
下次 Gateway 启动时 import(plugin.runtimeExtensions)
  ↓
注册 tools / skills / providers / channels
```

**⚠️ 关键**：tools 注册到 Gateway 时会**挨个检查 name 冲突**，重名插件不会被同时加载。

## 7.5 权限控制：多层叠加

工具能不能用，决策优先级（从后往前覆盖）：

```
① profile（基线）
   "tools.profile": "coding"   →  展开为 fs+runtime+web+sessions+memory+cron+media

② group（批量引用）
   "tools.allow": ["group:fs"]

③ allow/deny（精确）
   "tools.allow": ["web_fetch"]
   "tools.deny":  ["exec"]
    ↑ deny 永远胜出

④ byProvider（按模型覆盖）
   "tools.byProvider": { "google-antigravity": { "profile": "minimal" } }
```

**四档 profile**：

| Profile | 范围 | 典型用途 |
|---------|------|---------|
| `full` | 所有工具 | 开发 / 自用 |
| `coding` | fs + runtime + web + sessions + memory + cron + media | 编码 Agent |
| `messaging` | messaging + sessions + session_status | 聊天 Agent |
| `minimal` | 仅 `session_status` | 演示 / 极受限 |

**⚠️ 反直觉的坑**：如果 `allow` 解析完是**空集合**（比如引用了不存在的工具），Gateway 会**拒绝运行**——这是防幻觉的主动保护。

## 7.6 代码定位建议

| 想找什么 | 去哪里 |
|---------|--------|
| 内置工具实现 | `packages/tools/src/builtins/` 下各个 `.ts` |
| 工具组定义 | `packages/tools/src/groups.ts` |
| 权限过滤逻辑 | `packages/tools/src/policy.ts` 或 `acl.ts` |
| Skill 加载 | `packages/agent/src/skills/loader.ts` |
| Plugin 运行时装载 | `packages/plugins/src/loader.ts` |
| Schema 标准化（Gemini 兼容） | `packages/agent/src/providers/gemini.ts` |

## 7.7 经典协作案例：`sessions_history` 的安全过滤

`sessions_history` 是让 Agent 回看历史消息的工具，返回**不是原始 JSONL**，而是**脱敏视图**：

```ts
function sanitizeHistory(messages: Message[]): Message[] {
  return messages.map(msg => {
    let content = msg.content;
    // 剥离 thinking 块
    content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
    // 剥离伪装的 tool 调用（可能是被模型学坏了的输出）
    content = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
    // 剥离 <relevant-memories> 脚手架
    content = content.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
    // 剥离残缺 MiniMax XML
    content = stripBrokenMinimaxXml(content);
    // 全角/半角控制符清理
    content = stripControlTokens(content);
    return { ...msg, content: truncate(content, 2000) };
  });
}
```

**为什么要这么做**：如果历史记录里的 tool 调用脚手架被原样喂回去，模型可能**以为那些 tool 真的被调过**，导致幻觉。这段代码是**生产 Agent 系统必备的安全层**，值得整个抄走。

## 7.8 本章小结

- **Tools / Skills / Plugins 三层解耦**：能力 / 知识 / 打包 各自独立
- Tool 是带 Zod schema 的函数；Skills 是纯 Markdown；Plugins 是 npm 包
- 权限控制四档：**profile → group → allow/deny → byProvider**，deny 永远胜出
- 空 allow 默认拒绝运行，是重要的反幻觉安全机制
- `sessions_history` 的脱敏示例展示了"工具返回值也要被审慎处理"的工程智慧

---

⬅️ [Ch06 · Channels](./ch06-channels源码精读.md) | ➡️ [Ch08 · 多 Agent 路由](./ch08-多agent路由.md)
