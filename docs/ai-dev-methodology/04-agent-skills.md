---
title: "工程实践：把方法论落地为 Agent Skills"
layout: documentation
project_id: ai-dev-methodology
permalink: /docs/ai-dev-methodology/04-agent-skills/
description: "把方法论三段式（为什么→做什么→怎么做）转化为 9 套可运行的 Agent Skills：基于社区事实标准 Agent Skills Spec，配套完整 SKILL.md 范例 + 5 分钟上手指引。"
---

> 副标题：当方法论遇见 Anthropic Agent Skills Spec——我们 9 岗位的"正确性"如何变成 agent 真的会用、能用、用了不绕的工程制品。

## 0. 这一章解决什么问题

前三章我们建立了一整套方法论：
- 思考手册：**驾驭生成—验证回路**（为什么）
- 9 岗位完整版：**每个岗位的正确性、验证信号、新护城河**（做什么）
- 最佳实践手册：**岗位常见问题、错误做法、SOP**（怎么做）

但方法论再完整，**如果 agent 不知道、不调用、调用了会绕弯，就只是"写给人看的文档"**。

AI 时代开发方法的下一个阶段，是把方法论打包成 **Agent Skills**——一种新兴的工程制品标准。Anthropic、Matt Pocock、obra/superpowers、Vercel Labs 都已经建立成熟的 skills 生态，Claude Code / Cursor / Codex / Gemini CLI / Goose 等 40+ agent 工具都原生支持。

**核心问题**：我们方法论中的 9 岗位"正确性"和"验证 SOP"，如何变成 9 套 agent 真会用的 Skill？

## 1. 什么是 Agent Skill

### 1.1 一句话定义

**Agent Skill 是一个被 agent 在合适的时机自动加载并遵循的可执行指令包**——本质是"agent 的肌肉记忆"。

| 概念 | 形态 | 谁使用 |
|---|---|---|
| Prompt | 一次性输入 | 人 |
| Document | 静态文档 | 人读 |
| **Skill** | **可执行指令包** | **agent** |

### 1.2 规范的解剖

