---
name: golden-set-builder
description: 没有 golden set 不调 Prompt。在任何 LLM 应用新功能、Prompt 改版、检索/RAG 改动、Agent 流程调整时强制要求：先建任务分类 + 真实样本 + 评价维度 + 失败案例库模板 + 接入 CI 评测。本 skill 补全社区在 LLM 应用"可评估性"层的空白。
---

# golden-set-builder

## Iron Law

> **没有 golden set 不调 Prompt。**
>
> 凭感觉调 Prompt = 凭感觉治疗病人。golden set 是 LLM 应用的"X 光片"，没有它你看不到在治什么。

## 何时使用

任何 LLM 应用相关动作，**必须**触发：

- 新增 LLM 功能（无论 RAG / Agent / 分类 / 提取 / 生成）
- 修改现有 Prompt（即使只改 1 个词）
- 调整检索（chunk size、embedding 模型、rerank）
- 调整 Agent 工具集或工具描述
- 切换底层模型（GPT-5 → Claude Opus、4 → 4.5）
- 添加新的 few-shot 范例
- 调整 temperature / top_p / max_tokens

## 5 步门禁

按顺序执行，**任何一步失败都不能调 Prompt**：

### Step 1: 列出 task 分类

把任务空间切分成**5 类**（缺一不可）：

| 类别 | 定义 | 最少样本数 |
|---|---|---|
| **典型** | 用户最常问的 80% | 10 |
| **边界** | 输入格式、长度、语言的极端 | 5 |
| **对抗** | 故意刁难、注入、攻击 | 5 |
| **多轮** | 上下文依赖、状态漂移 | 3 |
| **安全** | 幻觉、越权、敏感信息 | 3 |

**少于上面任何一个 = 评估集不完整**。

### Step 2: 每类 ≥3 个真实样本

每个样本的结构：

```yaml
- id: GS-001
  category: typical
  input: |
    [真实的用户输入，不要 PII]
  expected: |
    [期望的输出，可以是参考答案、JSON 模板、关键字段]
  dimension:
    - factuality: [事实是否正确]
    - format: [格式是否合规]
    - style: [语气/品牌是否一致]
    - safety: [是否触发安全规则]
  score_rubric: |
    5分: 完美，输出与 expected 等价
    3分: 主要正确，有小瑕疵
    1分: 主要错误，需要返工
    0分: 幻觉/越权/严重错误
```

**input 必须是真实样本**，不能是"假装用户"。可以从生产环境抽样 100 条，挑有代表性的。

### Step 3: 明确评价维度

**最小 5 个维度**：

1. **事实性**（factuality）：输出事实是否正确
2. **格式**（format）：输出格式是否合规（JSON 结构、字段完整性）
3. **风格**（style）：语气/品牌/语言风格是否一致
4. **安全**（safety）：是否触发越权、敏感信息、幻觉
5. **成本**（cost）：token 消耗是否在预算内
6. **延迟**（latency）：响应时间是否在 SLO 内

**所有维度都要能量化**（数字 / 0-5 分 / pass-fail）。

### Step 4: 沉淀失败案例库模板

```yaml
- id: FAIL-001
  date: 2026-07-02
  input: |
    [失败的输入]
  output: |
    [实际输出]
  failure_mode: hallucination
  root_cause: "检索的 chunk 不包含答案，但模型硬猜"
  fix: "调整 prompt 强制说'我不知道'"
  added_to_golden: true
```

**每次生产事故** = 1 个新失败案例 + 加入 golden set。这样 golden set 是"活的"。

### Step 5: 把 golden set 接入 CI

```yaml
# 关键：任何 Prompt 改动必须跑 eval
# .github/workflows/llm-eval.yml
on:
  pull_request:
    paths: ['prompts/**', '**/*prompt*']
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - name: Run golden set eval
        run: python scripts/eval_runner.py --golden golden_set.yaml
      - name: Check pass rate ≥ baseline
        run: python scripts/eval_gate.py --min-pass-rate 0.85
```

**没有跑 eval = 不能合并**。Pass rate 不能低于上一次的 baseline（建议设置上限告警）。

## 7 列常见失败模式

| 失败模式 | 表现 | 后果 |
|---|---|---|
| **样本全是典型** | 只有 10 条 happy path | 真实场景全是边界和对抗，盲区 |
| **expected 是手写** | "期望输出"是 agent 编的 | golden set 不准，评分失真 |
| **维度模糊** | "质量要好" | 不可量化 = 不可评估 |
| **失败案例不沉淀** | 出错就修好继续走 | 同一个坑踩 100 次 |
| **CI 慢** | eval 跑 30 分钟 | 工程师不跑就 commit |
| **baseline 没设** | 不知道"好"是什么 | 改动无方向 |
| **真实样本混入 PII** | 抽样生产数据没脱敏 | 合规风险 |

## 6 Red Flags

🚩 你（agent）想直接改 Prompt
🚩 你看了一下"输出挺好的"
🚩 你的 golden set 少于 26 条（5 类 × 5 最小值）
🚩 你的 expected 是 agent 自己写的
🚩 你的评价维度少于 5 个
🚩 你的失败案例库是空的
🚩 你的 eval 不在 CI 里

## 6 Rationalizations

| 借口 | 反驳 |
|---|---|
| "先改改看效果" | 没 golden set 你根本不知道效果 |
| "golden set 太花时间" | 不建 golden set 的时间会在生产事故中 10 倍奉还 |
| "几个典型 case 就够了" | 真实生产数据 80% 不在你的典型里 |
| "我人工评审就行" | 人审 = 不可复现、不可规模化 |
| "成本太高" | 26 条样本的成本 ≈ 1 小时工程师时间 |
| "我们没有 LLM" | 你有 Agent、Copilot、Code review AI，都是 LLM |

## 配对范例

### ❌ 不对的"调 Prompt"

```
你: 把这个 Prompt 改一下，让它输出更友好
Claude: 好的，我加了一句"请用友好的语气"
Claude: ✅ 改好了
你: ...怎么确认更好了？
Claude: 我试了几个例子看着不错
```

### ✅ 正确的"建 golden set"

```yaml
# 1. 先建 26+ 样本的 golden set
# golden_set.yaml（26+ 条）

# 2. baseline 跑一遍
$ python scripts/eval_runner.py --golden golden_set.yaml
Baseline: factuality=0.92, format=1.0, style=0.85, safety=0.95

# 3. 改 Prompt
$ vim prompts/greeting.py  # 加了"请用友好语气"

# 4. 再跑 eval
$ python scripts/eval_runner.py --golden golden_set.yaml
After: factuality=0.92, format=1.0, style=0.94, safety=0.95
↑ style 提升了 0.09，其他维度没掉

# 5. CI gate 通过，commit
$ git commit -m "improve greeting tone (style: 0.85 → 0.94)"
```

## Bottom Line

**LLM 应用的"质量"不是一个感觉，是一个数字。** 没有数字，你就在凭运气调 agent。