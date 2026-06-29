---
title: "38个技能+51个Agent，这套复利工程插件正在重新定义AI编程工作流"
date: 2026-06-01 18:36:05 +0800
categories: [工具, AI]
tags: [Compound Engineering, AI编程, Claude Code, 技能, Agent, 复利工程]
description: "Compound Engineering 插件深度解析：38个技能、51个专用Agent、覆盖10个AI编码平台，让每一次工程工作都让下一次更简单。"
pin: false
---


> 826次提交、10个AI编码平台全覆盖、每单位工作都让后续工作更简单——这就是 Compound Engineering。

---

你有没有过这种感觉：每次接手一个新需求，都得从头理解上下文？在 Review 完代码后，发现自己又在同一个坑里踩了一遍？花半小时修完的 Bug，两周后同事遇到同样问题，又花了半小时？

这不是个人能力问题，是知识没有"复利"。

Every.to 的工程师 Kieran Klaassen 和他的团队用一套插件解决了这个困境。他们管它叫 **Compound Engineering（复利工程）**，核心思想就一句话：**每一次工程工作，都应该让下一次更简单**。

## 🏆 成绩单

| 维度 | 数据 |
|------|------|
| 技能（Skills） | 38+ |
| 专用 Agent | 51+ |
| 支持平台 | Claude Code / Codex / Cursor / Copilot / Droid / Qwen / OpenCode / Pi / Gemini / Kiro 共 10 个 |
| 当前版本 | v3.9.3（2026年5月28日） |
| 主分支提交 | 826+ 次 |
| 总提交历史 | 2000+ 次 |
| 许可证 | MIT |
| npm 包 | @every-env/compound-plugin |

**关键发现：**
- 核心理念"复利工程"来自 Every.to 用 AI 写代码的实战经验——80% 时间做规划和审查，20% 时间执行
- 代码审查不再是"一个人看代码"，而是从 50+ 个角色 Agent 中按代码类型按需调取，**并行审查**
- 支持 **headless 模式**，技能之间可以互相调用，实现全自动串联——写完代码自动审查、自动沉淀

---

## 🤔 它到底干了什么？

简单说，**Compound Engineering 是一套给 AI 编程助手安装的"工程方法论插件"**。

它不是自动补全，也不只是"Chat + 写代码"。它把整个软件工程流程拆成了 8 个环节，每个环节都有专门的技能和 Agent 来执行：

| 序号 | 环节 | 技能 | 做什么 |
|------|------|------|--------|
| 0 | 定策略 | `/ce-strategy` | 上游锚定，生成 STRATEGY.md——定义产品要解决什么问题、目标用户是谁、怎么衡量成败 |
| 1 | 创意发散 | `/ce-ideate` | 生成和批判性评估多个创意方向，选最靠谱的进入脑暴 |
| 2 | 需求脑暴 | `/ce-brainstorm` | 交互式 Q&A，把"我想加个注册功能"变成带需求追踪 ID 的结构化文档 |
| 3 | 实现计划 | `/ce-plan` | 把需求文档转化成可执行的实现计划，带 U-ID 追溯、自动置信度检测 |
| 4 | 写代码 | `/ce-work` | 自动创建 Git Worktree、拆解任务、按依赖关系并行调度子 Agent 写代码 |
| 5 | 修 Bug | `/ce-debug` | 系统性重现问题、追踪因果链、形成可证伪假设、测试先行修复 |
| 6 | 代码审查 | `/ce-code-review` | 按代码类型激活对应角色的 Agent，并行审查、去重、置信度过滤 |
| 7 | 知识沉淀 | `/ce-compound` | 把刚解决的问题写成可检索的知识文档，放进 docs/solutions/ |
| 闭环 | 成果追迹 | `/ce-product-pulse` | 生成时间窗口内的产品脉搏报告——用户实际体验了什么，产品表现如何 |

安装就一句：在 Claude Code 里 `/plugin marketplace add EveryInc/compound-engineering-plugin`，然后 `/plugin install compound-engineering`。接着跑 `/ce-setup`，它会自动检测你的开发环境，装好缺失的工具，初始化项目配置。

---

## 🏗️ 架构怎么设计的？

这个项目的架构本身就值得细看。

### 技能编排 + Agent 执行双层模型

