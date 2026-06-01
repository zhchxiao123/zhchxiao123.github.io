---
title: "为什么 CLI 胜过 MCP 对于 AI 代理"
date: 2026-06-01 18:15:31 +0800
categories: [AI, 工具]
tags: [CLI, MCP, AI Agent, 译文, OpenClaw, 开发工具]
description: "Peter Steinberger（190K GitHub Stars）的核心观点：MCP servers 使上下文窗口膨胀，CLI 才是 AI Agent 工具调用的正确范式。附 CLI 构建指南。"
pin: false
---

---
title: 为什么 CLI 胜过 MCP 对于 AI 代理
item_type: note
tags: []
created_at: 2026-03-17 00:41:57

---

---
title: 为什么 CLI 胜过 MCP 对于 AI 代理
item_type: note
tags: []
created_at: 2026-03-17 00:41:57
---
| **标题** | Why CLIs Beat MCP for AI Agents — And How to Build Your Own CLI Army |
| **副标题** | The Guy With 190K GitHub Stars Just Proved Me Right |
| **作者** | Phil \| Rentier Digital Automation |
| **发布时间** | 2026-02-17 |
| **阅读时间** | 12 分钟 |
| **Claps** | 1.6K |
| **评论数** | 39 |
| **原文链接** | https://medium.com/@rentierdigital/why-clis-beat-mcp-for-ai-agents-and-how-to-build-your-own-cli-army-6c27b0aec969 |
| **获取方式** | Medium API (RapidAPI) - 完整内容 |

---

## 🎯 核心观点

> **"mcp were a mistake. bash is better."**
> 
> — Peter Steinberger (OpenClaw 作者，190K GitHub Stars，已被 Sam Altman 招募到 OpenAI)

### TL;DR

- **MCP servers** 会使你的上下文窗口膨胀，增加脆弱的依赖，并解决了一个**本不存在的问题**（如果你的工具是 CLIs）
- Peter Steinberger 为 OpenClaw 构建了约 **10 个自定义 CLIs**，并因此被 OpenAI 招募
- 你可以使用相同的模式：
  - 在 `CLAUDE.md` 中记录 CLIs 供 Claude Code 使用
  - 将它们作为技能插入 OpenClaw
  - 或使用 OpenClaw 框架构建自己的自主代理

---

## 📝 完整文章内容

### 引言

