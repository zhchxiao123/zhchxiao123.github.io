---
title: 我的 AI 编程工具清单
date: 2026-04-12 23:50:00 +0800
categories: [工具]
tags: [AI, 编程工具, Codex, Claude, MiniMax, Ollama]
pin: false
---

## 写在前面

作为一个经常写代码的打工人，最近陆陆续续尝试了不少 AI 编程工具。今天整理一下目前自己在用的工具清单，顺便理一理不同工具的使用场景。

不是教程，不做推荐，只是记录。😄

## 工具清单

### 需要花钱的

| 工具 | 获取方式 | 价格 | 用途 |
|------|----------|------|------|
| **Antigravity** | 某鱼 | ¥128/年 | 成品号，自带额度 |
| **Codex (ChatGPT)** | 某鱼购买，比官方便宜 | ¥115/月 | 主要编程助手 |
| **MiniMax** | Plus-极速版套餐 | ¥99/月 | Claude Code 后端 |
| **Ollama Cloud** | 订阅套餐 | $20/月 | 云端模型服务 |

### 背后的模型

- **Codex** → GPT模型
- **Claude Code** → 可以接 MiniMax，也可以接 Ollama Cloud
- **Ollama Cloud** → 主要跑 glm-5.1 作为备用模型

## 使用架构

```
Antigravity

Codex (ChatGPT)
      │
      └── 额度用完时 → Ollama Cloud → glm-5.1

Claude Code
      │
      ├── → MiniMax
      │
      └── → Ollama Cloud → glm-5.1
```