**技能（Skill）** 是用户入口，通过斜杠命令触发。它只负责"编排"——决定调度哪些 Agent、按什么顺序、怎么合并输出。

**Agent** 是真正干活的最小单元。每个 Agent 只有一个职责，有自己的角色定义、判例标准和输出格式。

以 `/ce-code-review` 为例，一次完整的审查调度是这样的：

```
ce-code-review（编排层）：
  ├── Stage 1: 确定 diff 范围和 pr 元数据
  ├── Stage 2: 理解代码意图
  ├── Stage 3: 从 50+ agent 中按需选择审查角色：
  │   ├── 必选（永远激活）：
  │   │   ├── ce-correctness-reviewer     逻辑错误/边界情况
  │   │   ├── ce-testing-reviewer          测试覆盖/弱断言
  │   │   ├── ce-maintainability-reviewer   代码结构/耦合度
  │   │   ├── ce-project-standards-reviewer 规范合规
  │   │   ├── ce-agent-native-reviewer     Agent 可访问性
  │   │   └── ce-learnings-researcher      搜索历史方案
  │   ├── 按需激活（根据 diff 内容）：
  │   │   ├── ce-security-reviewer        （碰到 auth/permission 时）
  │   │   ├── ce-performance-reviewer      （碰到 DB 查询/缓存时）
  │   │   ├── ce-api-contract-reviewer     （碰到路由/serializer 时）
  │   │   ├── ce-data-migration-reviewer   （碰到 migration 文件时）
  │   │   ├── ce-reliability-reviewer      （碰到错误处理/重试时）
  │   │   ├── ce-adversarial-reviewer      （diff > 50 行时）
  │   │   ├── ce-swift-ios-reviewer        （碰到 Swift 文件时）
  │   │   └── ce-julik-frontend-races-reviewer （碰到异步 UI 时）
  │   └── Stage 4: 并行调度所有选中 Agent
  ├── Stage 5: 合并 JSON 结果 + 去重 + 置信度门控 + 交叉验证
  ├── Stage 5b (可选): 验证器 Agent 独立复核每条发现
  └── Stage 6: 合成结构化审查报告
```

这个并行调度的设计意味着：一次审查，你能同时得到安全性、性能、可维护性、测试覆盖率等多个维度的专业意见，而不是一个人轮流看完。

### 四种运行模式适配不同场景

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| **Interactive** | 逐条确认发现，可走查/自动修复/创建 Issue | 日常开发 |
| **Autofix** | 无交互，自动应用安全修复，输出残余工作报告 | CI 流水线/Pipeline |
| **Report-only** | 纯只读，不修改任何文件 | 并行质量检查，可与其他操作并发 |
| **Headless** | 程序化模式，供其他技能调用 | 技能间自动串联 |

Headless 模式是点睛之笔。它让技能之间可以互相调用：`/ce-work` 写完代码 → 自动触发 `/ce-code-review mode:headless` → 审查完自动触发 `/ce-compound mode:headless`。整个流程从头到尾不需要人工干预。

---

## 🧪 实战场景

### 场景一：从零到 PR

一个典型的功能开发全流程：

```text
/ce-strategy "我们的目标用户是独立开发者，要做笔记分享功能"
                                    # 生成 STRATEGY.md，后续所有技能自动读取

/ce-brainstorm "给笔记加协作编辑功能"
                                    # Agent 通过 Q&A 把模糊需求变成结构化文档
                                    # 产出: docs/brainstorms/collab-edit-requirements.md
                                    # 带 R-ID 需求追踪，支持 HTML/Markdown 双格式

/ce-plan docs/brainstorms/collab-edit-requirements.md
                                    # 产出: docs/plans/collab-edit-plan.md
                                    # 带 U-ID 实现单元，自动检测置信度不足的环节

/ce-work                             # 读取 plan，自动创建 worktree
                                    # 拆任务、按依赖并行调度 Agent 写代码
                                    # 每个 Agent 在自己的隔离 worktree 里工作
                                    # 合并→测试→commit→循环

/ce-code-review                      # 自动选择审查角色，并行审查
                                    # safe_auto 修复自动应用
                                    # 生成结构化报告

/ce-compound                         # 沉淀这次的经验到 docs/solutions/
                                    # 下次类似情况，Agent 自动搜索这个知识库
```