社区事实标准由 [agentskills.io/specification](https://agentskills.io/specification) 定义。最简形态：

```
my-skill/
└── SKILL.md              # 必需
    ├── YAML frontmatter  # name + description
    └── Markdown body     # Iron Law / 流程 / 失败模式 / 范例
```

**SKILL.md 的 YAML 必填字段**（精确字段名）：

| 字段 | 必填 | 约束 |
|---|---|---|
| `name` | ✅ | ≤64 字符、小写字母数字+连字符、**必须与目录名一致** |
| `description` | ✅ | ≤1024 字符、必须描述"做什么"+"何时用" |
| `license` | ❌ | 可选，许可证信息 |
| `compatibility` | ❌ | ≤500 字符，兼容性说明 |
| `allowed-tools` | ❌ | 实验性，预批准工具列表 |

### 1.3 渐进披露（Progressive Disclosure）—— Skill 的灵魂

Skill 的关键设计是 **按需加载**：

| 阶段 | 加载内容 | 成本 |
|---|---|---|
| 启动时 | 只有 `name` + `description` | ~100 tokens / skill |
| Skill 激活时 | 完整 `SKILL.md` body | <5000 tokens 推荐 |
| 按需引用 | `references/`、`scripts/`、`assets/` | 按需 |

**为什么这是关键设计**？
- 你可以在项目里塞 50 个 Skill，**启动时只消耗 ~5000 tokens**（50 × 100）
- 只有当 agent 判断"现在需要这个 skill"时，才把完整内容拉进 context
- 完整的"长文档"也能塞进 skill 体系，**不被 token 预算约束**

### 1.4 主流生态一览

我研究了 4 个核心仓库：

#### [anthropics/skills](https://github.com/anthropics/skills)
- **定位**：规范制定者 + 文档处理 skills 集合（PDF/DOCX/PPTX/XLSX）
- **特点**：规范权威，单个 skill 体量大（30+ KB），依赖 scripts/references 拆分

#### [mattpocock/skills](https://github.com/mattpocock/skills)
- **定位**：工程与生产力 skill 的精品集
- **特点**：`writing-great-skills` 元 skill 教你写 skill；明确区分 **user-invoked** vs **model-invoked**；用"leading words"压缩 token
- **代表 skill**：`tdd`、`code-review`、`brainstorming`、`to-prd`

#### [obra/superpowers](https://github.com/obra/superpowers)
- **定位**：最严格的"过程工程化"skill 库
- **特点**：每个 skill 都有 **Iron Law + 7 列表 + 6 red flags + 6 rationalizations** 的固定结构；`using-superpowers` 元 skill 强制检查；14 个 skill 串成完整 pipeline（`brainstorming → writing-plans → using-git-worktrees → tdd → verification-before-completion → finishing-a-development-branch`）
- **代表 skill**：`verification-before-completion`（"没有新鲜证据不声称完成"）

#### [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)
- **定位**：Web/React/Next.js 的规则包
- **特点**：**manifest + rules 模式**——`SKILL.md` 是路由，实际内容在 `rules/*.md`；70+ 规则按 8 个优先级分层

### 1.5 Claude Code 的 Skill 扩展

Claude Code 实现了 Agent Skills 规范并加了三个扩展：

```yaml
---
name: my-skill
description: ...
disable-model-invocation: true   # 用户专用：必须 /skill 手动触发
context: fork                    # 在子 agent 中运行，自带独立 context
allowed-tools: Read, Edit, Bash   # 预批准工具列表
---
```

**存储优先级**（高到低）：Enterprise > Personal (`~/.claude/skills/`) > Project (`.claude/skills/`) > Plugin > Bundled

**`npx skills` CLI**（来自 vercel-labs/skills）支持 68+ agent 工具的安装管理：
```bash
npx skills add <user/repo>           # 安装
npx skills init                       # 在当前项目生成模板
npx skills use <source>              # 临时使用，不安装
```

## 2. 我们的空白：方法论 ≠ 工程制品

把方法论三章和社区生态对照，得到**清晰的空白地图**：

| 岗位 | 社区已有 skill | 我们方法论要求 | **空白** |
|---|---|---|---|
| 需求工程师 | `brainstorming`、`to-prd`、`grill-me` | 模糊愿望→验收用例 | **`acceptance-criteria-authoring` 缺** |
| 前端工程师 | `react-best-practices` (vercel) | 状态完整+体验可验 | **`state-matrix-builder` 缺** |
| 后端工程师 | （社区无专门 skill） | 契约/一致性/边界 | **`contract-first-api` 缺（最大空白）** |
| 测试工程师 | `tdd` (superpowers) | 高杀伤力验证信号 | **`mutation-killer-curve` 缺** |
| DevOps / SRE | （社区无专门 skill） | 可观测/可回滚 | **`blast-radius-audit` 缺** |
| 数据工程师 | （社区无专门 skill） | 口径一致/可对账 | **`metric-contract` 缺** |
| AI/LLM 应用 | （社区无专门 skill） | 效果可评估 | **`golden-set-builder` 缺** |
| 安全工程师 | （社区无专门 skill） | 攻击面/权限边界 | **`threat-model-mini` 缺** |
| 架构师 | `writing-plans`、`executing-plans` | 长期取舍/不可逆决策 | **`three-statement-architect` 缺** |

**核心洞察**：
- 社区覆盖了**工程纪律**（TDD、debugging、review）和**框架惯例**（React、Next.js）
- 社区**几乎完全沉默于"验证方法论"**——而这恰恰是我们方法论的核心
- 9 岗位"正确性"的层，**没有任何项目系统化覆盖**

**这就是我们的机会**：把方法论三章中"每个岗位的正确性"层做成 skill 库，补全生态空白。

## 3. 设计哲学：什么样的 Skill 是好 Skill

综合 superpowers + mattpocock + anthropic 的最佳实践，**好 skill 的 5 条铁律**：

### 铁律 1：Iron Law（一句话压顶）

> 每个 skill 顶部必须有一句**不可妥协的硬规则**，让 agent 读到时**产生敬畏感**。

对比：
- ❌ 模糊："你应该考虑验证一下"
- ✅ 铁律："**没有新鲜证据不声称完成**（verification-before-completion）"

### 铁律 2：Gate-shaped，不是 Advice-shaped

> Skill 应该是**门**（必须通过才能继续），不是**建议**（考虑一下做 X）。

对比：
- ❌ 建议："记得做单元测试"
- ✅ 门："**生成实现前必须定义 ≥1 个失败测试**（tdd）"

### 铁律 3：失败模式 + Rationalizations 表

> 显式列出 agent 一定会找的借口，并逐条反驳。

superpowers 的 `verification-before-completion` 有完整 6 行 rationalization 表：

| 借口 | 反驳 |
|---|---|
| "测试上次通过了应该没问题" | 上次通过 ≠ 这次通过，必须**本次会话**内重跑 |
| "linter 干净就够了" | 干净 ≠ 正确，linter 抓的是风格不是逻辑 |
| "agent 说完成了" | agent 的话是输入不是证据 |
| "用户应该已经看到了" | 用户看到 ≠ 系统行为正确 |
| "这是小事不用那么严" | 小的常常变成大的 |
| "我跑过这个测试 100 次了" | 那再跑一次也不费事 |

### 铁律 4：配对范例（correct / incorrect）

> Skill 中必须包含**具体**的正确 vs 错误范例（不能抽象描述）。

### 铁律 5：Bottom Line（一句话收口）

> 末尾用一句话总结，让 agent 在 context 截断时也能记住核心。

## 4. 5 套高价值 SKILL.md 完整设计稿

下面 5 个 skill 是我设计的**首批落地**——每个都符合规范、可直接复制使用。文件已落到本专题 `skills/` 子目录下，**你可以直接复制到 `.claude/skills/<name>/SKILL.md` 即装即用**。

### Skill #1: `verification-before-completion`

> **Port of superpowers** + 本地化（增加中文范例 + 9 岗位场景）

**触发场景**：任何 task 结束、声称"完成/修好/通过/部署"前
**核心 Iron Law**：**没有新鲜证据不声称完成**

**5 步门禁**：
1. 重新读一遍 task 原始要求
2. 对每条"声称"找对应的**具体证据**（不是推理）
3. 证据必须是**本会话内**新产生的（不能复用"之前跑过"）
4. 检查 7 类常见 claim 各需要什么证据（tests/linter/build/bug/regression/agent/requirement）
5. 输出**有证据的完成声明**或**承认未完成**

**为什么排第一**：超 powers 的同名 skill 是整个社区引用最多的"反 AI 自欺"工具。

### Skill #2: `contract-first-api`

> **全新设计**（社区空白）

**触发场景**：任何后端新接口、修改现有契约、新增 Job/Queue/Worker
**核心 Iron Law**：**接口契约与不变量未通过评审前，禁止写实现**

**5 步门禁**：
1. 枚举所有调用方（前端、其他服务、批处理、SDK）
2. 写 OpenAPI/AsyncAPI 草案（YAML）
3. 用 **invariant grammar** 提取业务不变量（"X 永远不能..."）
4. 设计幂等键 + 失败可重试
5. 跑 **pre-mortem**：5 类失败（重复请求/并发/超时/依赖不可用/越权）每类先写 1 个失败测试

**为什么排第二**：后端正确性是 9 岗位里"爆炸半径"最大的，但社区 0 skill 覆盖。

### Skill #3: `golden-set-builder`

> **全新设计**（社区空白）

**触发场景**：任何 LLM 应用新功能、Prompt 改版、检索/RAG 改动
**核心 Iron Law**：**没有 golden set 不调 Prompt**

**5 步门禁**：
1. 列出 task 分类（典型 / 边界 / 对抗 / 多轮 / 安全）
2. 每类 ≥3 个真实样本（含 input/expected/dimension/score rubric）
3. 明确**评价维度**（事实性、格式、风格、安全、成本、延迟）
4. 沉淀**失败案例库**模板
5. 把 golden set 接入 CI，**任何 Prompt 改动必须 eval 通过**

**为什么排第三**：LLM 应用正确性核心就是"可评估"，但社区没有任何 skill 强制这个流程。

### Skill #4: `blast-radius-audit`

> **全新设计**（社区空白）

**触发场景**：任何触及 deploy、schema、auth、billing、外部契约的变更
**核心 Iron Law**：**未演练过的回滚不是回滚，是赌博**

**5 步门禁**：
1. 标识**风险等级**（low / medium / high / critical）
2. 写**回滚步骤**（精确到命令）
3. **演练**回滚（影子库/staging/干跑）
4. 准备**故障检测信号**（指标/告警/用户反馈）
5. 标识**分批上线窗口**（灰度/金丝雀/全量）

**为什么排第四**：DevOps/SRE 岗位"爆炸半径"最不可控，但社区 0 skill 覆盖。

### Skill #5: `state-coverage`

> **全新设计**（社区空白）

**触发场景**：任何前端新页面/模态框/表单/列表
**核心 Iron Law**：**没有覆盖全状态的 UI 是定时炸弹**

**5 步门禁**：
1. 列**状态矩阵**（数据 × 权限 × 网络 × 异步 × 用户输入）
2. 每个 cell 配：设计稿 + 文案 + 断言 + 截图 fixture
3. 显式列举"状态分类"（loading/success/empty/error/timeout/partial/permission-denied/stale/offline/optimistic）
4. 跑 **E2E matrix**（每个 cell 一个 case）
5. 写**视觉回归**（截图 diff）

**为什么排第五**：前端"happy path only"是行业最常见问题，但社区 0 skill 强制全状态覆盖。

## 5. 5 分钟上手：让 Claude Code 加载这些 Skill

### 步骤 1：复制到项目本地

```bash
# 在你的项目根目录
mkdir -p .claude/skills
cp -r /path/to/ai-dev-methodology/skills/verification-before-completion .claude/skills/
cp -r /path/to/ai-dev-methodology/skills/contract-first-api .claude/skills/
cp -r /path/to/ai-dev-methodology/skills/golden-set-builder .claude/skills/
cp -r /path/to/ai-dev-methodology/skills/blast-radius-audit .claude/skills/
cp -r /path/to/ai-dev-methodology/skills/state-coverage .claude/skills/
```

### 步骤 2：或全局安装（个人所有项目可用）

```bash
mkdir -p ~/.claude/skills
cp -r /path/to/ai-dev-methodology/skills/* ~/.claude/skills/
```

### 步骤 3：或用 npx skills CLI（推荐）

```bash
# 等本仓库被加到 vercel-labs/skills 索引后
npx skills add <this-repo-url>
```

### 步骤 4：验证加载

在 Claude Code 中：
```
/skills
```
会列出已加载的 skills。你应该看到上面 5 个。

### 步骤 5：使用

- **自动触发**（model-invoked）：直接给 Claude 一个任务，agent 会在合适的时机自动调用相关 skill
- **手动触发**（user-invoked）：输入 `/verification-before-completion` 强制 agent 执行

## 6. 实战对比：装前 vs 装后

### 场景：让 Claude 修一个 bug

**装 skill 前**：
```
你：修一下 #1234 那个 bug
Claude：好的，我看了一下代码，应该是 X 问题，改了...
[改了文件]
Claude：✅ 已修复！
你：...真的修好了？
Claude：应该是的
你：...（叹气）
```

**装 `verification-before-completion` + `systematic-debugging`（可选）后**：
```
你：修一下 #1234 那个 bug
Claude：好的，按 verification-before-completion 我需要：
  1. 复现这个 bug（写一个失败测试）
  2. 跑测试确认它确实失败
  3. 定位根因（不靠猜）
  4. 修实现
  5. 跑测试确认它现在通过
  6. 跑回归测试
  7. 输出有证据的修复报告

[执行中...]
Claude：✅ 修复完成。证据：
  - 新增 test_bug_1234.py 第 42 行（之前是红现在是绿）
  - pytest 全绿（4/4）
  - 没有改动 test_bug_1234.py 之外的测试文件
你：👍
```

## 7. 与现有专题的协同

| 专题 | 关注点 | 与本节的关系 |
|---|---|---|
| Claude Code 源码分析 | Claude Code 内部架构 | 互补：本节告诉你**怎么用** Claude Code 的 skill 系统 |
| Hermes Agent 源码分析 | Hermes 多 agent 架构 | 互补：本节的 9 套 skill 可以在 Hermes 多 agent 场景下分发 |
| Codex CLI 源码分析 | Codex CLI 编码代理 | 互补：本节方法论适用于任何 agent（不限于 Claude） |
| 超级专题 superpowers | 项目级实施计划 | 不冲突：superpowers 是"如何用 agent 做这个项目"，本节是"如何让 agent 按方法论工作" |

## 8. 给读者的下一步

| 你想做的事 | 建议 |
|---|---|
| 先试试看 | 复制 1-2 个 skill 到 `.claude/skills/`，跑一周，看 agent 行为变化 |
| 自己写 skill | 参考 `writing-great-skills`（mattpocock）+ 我们的 5 条铁律 |
| 贡献到社区 | 把本地调通的 skill 提 PR 到我们的 `skills/` 目录 |
| 找更多 skill | `npx skills search <keyword>` 浏览 40+ agent 工具的生态 |

## 9. 参考资源

- [Anthropic Agent Skills 规范](https://agentskills.io/specification) — 规范制定者
- [anthropics/skills](https://github.com/anthropics/skills) — 规范 + 文档处理 skill 范例
- [mattpocock/skills](https://github.com/mattpocock/skills) — 工程技能精品集
- [obra/superpowers](https://github.com/obra/superpowers) — 最严格的 skill 库
- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) — React/Next.js 规则包
- [Claude Code Skills 文档](https://code.claude.com/docs/en/skills) — Claude Code 扩展

---

## 📚 系列导航

这是「AI 时代程序员方法论」专题的第四篇 — **工程实践：把方法论落地为 Agent Skills**。建议按顺序阅读：

1. ➡️ [思考手册](/docs/ai-dev-methodology/01-thinking-handbook/)：核心是驾驭生成—验证回路，理解"为什么要这么干"（先读这篇建立心智）。
2. ➡️ [9 岗位完整版](/docs/ai-dev-methodology/02-9-roles/)：把方法论展开到 9 个岗位，回答每个岗位的**核心正确性、验证信号、AI 委托边界、新护城河**。
3. ➡️ [岗位最佳实践手册](/docs/ai-dev-methodology/03-best-practices/)：把方法论落到**操作**——9 个岗位的常见问题、错误做法、最佳实践、通用场景 SOP。
4. ✅ **工程实践：把方法论落地为 Agent Skills（本文）**：把方法论三章变成 5 套可运行的 SKILL.md，补全社区在"验证方法论"层的空白。
5. ➡️ [总结：方法论→技能库 路线图](/docs/ai-dev-methodology/05-roadmap/)：从"读懂方法论"到"用上方法论"到"贡献方法论"的完整路径。