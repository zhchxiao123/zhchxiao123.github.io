---
name: contract-first-api
description: 接口契约与不变量未通过评审前，禁止写实现。在任何后端新接口、修改现有契约、新增 Job/Queue/Worker 时强制要求：先写 OpenAPI/AsyncAPI + 提取业务不变量 + 设计幂等键 + 跑 pre-mortem 失败测试。本 skill 补全社区在后端"契约优先"层的空白。
---

# contract-first-api

## Iron Law

> **接口契约与不变量未通过评审前，禁止写实现。**
>
> 实现的诱惑永远强于契约的耐心。先写代码 = 把不确定性固化进生产环境。

## 何时使用

任何后端接口相关的"开始"动作，**必须**触发：

- 新增 HTTP API 端点（GET/POST/PUT/DELETE）
- 修改现有 API 契约（路径、参数、响应、错误码）
- 新增 Job / Queue / Worker 任务
- 新增 RPC / WebSocket / gRPC 接口
- 新增 SDK 公开方法
- 修改数据库 schema 对外暴露的部分

## 5 步门禁

按顺序执行，**任何一步失败都不能写实现代码**：

### Step 1: 枚举所有调用方
- 前端（哪个页面/组件）
- 其他后端服务（哪个 service）
- 批处理 / 定时任务
- 外部 SDK / 公开 API
- 测试代码本身
- 任何未来的调用方（在 README/设计文档中声明）

**目的**：明确"谁依赖这个契约"。未列出的调用方出现时，说明契约有缺失。

### Step 2: 写 OpenAPI / AsyncAPI 草案
- 路径、方法、入参（带类型 + 必填/可选）、出参（带类型 + 示例）
- 错误码（4xx/5xx 全列，每个有语义）
- 鉴权要求（哪类 token、哪个 scope）
- 限流策略（每秒/每分钟、per user/per IP/per tenant）
- 超时（server 端、client 端建议值）

**输出格式**：YAML 文件，提交到 `api/<service>/<version>.yaml`

### Step 3: 用 invariant grammar 提取业务不变量

> **不变量（invariant）= "X 永远不能 Y" 的硬规则**。

模板（每个不变量写 1 行）：
```yaml
- id: INV-001
  statement: "同一用户在同一分钟内不能重复提交同一订单"
  enforcement: "unique index on (user_id, order_id, minute_bucket)"
  violation_handling: "返回 409 + 重复订单的 id"
- id: INV-002
  statement: "..."
```

**最少 3 个不变量**。少于 3 个说明你还没想清楚。

### Step 4: 设计幂等键 + 失败可重试
- 幂等键格式（通常：业务 id + 客户端生成的 request id）
- 幂等键有效期（建议 24h）
- 重复请求的处理：返回上次的响应（**不要重新执行业务逻辑**）
- 失败的"可重试 vs 不可重试"分类：
  - 可重试：网络超时、5xx、依赖不可用
  - 不可重试：参数错误、4xx、权限

### Step 5: 跑 Pre-mortem 失败测试

> **Pre-mortem = 在写实现前先想象 5 类失败，每类先写 1 个失败测试**。

5 类必写：
1. **重复请求**：同一幂等键发 2 次，结果一致 + 只副作用 1 次
2. **并发**：100 个并发请求同一资源，最终状态正确
3. **超时**：依赖方 30s 不返回，调用方正确降级
4. **依赖不可用**：下游服务 down，本服务不雪崩
5. **越权**：用户 A 用自己的 token 访问用户 B 的资源，返回 403

**所有 5 个测试必须先红后绿**（先失败，再因实现而绿，不是先写实现再补测试）。

## 7 列常见失败模式

| 失败模式 | 表现 | 后果 |
|---|---|---|
| **写完代码补契约** | 实现优先，契约是后补的 | 契约反映实现而非业务 |
| **不变量模糊** | "重复请求应该不重复扣款" | "应该" 不可执行 |
| **幂等键过期** | 24h 后重复请求重新执行 | 副作用 2 次 |
| **pre-mortem 走过场** | "应该不会有问题" | 故障模式没被测试覆盖 |
| **错误码语义混乱** | 都返回 200 + msg | 客户端无法程序化处理 |
| **不变量被实现破坏** | 实现偷偷绕过了 invariant | 静默 bug |
| **未枚举的调用方** | "前端用我们的方式调" | 实际调用方按自己的方式用 |

## 6 Red Flags

🚩 你（agent）想直接写 `def create_user(...)`
🚩 你看了一下"差不多就行"
🚩 你跳过 pre-mortem 因为"不复杂"
🚩 你的不变量列表少于 3 条
🚩 你写了测试但测试只是 `assert True`
🚩 你的幂等键用时间戳但没考虑时钟漂移
🚩 你的错误码只有 200 和 500

## 6 Rationalizations

| 借口 | 反驳 |
|---|---|
| "先写实现快一点" | 重构契约的成本 >> 重构实现的成本 |
| "不变量太理论" | 每一个生产事故都源自一个没被写下来的不变量 |
| "幂等以后再说" | 幂等是设计选择，不是补丁 |
| "pre-mortem 浪费时间" | 5 个失败测试 < 1 次线上事故 |
| "前端会处理的" | 前后端契约错配 = 协作灾难 |
| "我们没有外部调用方" | 内部调用方更复杂（散落在 10 个服务里） |

## 配对范例

### ❌ 不对的"先写实现"

```python
# 1. agent 直接写实现
@app.post("/users")
def create_user(user: User):
    db.insert(user)
    return user

# 2. 之后补契约
# yaml: ...（事后写，反映实现）
# 3. 没写失败测试
# 4. 重复请求会创建重复用户
```

### ✅ 正确的"契约优先"

```yaml
# 1. 先写 OpenAPI
paths:
  /users:
    post:
      parameters: [...]
      responses:
        '201': {...}
        '409': {description: "用户已存在"}

# 2. 提取不变量
- INV-001: "email 必须全局唯一"
- INV-002: "同一 request_id 不能创建 2 个用户"  
- INV-003: "删除用户必须保留审计记录 7 年"

# 3. 5 个 pre-mortem 测试
def test_duplicate_request_returns_same_user(): ...
def test_concurrent_creation_one_wins(): ...
def test_downstream_timeout_degrades_gracefully(): ...
def test_email_service_down_rejects_creation(): ...
def test_user_cannot_create_with_other_user_token(): ...

# 4. 等 5 个测试都红了，才写实现
# 5. 5 个测试都绿了，commit
```

## Bottom Line

**契约是设计，实现是施工。施工可以返工，设计的债务会随每次部署积累。**