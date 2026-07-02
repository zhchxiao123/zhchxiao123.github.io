---
name: state-coverage
description: 没有覆盖全状态的 UI 是定时炸弹。在任何前端新页面/模态框/表单/列表开发时强制要求：列状态矩阵 + 每 cell 配设计 + 文案 + 断言 + 截图 fixture + 跑 E2E matrix + 视觉回归。本 skill 补全社区在前端"全状态覆盖"层的空白。
---

# state-coverage

## Iron Law

> **没有覆盖全状态的 UI 是定时炸弹。**
>
> happy path 永远只覆盖 20% 真实场景。剩下 80%（loading/empty/error/permission-denied/...）出问题就是客诉。

## 何时使用

任何前端 UI 相关的"开始"动作，**必须**触发：

- 新增页面、模态框、抽屉
- 新增表单、列表、表格
- 新增任何"用户能看见的"组件
- 改造已有页面的核心交互
- 接入新接口（即使只改一个调用）
- 改错误处理逻辑
- 改 loading 状态

**不触发**：纯样式调整、文案修改、纯图标库替换。

## 5 步门禁

按顺序执行，**任何一步失败都不能 commit**：

### Step 1: 列状态矩阵

> **状态 = 数据状态 × 权限状态 × 网络状态 × 异步状态 × 用户输入**。

5 个维度交叉展开成矩阵：

| 维度 | 可能值 |
|---|---|
| **数据** | 有数据、空数据、加载中、部分数据（分页/无限滚动）、数据过期 |
| **权限** | 所有者、被授权、只读、无权限、未登录 |
| **网络** | 在线、离线、慢网络、API 失败、超时 |
| **异步** | 进行中、成功、失败、可重试、不可重试 |
| **用户输入** | 合法、非法（验证失败）、边界（最小/最大）、冲突 |

**全状态覆盖意味着**：每个 cell 至少 1 个 E2E case。

### Step 2: 每个 cell 配：设计 + 文案 + 断言 + 截图

每个 cell 必填：

```yaml
- state: empty + online + owner
  design: "[Figma URL 或截图 fixture 路径]"
  copy: "还没有任何内容，点击新建"
  assertion: "shows empty illustration, shows CTA button"
  screenshot_fixture: "tests/fixtures/empty.png"
- state: loading + online + owner
  design: "[Figma URL]"
  copy: "加载中..."
  assertion: "shows skeleton, hides content"
  screenshot_fixture: "tests/fixtures/loading.png"
- state: error + offline + owner
  design: "[Figma URL]"
  copy: "网络连接失败，请检查后重试"
  assertion: "shows offline icon, shows retry button, hides content"
  screenshot_fixture: "tests/fixtures/offline.png"
```

**关键**：每个 cell 的文案和设计**必须显式写**——不能"fallback 到默认"。

### Step 3: 显式枚举"状态分类"

> **状态分类 = 任何前端 UI 必须覆盖的最小集合**。

| 分类 | 触发场景 | 必备 UI 元素 |
|---|---|---|
| **loading** | 数据请求中 | 骨架屏/spinner |
| **success** | 数据成功 | 实际内容 |
| **empty** | 无数据 | 空状态插图 + CTA |
| **error** | 业务错误 | 错误提示 + 重试按钮 |
| **timeout** | 超时 | 错误提示 + 取消按钮 |
| **partial** | 部分数据 | 已加载 + 加载更多 |
| **permission-denied** | 无权限 | 权限申请引导 |
| **stale** | 数据过期 | 重新加载按钮 |
| **offline** | 离线 | 离线提示 + 重试 |
| **optimistic** | 乐观更新 | 立即响应 + 失败回滚 |

**任何一个 cell 走"fallback 到 success 状态" = 隐藏 bug**。

### Step 4: 跑 E2E matrix

