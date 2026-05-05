# Ch06 · Channels 渠道适配层源码精读

> 20+ 聊天平台协议完全不同，OpenClaw 怎么把它们统一抽象？以 Telegram 为例一把剥开。

## 6.1 渠道适配层的核心职责

面对 Telegram / WhatsApp / Discord / iMessage / Slack 这些彼此不兼容的协议，适配层要做三件事：

```
协议转换     ：把各自平台的消息格式 → OpenClaw 统一事件模型
能力抽象     ：分层声明"我能做什么"（文本/媒体/reaction/编辑...）
安全守护     ：配对（pairing）、允许列表（allowlist）、提及门控
```

画成图：

```
Telegram Update ─┐
WhatsApp msg   ──┤
Discord event  ──┤──►  Channel Adapter  ──►  Gateway Router
iMessage AE    ──┤      (各自实现)                │
...            ──┘                                ▼
                                         Pi Agent Runtime
                                              │
反向路径 ◄──  Adapter  ◄── Reply Block （包含文本/媒体/动作）
```

## 6.2 统一的 Channel 接口（推断）

所有渠道适配器大概率都 implements 一个统一接口，类似：

```ts
// packages/channels/src/types.ts（推测）
export interface ChannelAdapter {
  readonly name: string;                     // "telegram"
  readonly accountId: string;                // "personal" / "biz"
  readonly capabilities: ChannelCapabilities; // 见下

  login(opts: LoginOptions): Promise<void>;
  start(): Promise<void>;                    // 开始监听消息
  stop(): Promise<void>;

  send(peer: Peer, block: ReplyBlock): Promise<SendResult>;
  on(event: "message" | "edit" | "reaction" | ..., handler): void;

  probe(): Promise<ProbeResult>;             // doctor 用：检查连通性
}

export interface ChannelCapabilities {
  text: boolean;                             // 必须 true
  image: boolean;
  audio: boolean;
  video: boolean;
  document: boolean;
  reactions: boolean;
  edit: boolean;
  delete: boolean;
  markdown: boolean;
  mentions: boolean;
  groups: boolean;
}
```

**能力渐进（capability downgrade）**：

- Pi Agent 输出 `![alt](url)` Markdown 图片
- Telegram 适配器 → 转换为原生 `sendPhoto`
- IRC 适配器 → 能力不够，降级为发一行"[image: url]"文字

这个"能力翻译"就是适配层最考验设计的地方。

## 6.3 以 Telegram 为例：最简单的适配器

Telegram 用 **grammY** SDK，代码结构大概是：

```
packages/channels/telegram/
├── index.ts                 # 导出 TelegramAdapter
├── adapter.ts               # 主适配器类
├── inbound.ts               # 入站消息归一化
├── outbound.ts              # 出站消息翻译（含 markdown → photo）
├── commands.ts              # /start /login 等 Bot 命令
└── auth.ts                  # Bot Token 管理
```

### inbound.ts：Telegram → 统一事件

```ts
// 伪代码
import { Bot } from "grammy";

export function setupInbound(bot: Bot, adapter: TelegramAdapter) {
  bot.on("message:text", async (ctx) => {
    const event: InboundMessageEvent = {
      channel: "telegram",
      accountId: adapter.accountId,
      peer: {
        kind: ctx.chat.type === "private" ? "direct" : "group",
        id: String(ctx.chat.id),
      },
      sender: {
        id: String(ctx.from?.id),
        displayName: ctx.from?.first_name,
      },
      content: {
        text: ctx.message.text,
        images: [],              // message:photo 时填
      },
      ts: ctx.message.date * 1000,
      nativeId: String(ctx.message.message_id),
    };

    await adapter.onInbound(event);   // 交给 Gateway
  });

  bot.on("message:photo", async (ctx) => {
    // 下载图片 → event.content.images.push(buffer)
    // ...
  });
}
```

**关键点**：
- 适配器**不调 Gateway 的路由逻辑**，只管归一化，然后丢事件给上层
- `peer.kind` 和 `peer.id` 是路由匹配的关键字段（见 Ch08）

### outbound.ts：回流消息的协议翻译

Agent 回复一个 `ReplyBlock`，可能包含：

```ts
{
  text: "这是一张图 ![claw](file:///tmp/out.png)",
  media: [{ type: "image", path: "/tmp/out.png" }],
  replyToId: "msg-123",
}
```

Telegram 适配器的任务：

```ts
async send(peer: Peer, block: ReplyBlock): Promise<SendResult> {
  // 1. 解析文本中的 Markdown 图片语法
  const { cleanText, inlineImages } = parseMarkdownImages(block.text);

  // 2. 合并显式 media + inline images
  const allMedia = [...(block.media ?? []), ...inlineImages];

  // 3. 协议翻译
  if (allMedia.length === 0) {
    return bot.api.sendMessage(peer.id, cleanText, {
      reply_to_message_id: block.replyToId,
      parse_mode: "MarkdownV2",
    });
  }
  if (allMedia.length === 1 && allMedia[0].type === "image") {
    return bot.api.sendPhoto(peer.id, fs.createReadStream(allMedia[0].path), {
      caption: cleanText,
      reply_to_message_id: block.replyToId,
    });
  }
  // 多媒体 → sendMediaGroup
  return bot.api.sendMediaGroup(peer.id, buildMediaGroup(allMedia, cleanText));
}
```

**这段翻译逻辑是 OpenClaw 精妙的地方之一**：Agent 不用知道渠道能力，只管用 Markdown 输出；适配器来决定"这条 Markdown 在这个渠道上该以什么形式落地"。

