---
name: blast-radius-audit
description: 未演练过的回滚不是回滚，是赌博。在任何触及 deploy、schema、auth、billing、外部契约的变更时强制要求：标识风险等级 + 写回滚步骤 + 演练回滚 + 准备检测信号 + 标识分批上线窗口。本 skill 补全社区在 DevOps/SRE"爆炸半径控制"层的空白。
---

# blast-radius-audit

## Iron Law

> **未演练过的回滚不是回滚，是赌博。**
>
> 出事故时，你没有时间第一次回滚。回滚必须像呼吸一样——已经做过 100 次。

## 何时使用

任何 DevOps / SRE 相关的"变更"动作，**必须**触发：

- 部署代码到任何环境（dev/staging/prod）
- 修改数据库 schema（ALTER TABLE / 索引 / 迁移）
- 修改 auth/权限（OAuth scope、RBAC 角色、API key）
- 修改 billing/计费逻辑（费率、计费周期、发票）
- 修改外部契约（API、SDK、webhook、回调）
- 修改基础设施（Terraform、Helm、k8s manifest）
- 启用/禁用 feature flag
- 升级依赖（库版本、镜像 tag、运行时）
- 任何 long-running 进程的重启

**不触发**：纯文档变更、注释、测试代码、CI 配置（这些走 PR review，不走 blast-radius-audit）。

## 5 步门禁

按顺序执行，**任何一步失败都不能上线**：

### Step 1: 标识风险等级

> **风险等级 = 错误时的影响范围 × 检测难度 × 恢复时间**。

| 等级 | 定义 | 例子 | 必须做什么 |
|---|---|---|---|
| **critical** | 影响 > 50% 用户 / 涉及钱 / 不可逆 | 计费改错、auth bypass、删库 | 完整 5 步 + 高管审批 + 灰度 24h+ |
| **high** | 影响 10-50% 用户 / 降级但不数据丢失 | 慢查询、新接口 bug | 5 步 + 灰度 4h+ |
| **medium** | 影响 < 10% 用户 / 易回滚 | 内部工具 bug、文档错 | 3 步（无需演练） |
| **low** | 影响 < 1% 用户 / 自动恢复 | 监控告警、日志调整 | 1 步（PR review 即可） |

**自评 high 或 critical = 触发完整 5 步**。

### Step 2: 写回滚步骤（精确到命令）

模板：
```bash
# blast-radius: high
# rollback-tested: 2026-07-02
# rollback-owner: @sre-oncall

# 1. 暂停流量（5s 内）
kubectl scale deploy/api --replicas=0

# 2. 回滚到上一个稳定版本（30s 内）
kubectl rollout undo deploy/api --to-revision=123

# 3. 验证回滚（30s 内）
curl -f https://api.example.com/health
# 期望: {"status": "ok", "version": "v1.2.3-pre"}

# 4. 恢复流量（5s 内）
kubectl scale deploy/api --replicas=10

# 5. 通知（30s 内）
# Slack: #incidents
# Page: on-call if rollback > 5min
```

**关键**：
- 步骤**必须**精确到具体命令
- 每步给**预期时长**
- 总回滚时间 = 各步时长之和（建议 critical < 5min，high < 15min）

### Step 3: 演练回滚（影子库 / staging / 干跑）

**critical/high 必做，medium 可选**：

- 影子库演练：用 prod 流量副本，回滚一遍看是否真的恢复
- staging 演练：在 staging 环境跑完整回滚流程
- 干跑（dry run）：用 `--dry-run` 标志（k8s/terragrunt 都支持）

**演练记录**：
```yaml
- date: 2026-07-02
  rollup_id: deploy-api-v1.2.4
  drill_type: staging
  drill_result: success
  duration: 3m42s
  issues_found:
    - "kubectl rollout undo 失败，因为 revision 不存在"
  fixes:
    - "改用 git tag 引用版本"
  dry_run_passed: true
```

**演练发现的问题必须修**，不能"演练失败但仍然上线"。

### Step 4: 准备故障检测信号

> **回滚快不如检测快**。

必准备的信号：

