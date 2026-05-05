import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenClaw 源码学习教程',
  description: '从零到精通：读懂这套 AI Agent 网关的架构设计与源码实现',
  lang: 'zh-CN',
  base: '/openclaw-learn/',

  head: [
    ['link', { rel: 'icon', href: '/openclaw-learn/favicon.ico' }],
  ],

  themeConfig: {
    logo: '🦞',
    siteTitle: 'OpenClaw 教程',

    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/ch01-定位与架构全景' },
      { text: 'GitHub', link: 'https://github.com/ZhuOS/openclaw-learn' },
    ],

    sidebar: [
      {
        text: '教程章节',
        items: [
          { text: 'Ch01 · 项目定位与架构全景', link: '/ch01-定位与架构全景' },
          { text: 'Ch02 · 环境搭建与跑通',     link: '/ch02-环境搭建与跑通' },
          { text: 'Ch03 · Gateway 源码精读',   link: '/ch03-gateway源码精读' },
          { text: 'Ch04 · Pi Agent 内嵌运行时',link: '/ch04-pi-agent源码精读' },
          { text: 'Ch05 · 记忆体系',            link: '/ch05-记忆体系' },
          { text: 'Ch06 · Channels 渠道适配层', link: '/ch06-channels源码精读' },
          { text: 'Ch07 · Tools/Skills/Plugins',link: '/ch07-tools-skills-plugins' },
          { text: 'Ch08 · 多 Agent 确定性路由', link: '/ch08-多agent路由' },
          { text: 'Ch09 · 动手：写自己的扩展',  link: '/ch09-动手扩展' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/ZhuOS/openclaw-learn' },
    ],

    editLink: {
      pattern: 'https://github.com/ZhuOS/openclaw-learn/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页',
    },

    footer: {
      message: '基于 MIT License 发布',
      copyright: 'Copyright © 2026 Mason Zhu',
    },

    search: {
      provider: 'local',
    },

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    docFooter: {
      prev: '上一章',
      next: '下一章',
    },

    lastUpdated: {
      text: '最后更新',
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
