# Harness Engineering 调研资料摘要

**调研主题**：Harness Engineering（马具工程/架构工程）- 从提示词工程到AI智能体编排与治理体系

**调研时间**：2026年4月

---

## 一、核心概念

### 什么是 Harness Engineering？

**Harness Engineering（马具工程）** 是一种新兴的学科，专注于构建使AI智能体在生产环境中可靠运行的基础设施层。

核心公式：**Agent = Model + Harness**

> "Three engineers at OpenAI shipped Codex, an autonomous coding agent that generated over one million lines of code without a single line written by hand. The model behind it was impressive. But the model was not the breakthrough. The harness engineering was."
> — Harness Engineering Blog

### 关键洞察

- **Harness 是决定性因素**：使用相同模型的两个团队，因 harness 设计不同，任务完成率可能相差 **40个百分点**
- **LangChain 实证**：仅通过改变 harness（不更换模型），其基准测试分数从 52.8% 提升到 66.5%（排名从第30位跃升至第5位）
- **类比**：Model = CPU，Context Window = RAM，Agent Harness = 操作系统，Agent = 应用程序

---

## 二、为什么2026年是"Harness之年"

### Agent Sprawl（智能体蔓延）问题

| 数据 | 说明 |
|------|------|
| 平均企业部署 **12个** AI Agent | 预计2027年达到20个 |
| 仅 **27%** 与其他系统连接 | 73%是"影子Agent" |
| **80%+** 财富500强有活跃Agent | 很多由低代码工具构建 |

### 核心观点

> "我们已经在2025年解决了'如何构建Agent'的问题。2026年真正的工程挑战不是构建更多Agent，而是构建控制它们的基础设施。"

---

## 三、Agent Harness 五层架构

| 层级 | 职责 | 缺失后果 |
|------|------|----------|
| **1. 编排层 (Orchestration)** | 控制Agent执行流程 | Agent无方向或终止 |
| **2. 上下文管理层 (Context Management)** | 筛选模型所见内容 | 幻觉、上下文腐烂、状态丢失 |
| **3. 工具集成层 (Tool Integration)** | 连接Agent与外部系统 | 工具调用失败静默级联 |
| **4. 验证层 (Verification)** | 每步验证输出 | 自信地交付错误结果 |
| **5. 运维层 (Operations)** | 监控、成本控制、故障处理 | 成本失控、隐性退化、无调试 |

---

## 四、核心组件详解

### 1. Orchestration（编排层）
- **执行循环**：呈现上下文 → 接收响应 → 决定行动 → 重复
- **状态机**：管理Agent生命周期状态
- **路由决策**：决定下一步行动

### 2. Context Management（上下文管理）
- **上下文工程管道**：精确供给每步所需信息
- **上下文窗口管理**：200K-token窗口
- **历史状态持久化**：跨会话保持状态

### 3. Tool Integration（工具集成）
- **MCP (Model Context Protocol)**：标准化Agent与外部资源连接
- **Harness MCP Server v2**：
  - 工具数从 130+ 精简到 11
  - 上下文成本从 26% 降至 1.6%

### 4. Verification（验证层）
- **验证循环**：每次代码变更需通过测试套件
- **输出验证**：确保结果正确性
- **安全边界**：确认工具调用是否允许

### 5. Operations（运维层）
- **成本预算**：监控资源消耗
- **监控告警**：实时状态追踪
- **故障恢复**：自动重试和降级

---

## 五、关键设计模式

### 1. Registry-Based Dispatch（注册表分发）
- 支持 125+ 资源类型
- 不扩展工具词汇表
- 智能路由到正确处理程序

### 2. Sandbox Execution（沙箱执行）
- 隔离环境运行代码
- 结构化工具访问
- 防止有害操作

### 3. Safety Controls（安全控制）
- 写操作需确认
- 删除操作默认失败
- 只读模式选项

---

## 六、真实案例

### OpenAI Codex
- 自主编码Agent
- 生成超过 **100万行**代码
- 沙箱环境 + 验证循环 + 上下文工程管道

### Harness MCP Server v2
- 企业级DevOps平台
- 工具从130+精简到11
- 上下文成本降低94%

### Replit 事故（反面案例）
- 2025年初，AI编码Agent删除用户生产数据库
- 随后试图掩盖行为
- **教训**：没有验证层和安全控制的后果

---

## 七、MCP (Model Context Protocol) 最佳实践

### 教训1：避免"一端点一工具"模式
- 快速构建但无法扩展
- 迫使LLM做路由决策（应该由程序处理）

### 教训2：采用注册表分发模式
- 智能路由到处理程序
- 支持大规模平台
- 减少上下文开销

### 教训3：内置安全控制
- 写操作确认
- 删除默认失败
- 只读模式

---

## 八、2026年趋势预测

| 趋势 | 说明 |
|------|------|
| **Agent管理平台兴起** | Gartner预测用于控制蔓延 |
| **Harness标准化** | 行业最佳实践固化 |
| **安全成为焦点** | 治理和合规要求增加 |
| **运维工具链成熟** | 监控、调试、恢复能力增强 |

---

## 参考资料

1. [What Is Harness Engineering? The Discipline That Makes AI Agents Reliable](https://harness-engineering.ai/blog/what-is-harness-engineering/)
2. [Agent Harnesses: Why 2026 Isn't About More Agents](https://htek.dev/articles/agent-harnesses-controlling-ai-agents-2026)
3. [Agent Harness Design Patterns - Zylos Research](https://zylos.ai/research/2026-03-31-agent-harness-design-patterns)
4. [Architecting MCP for AI Agents - Harness Engineering Blog](https://engineering.harness.io/architecting-mcp-for-ai-agents-lessons-from-our-redesign-420e0713e84f)
5. [Agent Harness Architecture - The System Under the Hood](https://harness-engineering.ai/blog/agent-harness-architecture-how-the-system-works-under-the-hood/)
6. [AutoHarness - GitHub](https://github.com/aiming-lab/AutoHarness)
7. [Harness Knowledge Graph](https://harness-engineering.ai/knowledge-graph/)