六个字。这就是 Peter Steinberger——OpenClaw 背后的男人，拥有 190,000 GitHub Stars，[最近被 Sam Altman 招募](https://medium.com/@rentierdigital/peter-steinberger-chose-openai-over-meta-fe8433cda551?sk=4aa8dc8ff3d7133a0a82475a180e9e1d)——上个月在 X 上发布的内容。我的第一反应是截图并用全大写的 "**TOLD YOU SO**" 发给三个开发者朋友。

我在 Ubuntu 上开发已经很多年了。

我每天使用的每个工具都是 CLI：Supabase CLI、Vercel CLI、Docker、git、n8n——我的整个技术栈都从终端运行。当 MCP servers 去年开始流行时，我尝试了一些。它们能工作。但它们也**消耗了 40% 的上下文窗口**，随机崩溃，并为本可以用一行命令和管道完成的事情增加了依赖。

所以当 2026 年最多产的开源开发者说 **CLIs 是 AI 代理与世界之间的真正接口**，并且 OpenAI 同意到足以雇佣他时，也许是时候注意一下了。

---

## 反对 MCP 的案例（为什么 OpenClaw  guy 同意我的终端）

让我们对 AI 代理与外部工具交互的方式进行排名。从最差到最好。

**GUIs** 显然出局了。你不会要求你的 CI/CD 管道在浏览器中点击按钮。同样的逻辑适用于代理。继续。

**REST APIs 和 SDKs** 可以工作。但每个服务都有自己的认证流程、响应格式、错误处理。你最终要为每个集成编写包装代码。这对于 SaaS 后端来说还可以。但对于一个只需要检查你是否有新邮件的代理来说，这就过度了。

**MCP** - Model Context Protocol - 本应解决这个问题。一个标准协议来连接代理和工具。理论上听起来很棒。实际上？你添加的每个 MCP server 都会将其整个模式转储到代理的上下文窗口中。工具描述、参数列表、能力声明——所有这一切。在你的代理甚至开始思考你的实际请求之前，30-40% 的上下文已经被 MCP 样板代码消耗了。

Peter Steinberger 尝试过。构建了支持。然后构建了 MCPorter——一个真正将 MCP servers 转换回 CLIs 的工具。因为他认为这个格式错得有多离谱。

他对 MCP 实际上对生态系统的贡献的原话："MCP 唯一的好东西是公司开放了一些 APIs。"

残酷。但准确。

协议本身是一个弯路——它迫使存在的 APIs 才是真正的礼物。

**CLIs** 获胜，因为它们是这一切膨胀的反面。CLI 是：

- **零上下文开销**。你的代理不需要加载模式。它阅读一页文档（或运行 `--help`）就知道每个可用命令。

- **可组合**。将一个 CLI 的输出管道到另一个。`goplaces search "coffee" --json | jq '.[0].address'`——试试用 MCP server 做这个。

- **2 秒内可测试**。打开终端，运行命令，看看发生了什么。不需要启动服务器，不需要协议握手，不需要 WebSocket 连接。

- **免费的结构化输出**。添加一个 `--json` 标志，你的代理无需任何序列化层即可获得可解析的数据。

一个 `exec` 调用。这就是代理使用 CLI 所需的全部内容。没有中间件，没有协议，没有在后台运行消耗 RAM 的服务器进程。

这不是某种理论偏好。

Steinberger 围绕 CLIs 构建了他的整个 OpenClaw 生态系统。大约十几个：`goplaces` 用于 Google Maps，`imsg` 用于 iMessage，`bird` 用于 X/Twitter，`wacli` 用于 WhatsApp，`gog` 用于 Gmail 和日历，`camsnap` 用于安全摄像头，`peekaboo` 用于带有 AI 视觉的 macOS 截图，`summarize` 用于消化视频和播客。每个都遵循相同的模式：做好一件事，支持 `--json`，有清晰的 `--help`。

> 然后 OpenAI 雇佣了他。

他花了将近一年的时间构建这个 CLI 军队。然后 OpenAI 雇佣了他。Sam Altman 没有招募一个构建漂亮仪表板的人——他招募了证明 `bash` 是最佳代理接口的人。你自己想想这意味着什么。

---

## 立即使用 CLIs 构建更快（不需要 OpenClaw）

你不需要 OpenClaw 就能从中受益。如果你使用 Claude Code、Codex 或任何具有 shell 访问权限的代理，你已经拥有了基础设施。

大多数人错过的技巧：你的代理已经可以调用 CLIs。但它不知道你的特定 CLIs，除非你告诉它。

```markdown
# CLAUDE.md（项目根目录）

## 可用 CLIs

### Supabase
- `supabase db push` - 应用迁移到远程
- `supabase functions deploy <name>` - 部署 edge 函数
- `supabase db dump --data-only` - 导出生产数据
- `supabase migration new <name>` - 创建新的迁移文件

### Vercel  
- `vercel deploy --prod` - 部署到生产
- `vercel env pull .env.local` - 同步环境变量
- `vercel logs <url> --follow` - 跟踪生产日志

### 项目特定
- `./scripts/check-mrr.sh` - 输出包含当前 MRR、注册、流失的 JSON
- `./scripts/seed-demo.sh` - 用示例数据重置演示环境
```

就是这样。

Claude Code 在每次会话开始时阅读 `CLAUDE.md`。下次你说"部署到生产并检查 MRR 是否变化"时，它知道要运行哪些命令。没有插件，没有 MCP server，没有包含 47 个嵌套键的配置文件。

对于 Codex，概念相同——文件名为 `AGENTS.md`。

对于 Cursor，是 `.cursorrules`。

文件名不同，模式相同。

但真正的力量在于构建你自己的 CLIs。在你关闭这个标签页认为"我没有时间构建 CLI 工具"之前——我们说的是 20-30 行代码。认真的。

### 代理友好 CLI 的三条规则

#### 1. 使用 `--json` 的结构化输出

你的代理无法解析带有框绘字符的漂亮表格。它需要 JSON。

```javascript
#!/usr/bin/env node
// scripts/check-mrr.js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const { data } = await supabase
  .from('subscriptions')
  .select('plan, status, created_at')

const active = data.filter(s => s.status === 'active')
const mrr = active.reduce((sum, s) => sum + (s.plan === 'pro' ? 29 : 9), 0)
const today = data.filter(s => 
  new Date(s.created_at).toDateString() === new Date().toDateString()
)
const stats = {
  mrr,
  active_subscriptions: active.length,
  signups_today: today.length,
  timestamp: new Date().toISOString()
}
if (jsonMode) {
  console.log(JSON.stringify(stats))
} else {
  console.log(`MRR: $${mrr}`)
  console.log(`Active: ${active.length}`)
  console.log(`Signups today: ${today.length}`)
}
```

#### 2. 一个真正解释事情的 `--help`

代理阅读 `--help` 就像人类阅读 READMEs。如果你的帮助文本是垃圾，你的代理将幻觉标志。

```sql
$ ./check-mrr.js --help
Usage: check-mrr [options]

Check current SaaS metrics from Supabase.
Options:
  --json     Output as JSON (default: human-readable)
  --period   Filter: today | week | month (default: today)
  --help     Show this message
```

#### 3. 干净的退出码

0 = 成功。1 = 错误。

你的代理使用这个来决定下一步做什么。如果你的 CLI 在失败时退出 0，你的代理会认为一切正常并继续。

我是在凌晨 2 点痛苦地学到这一点的，当时我的部署脚本静默失败，Claude 一直告诉我"部署成功"——花了 20 分钟才意识到脚本在吞错误并仍然退出 0，但这题外话了。

一旦你有了几个这样的 CLIs，事情就会发生变化。

你不再要求 Claude Code 编写 Supabase 查询。你开始说"检查我的指标，如果注册比昨天下降超过 20%，起草一封 Slack 消息给团队"。Claude 将 CLIs 链接在一起，决定逻辑，对结果采取行动。这不是自动完成。这是一个代理。

---

## 扩展的模式：CLI + 技能文档

所以这是 Steinberger 早期就弄明白的事情，而大多数人仍然没有内化：**没有文档的 CLI 对代理来说是无用的**。

你的代理不能像人类那样通过试错来探索 CLI。它需要事先知道存在哪些命令、可用哪些标志、输出看起来像什么。这就是为什么 OpenClaw 生态系统中的每个 CLI 都附带一个 `SKILL.md`——一个结构化的文档，作为代理的说明书。

模式是：**CLI 二进制文件 + 技能文档 = 自主能力**。

CLI 做工作。技能文档教代理如何使用它。它们一起是一个自包含的单元，任何代理都可以拿起并运行。Steinberger 称它们为"技能"。无论你称它为技能、工具还是"Dave 上周二编写的那个 bash 脚本"，概念都是一样的。

你不需要 OpenClaw 就能使用这个模式。你实际上已经在用了——当你编写一个记录你的 CLIs 的 CLAUDE.md 时，那就是一个技能文档。不同的是 Steinberger 标准化了格式并在其上构建了一个分发层：ClawHub，拥有 3000+ 你可以浏览和安装的技能。

有趣的部分？你可以为你自己的设置窃取任何这些技能。ClawHub 上的每个技能都是一个你可以独立安装的二进制文件（`brew install steipete/tap/goplaces`，`npm install -g @steipete/oracle` 等）和一个你可以阅读的 SKILL.md。你不需要 OpenClaw 运行时。安装二进制文件，将相关命令粘贴到你的 CLAUDE.md 中，Claude Code 可以立即使用它。

```sql
# 在你的 CLAUDE.md 中 - 直接从 ClawHub 窃取

## goplaces (Google Maps CLI)
- `goplaces search "coffee near me" --open-now --json` - 查找地点
- `goplaces search "pizza" --lat 40.8 --lng -73.9 --radius-m 3000 --json` - 位置偏向搜索
- `goplaces details <place_id> --json` - 包含评论的完整地点详情
- `goplaces resolve "Soho, London" --json` - 地理编码地点名称
需要：GOOGLE_PLACES_API_KEY 环境变量

## summarize (视频/播客/网页摘要 CLI)
- `summarize --url "https://youtube.com/watch?v=xxx" --json` - 摘要视频
- `summarize --url "https://some-blog.com/post" --json` - 摘要网页
- `summarize --url "https://podcast.fm/ep42" --cli claude --json` - 选择使用哪个模型
```

这就是 goplaces 和 summarize——Steinberger 自己的两个工具——在 Claude Code 中运行，零 OpenClaw 依赖。只是一个二进制文件和一个文档。

这就是为什么 CLI 方法以 MCP 永远无法的方式扩展。MCP server 是一个需要配置、协议握手和上下文窗口空间的运行进程。CLI 技能是一个静态二进制文件和一个文本文件。一个需要基础设施。另一个需要 `brew install` 和 10 行 markdown。

---

## 将 CLIs 插入 OpenClaw

如果你已经在运行 OpenClaw，将 CLI 转换为代理技能大约需要 5 分钟。

系统工作原理如下：每个技能都有一个 `SKILL.md` 文件，描述 CLI 做什么、如何安装以及可用哪些命令。代理阅读该文件并知道如何使用该工具。

```yaml
---
name: check-mrr
description: Check SaaS metrics (MRR, signups, churn) from Supabase.
metadata:
  openclaw:
    requires:
      env:
        - SUPABASE_URL
        - SUPABASE_KEY
      bins:
        - node
    primaryEnv: SUPABASE_URL
---

# check-mrr
Get current SaaS metrics from production Supabase.
## Install
npm install -g @yourhandle/check-mrr
## Commands
- `check-mrr --json` - full metrics as JSON
- `check-mrr --period week` - metrics for the current week
- `check-mrr --period month` - monthly overview
## Output format (--json)
{
  "mrr": 1247,
  "active_subscriptions": 89,
  "signups_today": 3,
  "timestamp": "2026-02-17T10:30:00Z"
}
```

将其发布到 ClawHub（`clawhub publish`），任何运行 OpenClaw 的人都可以安装你的技能。但真正的价值在于本地：将它与 cron 作业结合，你的代理每天早上检查你的指标，如果有什么不对劲就在 WhatsApp 上通知你。

```json
// 在 openclaw.json 中
{
  "cron": [
    {
      "schedule": "0 8 * * *",
      "message": "Run check-mrr --json. If signups_today is 0 or mrr dropped more than 5% from yesterday, alert me on WhatsApp with a summary. Otherwise just log it.",
      "channel": "whatsapp"
    }
  ]
}
```

这就是完整的循环。Cron 触发代理，代理阅读技能，调用 CLI，解释结果，决定做什么。不需要检查仪表板。不需要来自你不需要警报的通知疲劳。代理使用判断力——这与 Steinberger 在整个设置中运行的模式相同。

ClawHub 目录已经有 3000+ 第三方技能，大多数都遵循这个确切的结构。`goplaces` 用于位置搜索，`himalaya` 用于通过 IMAP 的电子邮件，`bird`（😭）用于 X/Twitter，`sonoscli` 用于扬声器控制——整个军队。你安装它们，代理学习它们，完成。

---

## 构建你自己的代理（OpenClaw 模式，无需 OpenClaw）

好的，如果你不想运行 OpenClaw 怎么办？

也许你想要更轻量级、更定制的东西，或者你只是喜欢从头开始构建东西。（我理解。我自托管一切。这是一种病。）

核心模式非常简单：一个调用 Anthropic API 与 `tool_use` 的脚本，将工具调用映射到 CLI 执行，并循环直到代理完成。

```javascript
import Anthropic from '@anthropic-ai/sdk'
import { execSync } from 'child_process'

const client = new Anthropic()
// 你的 CLIs，声明为工具
const tools = [
  {
    name: "check_mrr",
    description: "Get current SaaS metrics (MRR, active subs, signups today)",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "week", "month"], default: "today" }
      }
    }
  },
  {
    name: "deploy_production",
    description: "Deploy latest commit to Vercel production. Returns deploy URL.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "send_slack",
    description: "Send a message to a Slack channel",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        message: { type: "string" }
      },
      required: ["channel", "message"]
    }
  }
]
// 将工具名称映射到 CLI 命令
function executeTool(name, input) {
  const commands = {
    check_mrr: `node ./scripts/check-mrr.js --json --period ${input.period || 'today'}`,
    deploy_production: `vercel deploy --prod --yes 2>&1`,
    send_slack: `curl -X POST -H 'Authorization: Bearer ${process.env.SLACK_TOKEN}' \
      -H 'Content-Type: application/json' \
      -d '{"channel":"${input.channel}","text":"${input.message}"}' \
      https://slack.com/api/chat.postMessage`
  }
  
  try {
    const result = execSync(commands[name], { encoding: 'utf-8', timeout: 30000 })
    return result
  } catch (err) {
    return JSON.stringify({ error: err.message, exitCode: err.status })
  }
}
// 代理循环
async function runAgent(task) {
  let messages = [{ role: "user", content: task }]
  
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 4096,
      system: "You are an autonomous agent. Use the available tools to complete tasks. Be concise in your reasoning.",
      tools,
      messages
    })
    // 如果 Claude 说完话，我们就完成了
    if (response.stop_reason === "end_turn") {
      const text = response.content.find(b => b.type === 'text')
      return text?.text || 'Done.'
    }
    // 如果 Claude 想使用工具，执行它们
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    if (toolBlocks.length === 0) break
    messages.push({ role: "assistant", content: response.content })
    const toolResults = toolBlocks.map(block => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: executeTool(block.name, block.input)
    }))
    messages.push({ role: "user", content: toolResults })
  }
}
// 运行它
const result = await runAgent(
  "Check our MRR. If it's above $1000, deploy to production and notify #team on Slack with the metrics. If it's below, just send a warning to Slack."
)
console.log(result)
```

**约 80 行**。这就是你的迷你 OpenClaw。代理根据你给它的任务决定调用哪些工具以及以什么顺序调用。添加新的 CLI 需要 30 秒——添加一个工具定义，在 `commands` 映射中添加一行，完成。

对于自主部分，将其包装在 cron 中：

```bash
# crontab -e
0 8 * * * cd /home/deploy/my-agent && node agent.js "Morning check: metrics, deploy if stable, notify team"
0 20 * * * cd /home/deploy/my-agent && node agent.js "End of day: summarize signups, flag any anomalies to Slack"
```

你也可以将其作为带有计时器的 systemd 服务运行，或者将其放入服务器上的 Docker 容器中。相同的结果，不同口味的 devops。

**GitHub Actions** 是另一个选项，如果你想要零基础设施。一个预定的工作流，在 runner 中安装你的 CLIs 并调用 Anthropic API：

```yaml
name: Daily Agent Run
on:
  schedule:
    - cron: '0 8 * * *'

jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install @anthropic-ai/sdk
      - run: node agent.js "Morning routine"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
```

公共仓库免费，私有仓库每月 2000 分钟。对于一个在 30 秒内运行的日常代理来说还不错。

### **n8n 呢？**

你可以技术上通过 Execute Command 节点或通过将它们包装在 FastAPI 容器中来通过 n8n 编排 CLIs。

但老实说，对于这个用例来说，这比脚本方法有更多的摩擦。当你需要具有 15 个步骤和复杂分支的可视化工作流时，n8n 才会发光——而不是用于"调用 CLI 并让 LLM 决定"。

如果你想更深入地了解在 n8n 中运行自定义代码，我写了一篇关于 [从 n8n 调用 Python 脚本](https://medium.com/@rentierdigital/calling-a-python-script-from-n8n-5d2a34c9cd09) 的完整指南，涵盖了 Docker + FastAPI 设置。

---

## 这对你的意义

趋势很明确。

AI 代理空间中最多产的构建者不是在堆叠 MCP servers 和配置协议适配器。他们在编写小型、锋利的 CLIs 并让他们的代理调用它们。

Peter Steinberger 用 OpenClaw 大规模证明了这一点。OpenAI 用工作邀请验证了它。你今天就可以用 CLAUDE.md 文件和 20 行的 Node 脚本开始。

技术栈不重要。OpenClaw、Claude Code、Codex、自定义代理循环——模式是一样的。用 CLIs 包装你的工具。为你的代理记录它们。让 LLM 处理编排。

你的终端一直以来都是 AI 接口。大多数人只是还没有意识到。

---

*如果这对你有启发，请关注我获取更多经过实战检验的 AI 自动化内容。接下来：我正在构建一个完整的自主代理来管理我的 SaaS——部署、监控和处理支持票——完全通过 CLIs。没有仪表板。没有 GUI。只有一只龙虾和一个 cron 作业。* 🦞

---

## 💬 社区评论精选

### 1. Hunter Learn (49 个赞)
> "Cli is good but mcp is not only about calling api, it is also about data manipulation and computer use. You cannot use cli only to interact with business applications to utilize all of their functionality."

**观点**：CLI 很好，但 MCP 不仅仅是调用 API，还涉及数据操作和计算机使用。不能仅用 CLI 与业务应用程序交互以利用其全部功能。

### 2. ematese (25 个赞)
> "A year before clawdbot, I tried a third approach. It was to make the PC work exactly as we do: click here and there, open this or that program, do this, do that, etc. I used the Python libraries VisionUIParser, pytesseract, pyautogui, etc."

**观点**：尝试过让 PC 像人类一样工作：点击这里和那里，打开这个或那个程序等。使用了 VisionUIParser、pytesseract、pyautogui 等 Python 库。

### 3. Justin Ohms (32 个赞)
> "Funny I thought everyone was already doing this. I've been doing this for over a year at this point. Makes me wonder how anyone is getting anything done but this does explain why I never really need to use MCP"

**观点**：已经这样做了一年多，这解释了为什么他从来不需要使用 MCP。

---

## 🔗 作者的其他相关文章

1. **[I Stopped Vibe Coding and Started "Prompt Contracts"](https://medium.com/@rentierdigital/i-stopped-vibe-coding-and-started-prompt-contracts-claude-code-went-from-gambling-to-shipping-4080ef23efac)** (3.1K 赞)
   - Claude Code 从赌博到交付的转变

2. **[Anthropic Just Killed My $200/Month OpenClaw Setup. So I Rebuilt It for $15.](https://medium.com/@rentierdigital/anthropic-just-killed-my-200-month-openclaw-setup-so-i-rebuilt-it-for-15-9cab6814c556)** (1.1K 赞)
   - OpenClaw 实例在 Claude Max 上运行了六周后的重建经验

3. **[I Deployed My Own OpenClaw AI Agent in 4 Minutes](https://medium.com/@rentierdigital/i-deployed-my-own-openclaw-ai-agent-in-4-minutes-it-now-runs-my-life-from-a-5-server-8159e6cb41cc)** (1.2K 赞)
   - 从 $5 服务器上运行自己的 AI 代理

4. **[21 OpenClaw Automations Nobody Talks About](https://medium.com/@rentierdigital/21-openclaw-automations-nobody-talks-about-because-the-obvious-ones-already-broke-the-internet-3f881b9e0018)** (868 赞)
   - 因为明显的那些已经让互联网崩溃了

---

## 📌 关键要点总结

1. **CLI vs MCP 的辩论**：
   - CLI 更轻量、更稳定、不占用上下文窗口
   - MCP 增加了复杂性和依赖性

2. **Peter Steinberger 的案例**：
   - 为 OpenClaw 构建了 ~10 个自定义 CLIs
   - 因此被 OpenAI 招募
   - 证明了 CLI 方法的有效性

3. **实践建议**：
   - 在 `CLAUDE.md` 中记录你的 CLIs
   - 将 CLIs 作为技能插入 OpenClaw
   - 考虑构建自己的自主代理

4. **代码示例**：
   - 约 80 行代码即可构建自己的迷你 OpenClaw
   - 使用 cron 或 GitHub Actions 实现自动化
   - 遵循三条规则：`--json` 输出、清晰的 `--help`、干净的退出码

---

*获取时间：2026-03-17*
*获取工具：Medium API (RapidAPI)*
*API Key：已配置*