- **核心指标**：P95 延迟、错误率、QPS
- **业务指标**：订单成功率、登录成功率、支付成功率
- **告警阈值**：触发自动回滚 / 自动告警的阈值
- **检测时长**：从故障发生到告警 < 5min（critical）

模板：
```yaml
- signal: api_p95_latency
  baseline: 200ms
  alert_threshold: 500ms  # 持续 5min
  auto_rollback: true
  owner: @sre-oncall
- signal: error_rate
  baseline: 0.1%
  alert_threshold: 1%  # 持续 3min
  auto_rollback: true
  owner: @sre-oncall
```

**所有阈值都是可执行的**（不是"我觉得有问题"）。

### Step 5: 标识分批上线窗口

| 等级 | 上线策略 | 观察时长 |
|---|---|---|
| critical | 1% → 5% → 25% → 100%（每步观察 6h+） | 24h+ |
| high | 10% → 50% → 100%（每步观察 1h+） | 4h+ |
| medium | 50% → 100%（观察 30min+） | 2h |
| low | 直接 100% | 30min |

**每步必须可逆**（不靠回滚，靠流量切换）：
- K8s：调整 `replicas` 或 service selector
- Feature flag：调整百分比
- LB：调整后端权重

**回滚时长 = 单次回滚命令耗时 + 检测时长**。建议 critical < 5min，high < 15min。

## 7 列常见失败模式

| 失败模式 | 表现 | 后果 |
|---|---|---|
| **"我试过回滚"** | 上线前没演练 | 真实回滚时命令不对 |
| **回滚时间估错** | "5 分钟就回滚" | 实际 30 分钟，期间用户被影响 |
| **检测不到** | "我部署完没人报错" | 静默故障持续数小时 |
| **回滚脚本没人测试** | 写的命令 copy 自上次 | 路径不对、镜像不存在 |
| **告警阈值不合理** | 设到不可能触发的值 | 故障时无告警 |
| **回滚需要人审批** | "经理说要审批" | 5min 审批 > 30min 故障 |
| **流量切换忘了监控** | 切换完没看 QPS | 流量没切过去以为是 bug |

## 6 Red Flags

🚩 你（agent）想直接 `kubectl apply -f prod.yaml`
🚩 你说"这次改动很小不需要演练"
🚩 你的回滚步骤是"手动改回去"
🚩 你的告警阈值没设
🚩 你的灰度策略是"先 10% 看看"
🚩 你没算回滚总时长
🚩 你部署完没看监控

## 6 Rationalizations

| 借口 | 反驳 |
|---|---|
| "我们回滚很快的" | 你没演练过，不知道真回滚多快 |
| "出事故再说" | 事故时你找不回滚命令 |
| "监控肯定能发现" | 没演练告警阈值，不知道会不会响 |
| "100% 直接上" | 一次 100% 故障 = 全量用户受影响 |
| "我已经做 100 次了" | 那演练 1 次也花不了多少时间 |
| "小改动不用那么严" | 所有大事故开始都是"小改动" |

## 配对范例

### ❌ 不对的"直接上线"

```
你: 部署一下
Claude: 好的
$ kubectl apply -f prod.yaml
deployment.apps/api configured
Claude: ✅ 部署完成
你: ...有没有回滚？
Claude: 出问题再回滚
```

### ✅ 正确的"blast-radius-audit"

```yaml
# 1. 风险等级: high (修改了 API 路径)
# 2. 回滚步骤:
#    kubectl rollout undo deploy/api --to-revision=123 (30s)
#    curl health check (10s)
#    总回滚时长: 40s
# 3. 演练记录:
#    - date: 2026-07-02
#    - drill_type: staging
#    - result: success, 38s
# 4. 告警阈值:
#    - api_p95_latency > 500ms 持续 3min → 自动回滚
#    - error_rate > 1% 持续 2min → 告警 + 人工决策
# 5. 灰度策略:
#    - 10% (1h) → 50% (2h) → 100%
#    - 每次切换有 auto-rollback 保护

# 然后才:
$ kubectl apply -f prod.yaml
# 等 10% 1h, 看监控, 50%, 100%
```

## Bottom Line

**上线是一个承诺，回滚是一个习惯。** 承诺要审，习惯要练。