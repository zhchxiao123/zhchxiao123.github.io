---
layout: post
title: "Ralph Loop 完整使用指南：从零到让 AI 自主写代码"
date: 2026-05-06 16:31:00 +0800
categories: [AI, Agent, 教程]
tags: [Ralph Loop, Agent, Claude Code, Docker, 自动化开发]
description: 手把手教你安装、配置、运行 Ralph Loop，让 AI Agent 在 Docker 沙箱里自主完成项目开发任务。包含 PRD 创建、任务清单配置、多 Agent 切换、常见问题排查等完整流程。
---

> 🐷 俺老猪上篇把 Ralph Loop 的源码扒了个底朝天，这篇就来点实在的——手把手教你怎么把它跑起来，让 AI 帮你写代码！

---

## 一、Ralph Loop 是什么？

简单说：**把项目需求丢给它，它在 Docker 沙箱里自己写代码、跑测试、修 bug、提交 commit，直到全部完成。**

```
你写 PRD → Ralph 拆成任务清单 → Agent 逐个完成 → 自动 commit → 循环直到全部通过
```

它支持 Claude Code / Codex / Copilot / Cursor / Gemini / OpenCode 六种 AI 编程工具，默认用 Claude。

---

## 二、环境准备

### 2.1 前提条件

| 依赖 | 说明 | 检查命令 |
|------|------|----------|
| **Node.js** | 项目运行环境 | `node -v`（建议 18+） |
| **Docker** | 沙箱隔离环境 | `docker ps` |
| **Docker Sandboxes** | Docker 官方 AI 沙箱 | 见下方安装步骤 |
| **Git** | 版本控制 | `git --version` |

### 2.2 安装 Docker Sandboxes

Ralph 依赖 Docker 的 AI Sandboxes 功能来给 Agent 提供隔离的运行环境。

```bash
# 1. 确保 Docker Desktop 已安装并运行
# 2. 参考 Docker AI 官方文档完成 Sandboxes 设置
#    https://docs.docker.com/ai/sandboxes/
```

> ⚠️ **重要**：首次使用需要登录 Docker 并在沙箱内认证 AI 工具，后面 Step 3 会讲到。

---

## 三、四步启动 Ralph

### Step 1：安装 Ralph

在项目根目录执行：

```bash
npx @pageai/ralph-loop
```

这会下载 Ralph 的所有脚本到当前项目的 `scripts/` 目录，并创建 `.agent/` 配置目录。

安装完成后，项目目录会多出这些文件：

```
your-project/
├── ralph.sh                 # 主启动脚本
├── scripts/
│   └── lib/                 # 14 个功能模块
│       ├── agents.sh        # 多 Agent 管理
│       ├── promise.sh       # 标签协议
│       ├── spinner.sh       # 实时动画
│       ├── timing.sh        # 时间统计
│       └── ...
└── .agent/                  # Agent 配置目录（待填充）
    ├── PROMPT.md            # Agent 任务说明书
    ├── prd/                 # 产品需求文档
    │   ├── PRD.md
    │   └── SUMMARY.md
    ├── tasks.json           # 任务清单
    ├── tasks/               # 每个任务的详细步骤
    ├── logs/                # 运行日志
    ├── screenshots/         # 自动截图
    └── history/             # 迭代历史
```

---

### Step 2：创建 PRD + 任务清单

这是最关键的一步——**告诉 AI 你要做什么**。

#### 2.1 使用 prd-creator 技能

打开 Claude Code 或 Cursor，切换到 **Plan 模式**，输入你的需求：

```
Use the prd-creator skill to help me create a PRD and task list
for the below requirements.

An app is already set up with React, Tailwind CSS and TypeScript.

Requirements:
- A SaaS product that helps users manage their finances
- Target audience: Small business owners and freelancers
- Core features:
  - Track income and expenses
  - Create and send invoices
  - Track payments and receipts
  - Generate reports and insights
  - Connect to bank accounts and credit cards
- Use the shadcn/ui library for components
- Integrate with Stripe for payments
- Use Supabase for database
- Env variables in .env.example: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY
```

