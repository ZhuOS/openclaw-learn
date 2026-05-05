---
layout: home

hero:
  name: "OpenClaw"
  text: "源码学习教程"
  tagline: 从零到精通：读懂这套 AI Agent 网关的架构设计与源码实现
  image:
    src: /hero-logo.svg
    alt: OpenClaw
  actions:
    - theme: brand
      text: 开始阅读 →
      link: /ch01-定位与架构全景
    - theme: alt
      text: GitHub
      link: https://github.com/ZhuOS/openclaw-learn

features:
  - icon: 🏗️
    title: Ch01 · 项目定位与架构全景
    details: OpenClaw 是什么、核心设计理念、六层整体架构、源码阅读路线地图
    link: /ch01-定位与架构全景
  - icon: 🚀
    title: Ch02 · 环境搭建与跑通
    details: 从 clone 到 pnpm gateway:watch 能跑起来，接上第一个 Telegram bot
    link: /ch02-环境搭建与跑通
  - icon: 🔬
    title: Ch03 · Gateway 源码精读
    details: 单进程单端口复用 HTTP+WS、OpenAI 兼容层、跨平台 daemon、自服务配置
    link: /ch03-gateway源码精读
  - icon: 🤖
    title: Ch04 · Pi Agent 内嵌运行时
    details: 六阶段工具装配、事件订阅、压缩机制、多 profile 故障转移
    link: /ch04-pi-agent源码精读
  - icon: 🧠
    title: Ch05 · 记忆体系
    details: 瞬时 / 会话 / 人设 / 长期 四层记忆的分工，JSONL 树、SOUL.md、QMD 向量检索
    link: /ch05-记忆体系
  - icon: 📡
    title: Ch06 · Channels 渠道适配层
    details: 以 Telegram 为例剖析协议归一化、能力翻译、Pairing/Allowlist 安全层
    link: /ch06-channels源码精读
  - icon: 🧩
    title: Ch07 · Tools / Skills / Plugins
    details: 能力 / 知识 / 打包 三层解耦，权限控制四档叠加，反幻觉安全机制
    link: /ch07-tools-skills-plugins
  - icon: 🔀
    title: Ch08 · 多 Agent 确定性路由
    details: 8 级决策树、mainKey 会话收敛、跨 Agent 资源共享、典型场景实战
    link: /ch08-多agent路由
  - icon: 🛠️
    title: Ch09 · 动手：写自己的扩展
    details: 三种方案递进：零代码 Skill → 专用 Tool → 完整 Plugin 并发布到 ClawHub
    link: /ch09-动手扩展
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: -webkit-linear-gradient(120deg, #ff8a3d 30%, #ffb980);
  --vp-home-hero-image-background-image: linear-gradient(-45deg, #ff8a3d50 50%, #ffb98050 50%);
  --vp-home-hero-image-filter: blur(44px);
}
</style>
