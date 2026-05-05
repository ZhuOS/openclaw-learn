# OpenClaw 源码学习教程

> 从零到精通：读懂这套"AI Agent 网关"的架构设计与源码实现。

## 📖 教程定位

这不是一份"怎么用 OpenClaw"的使用文档（官方文档 https://docs.openclaw.ai 已经够详细），而是一份 **面向开发者的源码学习指南**——目标是让你：

1. **看懂**：一个生产级 AI Agent Gateway 是怎么设计出来的
2. **读懂**：能顺着入口一路追到任意子系统的核心代码
3. **改得动**：自己写一个 Tool / Skill / Plugin / Channel 适配器

## 🎯 适合人群

- Node/TypeScript 有一定基础（能看懂 `async/await`、装饰器、workspace）
- 对 Agent、工具调用（tool calling）、LLM 工程有基本认知
- 想搞清楚"消息网关 / 多渠道适配 / 多 Agent 路由"这套东西在工业级产品里到底怎么写

## 🧭 章节导航

| 章节 | 主题 | 你学到什么 |
|------|------|-----------|
| [Ch01](./ch01-定位与架构全景.md) | 项目定位与架构全景 | OpenClaw 在 AI Agent 生态里站在哪，整体分几层 |
| [Ch02](./ch02-环境搭建与跑通.md) | 环境搭建与跑通 | 从源码 clone 到 `pnpm gateway:watch` 能跑起来 |
| [Ch03](./ch03-gateway源码精读.md) | Gateway 源码精读 | 控制面入口、端口复用、WS 协议、生命周期 |
| [Ch04](./ch04-pi-agent源码精读.md) | Pi Agent 内嵌运行时 | `createAgentSession` 怎么串起事件/工具/压缩 |
| [Ch05](./ch05-记忆体系.md) | **记忆体系** | 瞬时 / 会话 / 人设 / 长期 四层记忆的分工与协作 |
| [Ch06](./ch06-channels源码精读.md) | Channels 渠道适配层 | 以 Telegram 为例，看清适配器的统一抽象 |
| [Ch07](./ch07-tools-skills-plugins.md) | 三层扩展机制 | Tools / Skills / Plugins 的协同与装载顺序 |
| [Ch08](./ch08-多agent路由.md) | 多 Agent 路由 | 确定性路由决策树怎么落到代码里 |
| [Ch09](./ch09-动手扩展.md) | 动手实战 | 写一个自己的 Tool + Skill + Plugin |

## 🗺️ 推荐学习路径

**3 小时速通**：Ch01 → Ch02 → Ch03 → Ch09
**1 周系统学习**：按章节顺序，每天 1 章，配合源码边读边改
**针对性查阅**：各章都是独立的，随用随查

## 📚 官方资源

- 官网：https://openclaw.ai
- 文档：https://docs.openclaw.ai/zh-CN
- 源码：https://github.com/openclaw/openclaw
- 作者：Peter Steinberger（@steipete）

## ✍️ 教程约定

- **源码引用**：`packages/xxx/src/yyy.ts:L123` 格式，方便你在仓库里直接跳转
- **配置示例**：用 `~/.openclaw/openclaw.json` 实际能跑的 JSON
- **⚠️ 标注**：踩坑点、容易误解的地方
- **🔍 深挖**：可选的深入思考题

---

开始学习 → [Ch01 · 项目定位与架构全景](./ch01-定位与架构全景.md)