整个过程，开发者只用在关键决策点做选择，其余由 Agent 编排完成。

### 场景二：Bug 调试

```text
/ce-debug "支付回调偶发重复扣款"
  → Agent 搜索相关 session 历史，找到之前的调查记录
  → 用防御性分层方式重现问题环境
  → 形成可验证假设，写测试确认
  → 实现修复，验证通过
  → 自动 commit + push + 创建 PR
  → 建议 /ce-compound 沉淀
```

### 场景三：知识复利循环

这是整个系统最精妙的部分。每次 `/ce-compound` 会在 `docs/solutions/` 下生成一篇带 YAML 前言的结构化方案文档：

```
docs/solutions/
├── performance-issues/
│   ├── n-plus-one-brief-generation.md
│   └── redis-connection-pool-exhaustion.md
├── database-issues/
│   ├── deadlock-on-payment-retry.md
│   └── migration-lock-timeout-on-large-table.md
├── runtime-errors/
│   └── stripe-webhook-signature-verification.md
├── architecture-patterns/
│   ├── agent-execution-patterns.md
│   └── shared-workspace-architecture.md
└── workflow-issues/
    └── release-please-version-drift-recovery.md
```

每个文档包含：问题症状、调查过程（哪些方案失败了、为什么）、根因分析、修复方案、预防策略、交叉引用。

**复利的关键**：Agent 在执行任务前会先搜索 `docs/solutions/`。同一个坑被填平后，所有后续的 Agent 都不会再掉进去。这是真正的团队知识复利——不依赖人传人，而是 Agent 传 Agent。

### 场景四：PR 反馈处理

```text
/ce-resolve-pr-feedback
  → 自动拉取 PR 的所有 review comments
  → 按反馈聚类，检测系统性问题
  → 并行处理每个反馈线程
  → 逐条回复或修复
```

团队不用手动跟踪谁的 PR 上还有未处理的 review 意见，一个命令搞定。

---

## 🎯 谁该用？怎么选？

| 场景 | 推荐方案 |
|------|----------|
| 个人开发者，想要结构化工作流 | `/ce-brainstorm` → `/ce-plan` → `/ce-work` 铁三角 |
| 团队想统一代码质量标准 | `/ce-code-review`（多人审查维度）+ `/ce-compound`（知识不流失） |
| CI/CD 自动巡检 | `/ce-code-review mode:autofix` + `/ce-simplify-code` |
| 产品经理想追踪开发节奏 | `/ce-strategy`（策略锚定）+ `/ce-product-pulse`（成果脉冲） |
| 全栈 Web 项目 | `/ce-polish-beta`（前端审查）+ `/ce-test-browser`（浏览器测试）+ `/ce-dogfood-beta`（diff 驱动 QA） |
| 开源维护者 | `/ce-resolve-pr-feedback` 自动处理 PR 反馈，告别手动 follow-up |
| iOS 开发 | `/ce-test-xcode` 模拟器测试 + `ce-swift-ios-reviewer` Swift 专项审查 |
| AI Agent 开发者 | `ce-agent-native-architecture` 全套 Agent 最佳实践参考 |

---

## 总结

Compound Engineering 解决了一个越用越痛的矛盾：**AI 编程工具的能力在指数级增长，但工程流程的碎片化程度也在同步加剧**。

它的答案是一套精心设计的"技能编排 + 角色 Agent"双层级体系。把"想清楚 → 做出来 → 审查好 → 沉淀住"这个朴素而有效的工程循环，固化为 AI 编程助手的原生能力。51 个 Agent 像一支不知疲倦的虚拟团队，精确到每个细分领域的审查职责。

826 次提交、10 平台兼容、MIT 开源——作者 Kieran Klaassen（Every.to 联合创始人）把它当自己的主力工具天天在迭代，更新频率极高（仅 5 月就有 10+ 个版本）。"Compound Engineering"这个名字不是营销话术——作者就在用这套工具 build 这套工具本身。

如果你已经在用 AI 写代码，但觉得每次开始一个新任务都要"重新告诉 AI 上下文"，那么这套插件可能就是你需要的那块拼图。

---

**项目地址**：https://github.com/EveryInc/compound-engineering-plugin

**作者**：Kieran Klaassen（Every.to）

**许可证**：MIT

---

*觉得有用？点赞转发让更多人看到 💪*