![alt text](/assets/img/ralph-loop-usage-guide/image.png)

![alt text](/assets/img/ralph-loop-usage-guide/image_v2.png)

#### 2.2 写好需求的 Pro Tips 🏆

| 技巧 | 示例 |
|------|------|
| **指定技术栈** | "用 React + Tailwind + shadcn/ui" |
| **列出环境变量** | "SUPABASE_URL、STRIPE_SECRET_KEY 在 .env 中" |
| **描述用户流程** | "用户登录后看到仪表盘，点击新建发票..." |
| **附加参考文档** | 把设计稿/API 文档放 `/docs` 目录并在需求中提及 |
| **越详细越好** | 别怕啰嗦，AI 不会嫌你烦 |

#### 2.3 审查任务清单

PRD 生成后，AI 会自动拆成 `tasks.json` + 每个任务的详细步骤文件。

**🐷 老猪忠告：一定要逐条审查每个任务！** 看看步骤是否合理、依赖是否正确、验收标准是否清晰。这一步花 10 分钟，能省后面 10 小时。

![alt text](/assets/img/ralph-loop-usage-guide/image_v3.png)

---

### Step 3：在 Docker 沙箱中设置 Agent

#### 3.1 登录认证

```bash
# 默认用 Claude
./ralph.sh --login

# 用其他 Agent
./ralph.sh --login --agent codex
./ralph.sh --login --agent cursor
```

Ralph 会打印所有支持的登录命令，然后在正确命名的沙箱中打开对应 Agent，按提示完成登录。

> 👉 当提示 **"Bypass Permissions mode"** 时，选 **Yes**——这就是你用 Docker 沙箱的原因，让 Agent 有权限自由操作。

#### 3.2 沙箱命名规则

Ralph 用确定性算法给沙箱命名：

```
ralph-{agent}-{项目目录名}-{路径 SHA256 前8位}
```

例如：`ralph-claude-my-app-a1b2c3d4`

同一个项目 + 同一个 Agent = 永远用同一个沙箱，状态自动持久化。

```bash
# 查看沙箱名称（不启动循环）
./ralph.sh --print-name
./ralph.sh --print-name --agent cursor
```

#### 3.3 暴露开发服务器端口

Agent 在沙箱里跑 `npm run dev` 后，需要把端口映射出来才能在浏览器预览：

```bash
# 暴露默认端口
./ralph.sh --ports

# 指定 Agent
./ralph.sh --ports --agent codex
```

端口号从安装时设置的 `RALPH_DEFAULT_PORTS` 读取。

---

### Step 4：运行 Ralph！

```bash
# 跑 50 轮迭代
./ralph.sh -n 50

# 只跑一轮（测试用）
./ralph.sh --once

# 指定 Agent
./ralph.sh -n 50 --agent codex

# 查看帮助
./ralph.sh --help
```

> ⏱️ 注意：第一轮迭代会花大约 5 分钟来初始化沙箱环境（装依赖、配工具链），后面就快了。

---

## 四、运行时你会看到什么

启动后终端会显示实时状态：

```
░░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░
  ↪ Iteration 1 of 50
░░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░

  ⠼ Implementing
  ▸ Write file_path=/src/components/Dashboard.tsx
```

| 元素 | 含义 |
|------|------|
| `⠼` | 旋转动画（14 种字符轮换） |
| `Implementing` | 当前步骤（14 种步骤类型之一） |
| `▸ Write file_path=...` | Agent 正在执行的具体操作 |

### 步骤类型与 Emoji

| Emoji | 步骤 | 含义 |
|-------|------|------|
| 🤔 | Thinking | 思考中 |
| 🗺️ | Planning | 规划中 |
| 📖 | Reading code | 读代码 |
| 🌐 | Web research | 查资料 |
| ⚡ | Implementing | 写代码 |
| 🐛 | Debugging | 调试 |
| ✍️ | Writing tests | 写测试 |
| 🧪 | Testing | 跑测试 |
| 🧹 | Linting | 代码检查 |
| 📝 | Typechecking | 类型检查 |
| 📦 | Installing | 装依赖 |
| ✅ | Verifying | 验证 |
| ⏳ | Waiting | 等待 |
| 🚀 | Committing | 提交 |