```javascript
// cypress/e2e/state-matrix.spec.js
describe('Order list state matrix', () => {
  // 数据维度
  it('shows empty state when no orders', () => { ... })
  it('shows loading state while fetching', () => { ... })
  it('shows partial state during pagination', () => { ... })
  it('shows stale state after 24h', () => { ... })

  // 权限维度
  it('shows permission-denied for non-owner', () => { ... })

  // 网络维度
  it('shows offline state when no network', () => { ... })
  it('shows error state on 500', () => { ... })
  it('shows timeout state after 30s', () => { ... })

  // 用户输入维度
  it('shows validation error on invalid form', () => { ... })
  it('shows conflict state on duplicate submit', { ... })
})
```

**每个 cell 一个 case**。少于 10 个 case = 状态矩阵不完整。

### Step 5: 写视觉回归（截图 diff）

```javascript
// playwright.config.ts + visual regression
// 每个状态有 baseline 截图，PR 改动后自动对比
test('order list empty state matches design', async ({ page }) => {
  await page.goto('/orders')
  await expect(page).toHaveScreenshot('empty.png', { maxDiffPixels: 100 })
})
```

**没有视觉回归 = 任何像素改动都不会被捕获**。

## 7 列常见失败模式

| 失败模式 | 表现 | 后果 |
|---|---|---|
| **只测 happy path** | "成功的我能跑通" | 80% 场景是 error/empty/loading |
| **fallback 到默认** | "出错就显示空" | 用户看到的是无意义的"空" |
| **loading 卡死** | spinner 一直转 | 用户不知道在干嘛 |
| **错误信息模糊** | "请求失败" | 用户不知道该怎么办 |
| **离线无提示** | 直接显示旧数据 | 用户不知道数据可能过期 |
| **权限错误不引导** | 403 直接弹错 | 用户不知道申请权限 |
| **无视觉回归** | 改一行 CSS 漏测 | 整个页面布局错乱没人发现 |

## 6 Red Flags

🚩 你（agent）写完 happy path 就 commit
🚩 你的状态矩阵少于 10 个 cell
🚩 你的 E2E 只有 "test login" 一个 case
🚩 你的"loading 状态" = "请求完之前什么都不显示"
🚩 你的错误提示 = `alert('错误')`
🚩 你的离线状态 = "网络失败就当没数据"
🚩 你没跑过截图 diff

## 6 Rationalizations

| 借口 | 反驳 |
|---|---|
| "UI 简单不需要状态矩阵" | 简单 UI 也有 5+ 状态（loading/success/empty/error/timeout） |
| "loading 直接转圈就行" | spinner 卡死是经典 bug |
| "错误信息差不多就行" | 用户看到 "请求失败" 不知道下一步 |
| "离线太极端了" | 地铁、电梯、飞机模式到处都是 |
| "视觉回归成本高" | 不做视觉回归，CSS 一改就崩 |
| "happy path 通过就够了" | 用户活在 80% 非 happy path 里 |

## 配对范例

### ❌ 不对的"只测 happy path"

```jsx
// 只写成功状态的 UI
function OrderList({ orders }) {
  return (
    <div>
      {orders.map(o => <OrderCard order={o} />)}
    </div>
  )
}
// 测试只有一个 case
it('shows orders', () => { ... })
// 用户看到：loading 卡死 / error 时空白 / 离线时假数据
```

### ✅ 正确的"全状态覆盖"

```jsx
function OrderList({ orders, status, error }) {
  return (
    <>
      {status === 'loading' && <Skeleton />}
      {status === 'error' && <ErrorState onRetry={refetch} />}
      {status === 'empty' && <EmptyState onCreate={openCreateModal} />}
      {status === 'success' && orders.map(o => <OrderCard order={o} />)}
      {!navigator.onLine && <OfflineBanner />}
    </>
  )
}

// 12 个 E2E case 覆盖全矩阵
// 视觉回归 baseline 12 张截图
// 任何 UI 改动都被测试和 diff 捕获
```

## Bottom Line

**UI 的"看起来对"和"真的对"差 10 个状态。** 没覆盖全状态的用户体验 = 一半用户在另一半体验里抱怨。