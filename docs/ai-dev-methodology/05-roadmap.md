---
title: "总结：方法论 → 技能库 路线图"
layout: documentation
project_id: ai-dev-methodology
permalink: /docs/ai-dev-methodology/05-roadmap/
description: "从'读懂方法论'到'用上方法论'到'贡献方法论'的完整路径：方法论与技能库的对应关系、5 阶段落地路线图、社区参与指南、与现有专题的协同。"
---

> 副标题：方法论的价值不在被读懂，而在被使用。本章给出从认知到落地的完整路径。

## 0. 这一章解决什么问题

至此整个专题已经有 5 篇：

| # | 章节 | 状态 |
|---|---|---|
| 01 | 思考手册（为什么） | ✅ 已完成 |
| 02 | 9 岗位完整版（做什么） | ✅ 已完成 |
| 03 | 岗位最佳实践手册（怎么做） | ✅ 已完成 |
| 04 | 工程实践：把方法论落地为 Agent Skills | ✅ 已完成 |
| 05 | **总结：方法论→技能库 路线图**（本文） | 🆕 |

前 3 篇是**方法论**（写给人看的），第 4 篇是**工程制品**（agent 真的会用的）。

第 5 章回答 3 个问题：
1. **方法论和技能库怎么对应？**——把"读"和"用"打通
2. **如何分阶段落地？**——避免一次性全上导致混乱
3. **如何与社区互动？**——让别人也能用上、也能贡献

## 1. 方法论 vs 技能库：完整对应表

把前 4 篇的核心概念**逐条映射**到可执行的 Skill：

### 1.1 通用方法论 → 跨岗位 Skill

| 方法论概念 | 对应 Skill | 类型 |
|---|---|---|
| 驾驭生成—验证回路（思考手册 §0） | `verification-before-completion` | 已实现 ✅ |
| 锚点必须在生成之前（最佳实践 §3.2） | `verification-before-completion` + `test-driven-development` | 已实现 ✅ |
| 三轮不收敛就停（最佳实践 §3.6） | `three-strikes-stop`（待写） | 占位 |
| 验证强度（思考手册 §0） | `verification-before-completion` | 已实现 ✅ |

### 1.2 9 岗位方法论 → 9 套岗位 Skill

| 岗位 | 方法论核心 | 对应 Skill | 状态 |
|---|---|---|---|
| **需求工程师** | 模糊愿望 → 验收用例 | `acceptance-criteria-authoring` | 计划中 |
| **前端工程师** | 状态完整 + 体验可验 | `state-coverage` | **已实现 ✅** |
| **后端工程师** | 契约/一致性/边界 | `contract-first-api` | **已实现 ✅** |
| **测试工程师** | 高杀伤力验证信号 | `mutation-killer-curve` | 计划中 |
| **DevOps / SRE** | 可观测/可恢复/可回滚 | `blast-radius-audit` | **已实现 ✅** |
| **数据工程师** | 口径一致/可对账 | `metric-contract` | 计划中 |
| **AI/LLM 应用** | 效果可评估 | `golden-set-builder` | **已实现 ✅** |
| **安全工程师** | 攻击面/权限边界 | `threat-model-mini` | 计划中 |
| **架构师** | 长期取舍/不可逆决策 | `three-statement-architect` | 计划中 |

### 1.3 完整方法论 → 技能库总览

```
方法论（5 篇 2187 行）                技能库（计划 14 套）
──────────────────────────             ──────────────────────
思考手册（哲学）        ───────→        通用：verification-before-completion ✅
                                         通用：three-strikes-stop ⏳
9 岗位（核心）          ───────→        9 套岗位 Skill（5 ✅ + 4 ⏳）
最佳实践（SOP）         ───────→        每个 SOP 段可演化为 1 个 skill
工程实践（落地）        ───────→        skill 的安装、使用、CI 集成
路线图（本文）          ───────→        总览 + 优先级 + 协作
```

**当前完成度**：5/14 (36%)。本节第 2 部分给出补齐剩余 9 套的具体路径。

## 2. 5 阶段落地路线图

> **不要一次性全上**。分阶段、按风险、按反馈速度逐步推广。

### Phase 1: 工具化个人（1-2 周）
**目标**：把 5 套已实现的 Skill 装到自己日常开发中

| 步骤 | 时间 | 验证信号 |
|---|---|---|
| 复制 5 套 skill 到 `~/.claude/skills/` | 5 分钟 | `/skills` 能列出 5 个 |
| 跑一个真实任务：修一个 bug | 1 天 | `verification-before-completion` 触发并产出有证据的修复报告 |
| 跑一个真实任务：加一个 API | 2 天 | `contract-first-api` 强制先写 OpenAPI |
| 跑一个真实任务：加一个 UI 页面 | 2 天 | `state-coverage` 强制列状态矩阵 |
| 跑一个真实任务：调一个 LLM 功能 | 2 天 | `golden-set-builder` 强制建评测集 |
| 跑一个真实任务：一次部署 | 1 天 | `blast-radius-audit` 强制写回滚步骤 |
| 跑完后回顾：哪些 skill 真的有用？哪些是噪音？ | 1 天 | 留下 ≥3 套，删掉 ≤2 套 |