### 每轮结束后的统计

```
  └── ✓ Iteration 1 complete  TASK-001  │ Iteration: 12:35  │ Average: 12:35  │ Total: 12:35
      └── ⚡ Implementing: 8:20 │ 🧪 Testing: 2:15 │ 📖 Reading code: 1:10 │ 🐛 Debugging: 0:50
```

---

## 五、Promise 标签协议：Agent 如何"举手"求助

Ralph 最巧妙的设计——Agent 遇到问题时不是瞎搞或崩溃，而是输出特定标签"举手"：

### 5.1 三种标签

| 标签 | 含义 | 触发场景 |
|------|------|----------|
| `<promise>COMPLETE</promise>` | 全部完成 🎉 | tasks.json 全部 passes=true |
| `<promise>BLOCKED:原因</promise>` | 技术阻塞 🚫 | API 挂了、凭证过期、环境问题 |
| `<promise>DECIDE:问题</promise>` | 需要决策 🤔 | 架构选择、依赖冲突、需求模糊 |

### 5.2 阻塞后的处理流程

```
Agent 输出 <promise>BLOCKED:Stripe API key invalid</promise>
         ↓
Ralph 检测到标签 → 停止循环 → 发系统通知 → 显示阻塞原因
         ↓
你去修好 API Key
         ↓
重新运行 ./ralph.sh → 从上次中断处继续
```

### 5.3 BLOCKED 的快速退出规则

有些问题 Agent 试多少次都没用，Ralph 要求第一次失败就输出 BLOCKED：

- 网络策略阻止（防火墙）
- 凭证/API Key 无效
- 必需的系统服务不可用
- 硬件/架构不兼容

> 🐷 这些不是 bug，重试、换源、换包管理器都没用，直接举手！

---

## 六、多 Agent 切换

Ralph 支持 6 种 AI 编程工具，切换只需一个参数：

```bash
# Claude Code（默认）
./ralph.sh -n 50

# OpenAI Codex
./ralph.sh -n 50 --agent codex

# GitHub Copilot
./ralph.sh -n 50 --agent copilot

# Cursor
./ralph.sh -n 50 --agent cursor

# Google Gemini
./ralph.sh -n 50 --agent gemini

# OpenCode
./ralph.sh -n 50 --agent opencode
```

不同 Agent 有独立的 Docker 沙箱，互不干扰。你甚至可以同时用两个 Agent 跑同一个项目来对比效果。

---

## 七、输出产物

Ralph 跑完后会留下完整的开发记录：

| 产物 | 路径 | 说明 |
|------|------|------|
| **迭代历史** | `.agent/history/ITERATION-{时间}-{N}.txt` | 每轮 Agent 的完整输出 |
| **进度日志** | `.agent/logs/LOG.md` | 每个任务的完成记录 |
| **截图** | `.agent/screenshots/TASK-{ID}-{index}.png` | UI 任务的自动截图 |
| **时间统计** | 终端输出 | 14 种步骤的耗时分布 |
| **Git 提交** | `git log` | 每个任务独立 commit |

---

## 八、PROMPT.md 详解 — Agent 的"任务说明书"

`.agent/PROMPT.md` 是发给 AI Agent 的核心指令，内容如下：

```markdown
> ⛔ ONE TASK PER INVOCATION — Complete one task from tasks.json,
>   verify it passes all checks, then stop. Do not start another task.

1. Read .agent/PROMPT.md, .agent/prd/SUMMARY.md, and .agent/prd/PRD.md
2. Find the highest-priority incomplete task in .agent/tasks.json
3. Read the task's detailed spec in .agent/tasks/TASK-{ID}.json
4. Implement the task following the spec's steps
5. Verify: run tests, linting, and type checking
6. Update task status in tasks.json (passes → true)
7. Commit changes with a descriptive message
```

