---
title: "Step 13: Agent 与多 Agent 系统"
layout: documentation
project_id: claude-code-source
permalink: /docs/claude-code/13-agent-system/
---


> 分析日期: 2026-04-16
> 核心文件: AgentTool.tsx(1,397行), coordinatorMode.ts(370行), Task.ts(126行), tasks/ 目录

---

## 1. Agent 生命周期图

```
AgentTool.call(input)
    |
    v
[1. 验证] 检查权限规则、过滤拒绝的 Agent
    |
    v
[2. 模式选择]
    |-- 同步模式: 当前 REPL 进程内执行
    |-- 异步模式 (run_in_background): 启动后台任务
    |-- 子 Agent 模式: 通过 AgentTool 生成独立进程
    |
    v
[3. 生成]
    |-- isBackgroundTasksDisabled 检查
    |-- ForkSubagent feature 开关检查
    |-- 选择后端:
    |     |-- InProcess: 同进程内
    |     |-- Tmux: 新 tmux 窗口
    |     |-- ITerm2: 新 iTerm2 标签
    |
    v
[4. 执行] runAgent() / runSubagent()
    |-- 构建工具集 (可能精简)
    |-- 构建系统提示
    |-- 设置权限上下文
    |-- 运行查询循环
    |
    v
[5. 通信] (swarm 模式)
    |-- SendMessageTool 发送消息
    |-- Mailbox 接收消息
    |-- inbox 轮询
    |
    v
[6. 完成]
    |-- status: 'completed' (同步)
    |-- status: 'async_launched' (异步, 返回 agentId)
```

---

## 2. 任务类型层次

```
Task (base, 126 行)
    |
    +-- LocalAgentTask       本地 Agent 任务 (进程内)
    +-- InProcessTeammateTask 进程内队友任务 (swarm)
    +-- RemoteAgentTask       远程 Agent 任务 (SSH/DirectConnect)
    +-- DreamTask             Dream 任务 (推测执行)
    +-- ShellTask             Shell 后台任务
    +-- TmuxTask              Tmux 后端任务
    +-- ITermTask             iTerm2 后端任务
```

### 任务状态转换

```
pending -> in_progress -> completed
                    |-> failed
                    |-> cancelled
```

---

## 3. 后端架构

### InProcess 后端

| 特性 | 详情 |
|------|------|
| **隔离** | 无 — 共享进程、共享 AppState |
| **通信** | 直接函数调用 + Mailbox |
| **权限** | 继承父 REPL 权限上下文 |
| **适用** | 轻量子任务、队友 Agent |

### Tmux 后端

| 特性 | 详情 |
|------|------|
| **隔离** | 新 tmux 窗口 (独立终端) |
| **通信** | 文件系统 + UDS 套接字 |
| **权限** | 子进程自有权限模式 |
| **适用** | 需要终端隔离的后台 Agent |

### ITerm2 后端

| 特性 | 详情 |
|------|------|
| **隔离** | 新 iTerm2 标签 |
| **通信** | 文件系统 + UDS 套接字 |
| **权限** | 子进程自有权限模式 |
| **适用** | macOS iTerm2 用户 |

---

## 4. Swarm 模式权限委托

```
Team Lead (主 REPL)
    |
    |-- TeamCreateTool -> 创建团队 + 指定 team lead
    |
    v
Worker Agent (队友)
    |
    1. Worker 遇到需要权限的工具
    2. useCanUseTool -> handleSwarmWorkerPermission()
    3. 通过 Mailbox 向 Team Lead 发送权限请求
    4. useSwarmPermissionPoller 轮询响应
    5. Team Lead 用户在 UI 中审批
    6. 响应通过 Mailbox 返回 Worker
```

**权限回调注册**:
- `registerPermissionCallback(toolUseId, callback)` — 模块级 Map 存储
- `pollForResponse(toolUseId)` — 非阻塞检查
- `removeWorkerResponse(toolUseId)` — 响应后清理
- `clearAllPendingCallbacks()` — /clear 和测试隔离用逃生舱

---

## 5. Coordinator 模式

**文件**: `src/coordinator/coordinatorMode.ts` (370 行)

Coordinator 模式是一种多 Agent 协同模式，其中一个 Agent 充当协调者，将任务委派给多个子 Agent。

**关键特性**:
- 系统提示中指定 coordinator 角色和允许的工具
- coordinator 不能直接执行文件操作，只能委派
- 权限通过 `handleCoordinatorPermission` 处理
- 与 `COORDINATOR_MODE` feature 开关门控

**允许的 Coordinator 工具** (受限集):
- Agent (生成子 Agent)
- SendMessage (通信)
- TaskUpdate (任务状态更新)
- Read/Grep/Glob (只读信息收集)

---

## 6. Agent 生成流程 (从 AgentTool.call())

```
AgentTool.call(input)
    |
    v
1. 验证 Agent 定义
    |-- 检查 permissionRules 中的 deny 规则
    |-- 过滤不允许的 Agent 类型
    |
    v
2. 确定执行模式
    |-- input.run_in_background && !isBackgroundTasksDisabled -> 异步
    |-- 否则 -> 同步
    |
    v
3. 构建工具集
    |-- assembleToolPool() (可能精简版本)
    |-- 过滤子 Agent 不应访问的工具
    |
    v
4. 构建系统提示
    |-- 包含任务描述
    |-- 包含权限模式信息
    |-- 可能包含精简版 claude.md
    |
    v
5. 选择后端
    |-- InProcessBackend (默认, 同步)
    |-- TmuxBackend (后台, tmux 可用)
    |-- ITermBackend (后台, iTerm2 可用)
    |
    v
6. 执行
    |-- 同步: runAgent() -> 返回 completed
    |-- 异步: startBackgroundTask() -> 返回 async_launched + agentId
    |
    v
7. 结果收集
    |-- 同步: 直接返回结果
    |-- 异步: 通过 TaskOutputTool 读取输出
```

---

## 7. 关键观察

1. **三种后端提供不同隔离级别**: InProcess (无隔离)、Tmux (终端隔离)、ITerm2 (标签隔离)。选择取决于用户环境和任务需求。

2. **权限委托链**: Worker -> Mailbox -> Team Lead -> UI 用户 -> Mailbox -> Worker。这是完全异步的，轮询间隔 1 秒。

3. **Coordinator 作为受限 Agent**: coordinator 角色限制可用工具，强制通过委派而非直接操作来完成任务。

4. **Feature 开关门控**: `FORK_SUBAGENT` 门控后台 Agent、`COORDINATOR_MODE` 门控协调器、`isAgentSwarmsEnabled()` 门控团队创建。