**Phase 1 成功标志**：
- 至少 3 套 skill 在 1 周内被真实任务触发
- 至少 1 次因为 skill 强制而避免了事故

### Phase 2: 团队分享（1-2 周）
**目标**：让 2-3 个同事开始用 Skill

| 步骤 | 时间 | 验证信号 |
|---|---|---|
| 选 1 套最有感的 skill 做内部分享 | 1 天 | ≥3 人开始用 |
| 收集团队反馈：哪些 skill 太严？哪些太松？ | 3 天 | ≥5 条具体反馈 |
| 调整 skill 描述和 Iron Law 的语气 | 2 天 | 重新发版 |
| 把 skill 复制到团队共享目录 | 1 天 | 团队 git repo 里有 `.claude/skills/` |
| 跑过 2 个跨人任务：1 个 bug 修复 + 1 个新功能 | 1 周 | 团队在 PR review 中提到 skill |

**Phase 2 成功标志**：
- 团队里有 ≥3 人在用
- 团队工作流（PR 模板、立项模板）开始引用 skill

### Phase 3: 流程化（1-2 月）
**目标**：把 Skill 嵌入团队流程

| 步骤 | 时间 | 验证信号 |
|---|---|---|
| PR 模板增加"已用 skill" checklist | 1 周 | PR 中 ≥50% 提到用了哪个 skill |
| CI 增加 skill 验证（lint SKILL.md） | 1 周 | CI 自动校验 skill 规范 |
| 立项目录里加 `.claude/skills/`（项目级 skill） | 2 周 | 每个新项目默认带 5 套基础 skill |
| 培训：新成员入职必读 + 必装 | 持续 | 文档化 |

**Phase 3 成功标志**：
- 新成员入职第一天就能用上
- 项目 review 时"忘了用 skill"是 review 必问

### Phase 4: 定制化（持续）
**目标**：补齐剩余 9 套 Skill + 写出本项目专属的 Skill

| 剩余 Skill | 优先级 | 建议来源 |
|---|---|---|
| `acceptance-criteria-authoring` | P0 | 参考 mattpocock `to-prd` + 我们方法论 §2.3 |
| `metric-contract` | P0 | 我们方法论 §7 独有，无现成参考 |
| `threat-model-mini` | P1 | 参考 OWASP + 简化为 5 步 |
| `mutation-killer-curve` | P1 | 集成 mutation testing 工具 |
| `three-statement-architect` | P1 | 参考 superpowers `writing-plans` + 我们方法论 §13 |
| `three-strikes-stop` | P2 | 我们方法论独有，参考 superpowers `verification-before-completion` 风格 |

**Phase 4 成功标志**：
- 14 套核心 skill 全部就位
- 每个 skill 至少有 1 个真实项目使用记录

### Phase 5: 社区化（持续）
**目标**：把 Skill 库贡献给社区

| 步骤 | 时间 | 验证信号 |
|---|---|---|
| 整理 README + 贡献指南 | 1 周 | 外部人能在 30 分钟内贡献 |
| 发布到 vercel-labs/skills 索引 | 1 周 | `npx skills add` 可以装 |
| 写 PR 到 anthropics/skills | 2 周 | 至少 1 套被合并 |
| 持续迭代：社区反馈 | 持续 | 月度发版 |

**Phase 5 成功标志**：
- 外部贡献者 ≥3 人
- 月下载/使用量 > 1000

## 3. 写 Skill 的方法论

如果你想自己写 skill，遵循我们的 5 条铁律 + superpowers 的 `writing-skills` 元 skill：

### 3.1 写之前的反向问题

> **"如果不写这个 skill，agent 一定会犯什么错？"**

如果答不上来——这个 skill 不值得写。

### 3.2 必含的 5 个结构

1. **Iron Law**（一句话压顶）
2. **何时使用**（具体触发场景）
3. **5 步门禁**（强制流程）
4. **失败模式 + Red Flags + Rationalizations**（防御性）
5. **配对范例 + Bottom Line**（具体 + 收口）

### 3.3 自检清单

写完一个 skill，用这个清单自检：

- [ ] 文件名 = `name:` 字段 = 目录名（一致性）
- [ ] `description` 第一句就能让 agent 知道"什么时候该用我"
- [ ] Iron Law 让人**不敢忽视**
- [ ] 5 步门禁里**每步都可执行**（不是"考虑"）
- [ ] 失败模式 + Red Flags + Rationalizations 总共 ≥15 条
- [ ] 配对范例有具体可对比的 ❌ 和 ✅
- [ ] Bottom Line 一句话能复述核心