### 关键约束

| 约束 | 为什么 |
|------|--------|
| **一次只做一个任务** | 防止 Agent 贪多嚼不烂 |
| **必须先读文档** | 理解项目全貌，避免瞎写 |
| **按优先级选任务** | 关键路径优先 |
| **三重门禁** | test + lint + typecheck 全过才算完成 |
| **必须 commit** | 每个任务独立提交，方便回滚 |
| **完成后立即停止** | 由 Ralph 主循环决定是否继续 |

### Agent 的工作流

```
读取 PROMPT.md + PRD + SUMMARY.md
         ↓
找 tasks.json 中优先级最高、passes=false 的任务
         ↓
读取 TASK-{ID}.json 的详细步骤
         ↓
按步骤实现 → 写单元测试 → UI 任务做 Playwright 冒烟测试
         ↓
eslint --fix → prettier --write → tsc → 全项目测试
         ↓
全部通过 → passes=true → 写 LOG.md → 更新 STRUCTURE.md
         ↓
commit → 输出 <promise>TASK-{ID}:DONE</promise> → 停止
```

---

## 九、常见问题排查

### 9.1 Docker daemon not ready

```
❌ Docker Error
Docker daemon is not ready. Please ensure Docker is running.
```

**解决**：启动 Docker Desktop，等它完全就绪后再运行。

### 9.2 Invalid API key

```
❌ Authentication Error
Invalid API key. Please authenticate inside the Docker sandbox.
```

**解决**：运行 `./ralph.sh --login` 重新登录。

### 9.3 沙箱里装依赖太慢

第一轮迭代会装所有 npm 依赖，之后沙箱持久化，后续迭代不用重装。

### 9.4 Agent 卡住了

Ralph 不会无限等待——达到 `MAX_ITERATIONS` 后自动退出，退出码 `45`。

### 9.5 想换 Agent 重跑

```bash
# 换个 Agent，自动创建新沙箱
./ralph.sh -n 50 --agent codex
```

原 Agent 的沙箱和进度都保留，互不影响。

---

## 十、最佳实践

### 10.1 需求要写详细

> 🐷 俺老猪见过太多人写需求就一句话："帮我做个电商网站"。你这让 AI 怎么搞？

至少包含：技术栈、核心功能、用户流程、UI 参考、环境变量。

### 10.2 逐条审查任务

PRD 工具生成的任务清单不一定完美，花 10 分钟审查能避免 Agent 跑偏。

### 10.3 先用 --once 测试

```bash
./ralph.sh --once
```

跑一轮看看 Agent 能不能正常工作，确认没问题再 `-n 50`。

### 10.4 善用 BLOCKED/DECIDE

在 PROMPT.md 里可以自定义什么情况该举手。合理的举手策略比 Agent 硬着头皮瞎搞强一百倍。

### 10.5 看截图验证 UI

Agent 每完成一个 UI 任务会自动截图到 `.agent/screenshots/`，不用跑起来就能看到界面效果。

---

## 十一、总结

Ralph Loop 把 AI 编程从"对话式辅助"升级到了"自主循环执行"：

```
传统方式：你问一句 → AI 写一段 → 你复制粘贴 → 跑测试 → 修 bug → 再问...
Ralph 方式：你写 PRD → 去喝咖啡 → 回来看结果 ☕
```

**适合场景**：
- 有明确 PRD 的中小型项目
- 想验证"AI 能不能自己写完一个功能"
- 需要支持多种 AI 工具切换对比的团队

**不适合场景**：
- 需求模糊、需要大量探索的项目
- 没有 Docker 环境
- Windows 用户（需 WSL）

---

> 📝 **本文基于 Ralph Loop v1.x 官方文档编写。**
>
> 🐷 俺老猪的建议：先拿个小项目试试水，感受一下"AI 自己写代码"的快感，再决定要不要上生产。有问题随时问俺！

---

