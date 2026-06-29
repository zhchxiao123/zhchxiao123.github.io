---
layout: post
title: "Claude Code Agent Teams：架构与决策报告"
date: 2026-06-29 22:45:00 +0800
categories: ["AI", "技术报告", "Claude Code"]
tags: ["Claude Code", "Agent Teams", "Subagent", "Multi_Agent", "AI Agent"]
description: "一份 9 页深度演示报告：拆解 Claude Code Agent Teams 架构、与 Subagent 逐项对比、给出绿黄红决策框架，并落到内容 pipeline 的真实场景。"
---

## 📊 报告介绍

这份演示文稿是一份关于 **Claude Code Agent Teams**（实验特性）的 9 页深度研究报告。

- **状态**：Experimental · 默认关闭
- **要求**：v2.1.32+ · Opus 4.6
- **结构**：架构拆解 → 与 Subagent 对比 → 决策框架 → token 经济性 → 落地到内容 pipeline → 启用步骤 → 收束

报告里的核心主张只有一句话：

> 需要「干净的隔离」选 Subagent；需要「会对话的协作」选 Agent Team。找不出至少 3 条真正独立的并行工作流，就别上 team。

下方为可交互的演示文稿，支持 ← → 翻页、点圆点跳转、触屏滑动：

---

## 🎯 演示文稿（9 页 · 可交互）

<div class="deck-toolbar" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin:1.25rem 0 0.5rem;padding:10px 14px;border:1px solid var(--main-border-color, #e5e7eb);border-radius:8px;background:var(--sidebar-hover-bg, rgba(255,255,255,0.03));font-size:0.88rem;">
  <span style="color:var(--text-muted-color);">
    <i class="fas fa-expand-arrows-alt" style="margin-right:6px;"></i>
    需要更大的阅读空间 / 想分享给别人？
  </span>
  <a href="{{ '/assets/decks/claude-code-agent-teams.html' | relative_url }}"
     target="_blank"
     rel="noopener noreferrer"
     class="btn btn-outline-primary"
     style="font-size:0.85rem;padding:4px 14px;border-radius:6px;text-decoration:none;">
    🔗 在新标签页打开独立版
  </a>
</div>

<div class="deck-embed-wrapper" style="position:relative;width:100%;padding-top:62%;margin:0.25rem 0 1.5rem;border:1px solid var(--main-border-color, #e5e7eb);border-radius:10px;overflow:hidden;background:#0c0e12;">
  <iframe
    src="{{ '/assets/decks/claude-code-agent-teams.html' | relative_url }}"
    title="Claude Code Agent Teams 架构与决策报告"
    loading="lazy"
    allow="fullscreen"
    style="position:absolute;inset:0;width:100%;height:100%;border:0;display:block;">
  </iframe>
</div>

<p style="text-align:center;color:var(--text-muted-color);font-size:0.85rem;margin:0 0 1.5rem;">
  ⬆️ 键盘 ← → 翻页 · 数字键 1–9 直达 · 触屏滑动 · 或点底部圆点
</p>

---

## 📑 章节速览

| # | 章节 | 一句话要点 |
|---|---|---|
| 01 | 架构拆解 | Lead + N 个独立 session + Shared Task List + Mailbox |
| 02 | vs Subagent | Subagent 是「上下文卫生」；Team 是「协同编排」 |
| 03 | 逐项对照表 | 同一决策 7 个维度的快速查表 |
| 04 | 决策框架 | 绿灯 / 黄灯 / 红灯的判据清单 |
| 05 | token 经济性 | 典型 3 人 ≈ 3–4× 单 session，5 人起步就贵 |
| 06 | 落到内容 pipeline | 选题绿灯 · 抓取黄偏红 · 合成留单 session |
| 07 | 启用与习惯 | 5 行命令开启 + 4 条保命习惯 |
| 08 | 三句话收束 | 定位 / 代价 / 对你 / 判据 |

---

## 🔗 链接

- 🔗 **本演示文稿独立直链**：<https://zhchxiao123.github.io/assets/decks/claude-code-agent-teams.html>（可全屏打开、便于分享）
- 📘 官方文档：<https://code.claude.com/docs/en/agent-teams>
- 📦 Claude Code：<https://claude.com/product/claude-code>

> ⚠️ Agent Teams 是实验特性，迭代很快（TeamCreate/TeamDelete 已在 v2.1.178 移除）。落地前以官方文档为准。