### 3.4 写之后的测试

> **没有失败案例的 skill 是不完整的。**

每个 skill 应该：
- 找到 1 个"agent 没有这个 skill 时会犯的真实错误"
- 跑一遍 agent，确认它真的犯这个错
- 加 skill 后再跑一遍，确认它不再犯
- 把这两个 transcript 放到 `references/test-transcripts.md`

## 4. 与现有专题的协同

| 专题 | 关注点 | 与本专题的关系 |
|---|---|---|
| **Claude Code 源码分析** | Claude Code 内部架构 | 本专题用 Claude Code 作为 skill 运行环境；Claude Code 专题告诉你 skill 系统怎么实现 |
| **Hermes Agent 源码分析** | Hermes 多 agent 架构 | 多 agent 场景下，本专题的 9 套 skill 可以分发到不同 agent |
| **Codex CLI 源码分析** | Codex CLI 编码代理 | Codex CLI 也支持 Agent Skills，本专题方法论可移植 |
| **AI Lab 实验室** | 在线 chat 实验 | 实验台可以挂载本专题的 skill 演示 |
| **docs/superpowers/plans/** | 实施计划（如 AI Lab 重构） | 实施计划可以引用本专题的 skill 作为方法论锚点 |

**协同方式**：
- 在 `docs/claude-code/` 专题加一篇 "Claude Code 的 Skills 系统"——介绍 Claude Code 怎么消费 skill
- 在 `labs/ai-lab.html` 加一个 "skill 选择器" UI——可视化展示本专题的 5 套 skill
- 在 `docs/superpowers/plans/` 的实施计划里引用本专题的 skill 作为标准实践

## 5. 给读者的行动建议

### 如果你是**个人开发者**
- **今天**：复制 1 套 skill（建议 `verification-before-completion`）到 `~/.claude/skills/`，跑 1 个真实任务
- **本周**：复制 3 套，**所有**任务都用
- **本月**：在 5 套全部上跑过的基础上，写出**你自己**的第 1 套 skill

### 如果你是**Tech Lead**
- **本周**：组织一次 30 分钟的 skill 内部分享
- **本月**：把 5 套 skill 复制到团队项目的 `.claude/skills/`
- **下月**：补齐剩余 4 套最关键的 skill

### 如果你是**平台 / 工具作者**
- 本专题的 5 套 skill 是**真实使用过的、可以拿来评估你的 agent 的基准测试**
- 任何支持 Agent Skills 规范的 agent 应该能直接消费这 5 套
- 如果发现兼容性问题，欢迎提 issue

## 6. 一句话收口

> **方法论读 100 遍不如用 1 遍。Skill 装 10 个不如用熟 1 个。**

---

## 📚 系列导航

这是「AI 时代程序员方法论」专题的第五篇（也是终篇）— **总结：方法论→技能库 路线图**。

完整专题（建议按顺序阅读）：

1. ➡️ [思考手册](/docs/ai-dev-methodology/01-thinking-handbook/)：核心是驾驭生成—验证回路，理解"为什么要这么干"。
2. ➡️ [9 岗位完整版](/docs/ai-dev-methodology/02-9-roles/)：把方法论展开到 9 个岗位，回答每个岗位的**核心正确性、验证信号、AI 委托边界、新护城河**。
3. ➡️ [岗位最佳实践手册](/docs/ai-dev-methodology/03-best-practices/)：把方法论落到**操作**——9 个岗位的常见问题、错误做法、最佳实践、通用场景 SOP。
4. ➡️ [工程实践：把方法论落地为 Agent Skills](/docs/ai-dev-methodology/04-agent-skills/)：把方法论三章变成 5 套可运行的 SKILL.md，补全社区在"验证方法论"层的空白。
5. ✅ **总结：方法论→技能库 路线图（本文）**：从"读懂方法论"到"用上方法论"到"贡献方法论"的完整路径。

---

## 附录：可立即使用的 5 套 Skill

所有 5 套 SKILL.md 都在本仓库 `docs/ai-dev-methodology/skills/` 下，可直接复制到 `.claude/skills/<name>/SKILL.md` 使用：

| Skill | 大小 | 适用场景 |
|---|---|---|
| `verification-before-completion` | 4.8 KB | 任何 task 收尾 |
| `contract-first-api` | 6.0 KB | 后端新接口/契约 |
| `golden-set-builder` | 6.2 KB | LLM 应用/调 Prompt |
| `blast-radius-audit` | 7.2 KB | 部署/schema/auth/billing |
| `state-coverage` | 7.1 KB | 前端新页面/表单/列表 |

**复制命令**：
```bash
# 项目级（推荐）
mkdir -p .claude/skills
cp -r docs/ai-dev-methodology/skills/* .claude/skills/

# 或全局（个人所有项目）
mkdir -p ~/.claude/skills
cp -r docs/ai-dev-methodology/skills/* ~/.claude/skills/
```