## 6.4 WhatsApp：复杂得多的适配器

WhatsApp 用 [Baileys](https://github.com/WhiskeySockets/Baileys)（非官方多设备协议库），和 Telegram 有几个本质差别：

| 维度 | Telegram | WhatsApp |
|------|----------|----------|
| 协议 | Bot API（HTTP） | Multi-Device WebSocket |
| 认证 | 单个 Bot Token | **二维码配对**，定期会话密钥 |
| 状态 | 无状态 | 需要磁盘持久化 session（几十 MB） |
| 加密 | 服务端加密 | **端到端加密**，客户端要管密钥 |
| 启动 | 立即可用 | 需要 WS 握手 + 密钥同步（数秒） |

所以 WhatsApp 适配器代码量是 Telegram 的 3-5 倍。它额外做：

- 密钥持久化：存在 `~/.openclaw/channels/whatsapp/<accountId>/`
- 按需加载：只有配置启用了才 `import`，减少启动开销
- 二维码展示：Control UI 扫码登录

**⚠️ 仅有的缺陷**：Baileys 不是官方协议，Meta 偶尔封号，**不要在商业关键场景依赖**。

## 6.5 安全层：Pairing + Allowlist

所有渠道共用的安全机制（典型位置：`packages/channels/src/security/`）：

### Pairing（私信配对）

默认情况下，**陌生人私信不会走到 Agent**。用户必须先：

```bash
openclaw pairing approve <inbound-id>
```

或者在 Control UI 点"允许"。这个机制防止 bot 账号被陌生人骚扰消耗 token。

**实现伪代码**：

```ts
async onInbound(event: InboundMessageEvent) {
  if (event.peer.kind === "direct") {
    const paired = await isPairedSender(event.channel, event.sender.id);
    if (!paired) {
      await queuePendingPairing(event);
      await notifyOwnerForApproval(event);
      return;
    }
  }
  // 已配对，继续路由
  await gateway.route(event);
}
```

### Allowlist（允许列表）

配置里可以强制白名单：

```json
{
  "channels": {
    "whatsapp": {
      "allowFrom": ["+15555550123", "+15555550456"]
    }
  }
}
```

不在列表里的号码，消息直接丢弃（或回复拒绝语）。

### Group Mention Gating

群里默认**不回复**，除非被 @ 到：

```json
{
  "messages": {
    "groupChat": {
      "mentionPatterns": ["@openclaw", "@claw"]
    }
  }
}
```

这个由 Gateway 层在路由前做判断，避免 Agent 被群聊刷屏。

## 6.6 BlueBubbles：iMessage 的特殊案例

iMessage 官方没有开放 API，OpenClaw 通过 [BlueBubbles](https://bluebubbles.app/)（一个运行在 Mac 上的 REST API 中转器）来接入。

这带来一个有趣的架构：

```
iPhone iMessage
  ↕️
Mac 上的 BlueBubbles Server (REST API)
  ↕️
OpenClaw Gateway (另一台机器也行)
```

适配器实现就是一个 REST client。支持编辑、撤回、tapback（reaction）、群组、特效。

**⚠️ 已知限制**：macOS 26 Tahoe 上 iMessage 编辑功能被苹果改了，BlueBubbles 暂时不支持。

## 6.7 按需加载：性能优化

`pnpm install` 时 Baileys / Puppeteer 这些大依赖会一起装。但 **运行时** OpenClaw 做了 lazy loading：

```ts
// 伪代码：packages/channels/src/registry.ts
const CHANNEL_LOADERS: Record<string, () => Promise<ChannelAdapter>> = {
  telegram: () => import("./telegram").then(m => m.createTelegramAdapter()),
  whatsapp: () => import("./whatsapp").then(m => m.createWhatsAppAdapter()),
  discord:  () => import("./discord").then(m => m.createDiscordAdapter()),
  // ...
};

export async function loadEnabledChannels(config: Config): Promise<ChannelAdapter[]> {
  const enabled = Object.keys(config.channels ?? {});
  return Promise.all(enabled.map(name => CHANNEL_LOADERS[name]()));
}
```

**效果**：只用 Telegram 的用户，不会为 WhatsApp 的 Baileys 付启动时间和内存。

## 6.8 源码阅读建议路径

如果你想自己加一个渠道（比如 飞书 / 钉钉 / 企业微信），抄这条路径：

```
1. 读 packages/channels/telegram/ 全部（最简单）
2. 读 packages/channels/types.ts（接口定义）
3. 读 packages/channels/src/security/pairing.ts
4. 读 packages/channels/src/registry.ts（看注册机制）
5. 抄着 telegram/ 目录结构写自己的适配器
6. 在 registry 里注册
```

详细实战在 Ch09。

## 6.9 本章小结

- 渠道适配层三职责：**协议转换 / 能力抽象 / 安全守护**
- 统一接口 `ChannelAdapter`：inbound 归一化 + outbound 能力翻译
- Telegram（grammY，最简单）→ WhatsApp（Baileys，最复杂）→ BlueBubbles（REST 代理）
- 安全层：Pairing / Allowlist / Group Mention Gating 在 Gateway 路由前拦截
- 运行时 lazy import，冷启动性能友好

---

⬅️ [Ch05 · 记忆体系](./ch05-记忆体系.md) | ➡️ [Ch07 · Tools/Skills/Plugins 扩展机制](./ch07-tools-skills-plugins.md)
