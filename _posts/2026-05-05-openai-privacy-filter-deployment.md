---
title: OpenAI Privacy Filter 本地部署实测：772MB量化模型，8类隐私一键脱敏，公众人物自动跳过
date: 2026-05-05 23:15:00 +0800
description: OpenAI 开源的隐私过滤模型 Privacy Filter 本地部署全攻略：ONNX 量化模型仅 772MB，CPU 也能跑，支持中英文 8 类 PII 识别，上下文感知精准区分公众人物与私人个体。含 18 项全面测试结果。
tags:
  - 隐私保护
  - OpenAI
  - PII
  - 开源
  - NER
  - ONNX
  - 本地部署
---

## 一、这东西是干啥的？

2026 年 4 月底，OpenAI 悄悄在 HuggingFace 上丢了个新玩具——**Privacy Filter**，Apache 2.0 开源，专门用来识别并脱敏文本中的个人身份信息（PII）。

跟传统正则匹配方案不一样的地方在于：**它能理解上下文**。比如 "Barack Obama" 不会被标记为隐私，但 "John Smith" 会——因为它知道前者是公众人物，后者是普通私人个体。

我第一时间在本地 Mac 上部署跑了一轮，下面把完整过程记录下来。

---

## 二、模型架构速览

Privacy Filter 本质是一个**基于 Transformer 的 NER（命名实体识别）模型**，用 BIOES 标注体系对文本中的隐私实体进行 token 级别分类。

| 维度 | 详情 |
|------|------|
| 架构 | Transformer（8层，hidden=640，14头注意力） |
| 词表大小 | 200,064 |
| 标注体系 | BIOES（Begin/Inside/End/Single/Outside） |
| 识别类型 | 8 类隐私实体 |
| 上下文长度 | 128K tokens（实际 NER 用得着这么长吗…） |
| 开源协议 | Apache 2.0 |

### 8 类隐私标签

| 标签 | 说明 | 示例 |
|------|------|------|
| `private_person` | 私人姓名 | John Smith、张三 |
| `private_address` | 私人地址 | 123 Main Street、北京市朝阳区 |
| `private_email` | 私人邮箱 | john@email.com |
| `private_phone` | 私人电话 | 555-123-4567、13800138000 |
| `private_url` | 私人 URL | john-smith.blogspot.com |
| `private_date` | 私人日期 | 生日、纪念日 |
| `account_number` | 账号信息 | 银行卡号、信用卡号 |
| `secret` | 密钥/密码 | API Key、数据库密码 |

---

## 三、本地部署：772MB 量化版，CPU 直接跑

### 3.1 模型选择

HuggingFace 仓库提供了多个 ONNX 版本：

| 版本 | 大小 | 精度 |
|------|------|------|
| `model.onnx` | 5.3 GB | FP32 全精度 |
| `model_fp16.onnx` | 2.6 GB | FP16 半精度 |
| `model_q4.onnx` | 875 MB | INT4 量化 |
| **`model_q4f16.onnx`** | **772 MB** | **INT4 + FP16 混合** |
| `model_quantized.onnx` | 1.5 GB | 通用量化 |

毫不犹豫选 `model_q4f16`，772MB，Mac CPU 上推理完全够用。加上 tokenizer（27MB）和配置文件，总共不到 800MB。

### 3.2 下载模型

由于 HuggingFace 直连不稳定，用镜像站下载：

```bash
HF_ENDPOINT=https://hf-mirror.com hf download openai/privacy-filter \
  onnx/model_q4f16.onnx \
  onnx/model_q4f16.onnx_data \
  tokenizer.json \
  tokenizer_config.json \
  config.json \
  viterbi_calibration.json \
  --local-dir ./model
```

### 3.3 推理代码

依赖只有一个：`onnxruntime` + `tokenizers`。

```bash
pip install onnxruntime tokenizers
```

核心推理逻辑：

```python
import os, json
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# ============ 路径配置 ============
MODEL_DIR = os.path.join(os.path.dirname(__file__), "model")
ONNX_PATH = os.path.join(MODEL_DIR, "onnx/model_q4f16.onnx")
TOKENIZER_PATH = os.path.join(MODEL_DIR, "tokenizer.json")
CONFIG_PATH = os.path.join(MODEL_DIR, "config.json")

# ============ 加载 ============
tokenizer = Tokenizer.from_file(TOKENIZER_PATH)
with open(CONFIG_PATH) as f:
    id2label = json.load(f)["id2label"]
session = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])

# ============ 推理 ============
def predict(text: str) -> list[dict]:
    """对输入文本进行隐私实体识别"""
    encoding = tokenizer.encode(text)
    input_ids = np.array([encoding.ids], dtype=np.int64)
    attention_mask = np.array([encoding.attention_mask], dtype=np.int64)
    outputs = session.run(None, {
        "input_ids": input_ids,
        "attention_mask": attention_mask
    })
    logits = outputs[0]  # shape: (1, seq_len, num_labels)
    predictions = np.argmax(logits, axis=-1)[0]

    # 解析 BIOES 标签
    tokens = encoding.tokens
    entities = []
    current_entity = None

    for i, (token, pred_id) in enumerate(zip(tokens, predictions)):
        label = id2label.get(str(pred_id), "O")
        if label == "O":
            if current_entity:
                current_entity["end"] = i
                entities.append(current_entity)
                current_entity = None
            continue

        bio_tag, entity_type = label.split("-", 1)
        if bio_tag == "B" or bio_tag == "S":
            if current_entity:
                current_entity["end"] = i
                entities.append(current_entity)
            current_entity = {
                "type": entity_type,
                "start": i,
                "end": i + 1,
                "tokens": [token],
            }
        elif bio_tag == "I" or bio_tag == "E":
            if current_entity and current_entity["type"] == entity_type:
                current_entity["tokens"].append(token)
                current_entity["end"] = i + 1

    if current_entity:
        current_entity["end"] = len(tokens)
        entities.append(current_entity)

    # 还原文本片段
    for ent in entities:
        ent["text"] = tokenizer.decode(
            encoding.ids[ent["start"] : ent["end"]]
        )
    return entities
```

完整 Demo 脚本见文末。

---

## 四、全面测试：18 个用例，29 个实体

我设计了 18 个测试用例覆盖各种场景，以下是完整结果。

### 4.1 基础英文个人信息 ✅

```
原文: My name is John Smith, I live at 123 Main Street, San Francisco.
      You can reach me at john.smith@email.com or call me at 555-123-4567.

检测: 👤 John Smith | 📍 123 Main Street, San Francisco |
       📧 john.smith@email.com | 📱 555-123-4567
脱敏: My name is[PRIVATE_PERSON], I live at [PRIVATE_ADDRESS]...
```

**4/4 全部命中。**

### 4.2 公众人物上下文感知 🔥

这是 Privacy Filter 最亮眼的能力。

```
原文: Barack Obama visited the White House yesterday. His email is public.
结果: ✅ 未检测到隐私信息！

原文: Elon Musk tweeted about Tesla from his office in Austin, Texas.
结果: ✅ 未检测到隐私信息！
```

**Obama 和 Elon Musk 都被正确跳过。** 模型知道他们是公众人物。

更狠的是混合场景：

```
原文: Barack Obama and my neighbor John Smith both attended
      the event at 456 Oak Avenue.

检测: 👤 John Smith | 📍 456 Oak Avenue
脱敏: Barack Obama and my neighbor[PRIVATE_PERSON] both attended
      the event at [PRIVATE_ADDRESS].
```

**同一句话里，Obama 跳过，John Smith 标记。** 上下文感知精准到这种程度，正则方案根本做不到。

### 4.3 中文支持 ✅

```
原文: 请将包裹寄到北京市朝阳区建国路88号，收件人张三，电话13800138000。
检测: 📍 北京市朝阳区建国路88号 | 📱 13800138000
注: 中文姓名"张三"未识别（中文人名是难点，情有可原）

原文: 我的名字是李四，邮箱是 lisi@example.com，家住上海市浦东新区张江路100号。
检测: 👤 李四 | 📧 lisi@example.com | 📍 上海市浦东新区张江路100号
```

中文地址、电话、邮箱识别稳定。中文人名偶有遗漏，但整体可用。

### 4.4 密钥/密码识别 ✅

```
原文: API key is sk-abc123def456, and the database password is SuperSecret123!
检测: 🔑 sk-abc123def456 | 🔑 SuperSecret123!

原文: AWS access key: AKIAIOSFODNN7EXAMPLE,
      secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
检测: 🔑 wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

API Key、密码、AWS Secret 都能识别。不过 AWS Access Key ID（`AKIAIOSFODNN7EXAMPLE`）没被识别，这个可能因为格式太像普通字符串。

### 4.5 代码片段中的隐私 ✅

```
原文: const apiKey = 'ghp_abc123def456';
      const user = { name: 'Tom Wilson', email: 'tom@company.com' };
检测: 🔑 ghp_abc123def456 | 👤 Tom Wilson | 📧 tom@company.com
脱敏: const apiKey = '[SECRET]';
      const user = { name: '[PRIVATE_PERSON]', email: '[PRIVATE_EMAIL]' };
```

**GitHub Token、代码中的硬编码姓名和邮箱，全识别。** 这对代码审查场景非常实用。

### 4.6 公开 URL vs 私人 URL ✅

```
原文: Check out my personal blog at https://john-smith.blogspot.com
      and my LinkedIn at https://linkedin.com/in/johnsmith
检测: 🔗 john-smith.blogspot.com | 🔗 linkedin.com/in/johnsmith

原文: The documentation is available at https://docs.python.org
      and https://github.com/openai
结果: ✅ 未检测到隐私信息！
```

私人博客和 LinkedIn 被标记，docs.python.org 和 github.com/openai 被跳过。URL 级别的上下文感知同样生效。

### 4.7 复杂客服对话 ✅

```
原文: Hi, my name is Sarah Jones, my account number is
      4111-1111-1111-1111. I need to change my address from
      789 Pine Street, Boston to 321 Elm Street, Chicago.
      My email is sarah.j@personal.com.

检测: 👤 Sarah Jones | 💳 4111-1111-1111-1111 |
       📍 789 Pine Street, Boston | 📍 321 Elm Street, Chicago |
       📧 sarah.j@personal.com
```

**5/5 全中。** 一句话里混合了姓名、银行卡、两个地址、邮箱，全部精准识别。

### 4.8 日期识别 ✅

```
原文: My date of birth is January 15, 1985
      and the meeting is on 2024-12-25.
检测: 📅 January 15, 1985 | 📅 2024-12-25
```

注意：**两个日期都被标记了**，包括会议日期。日期类的上下文感知似乎不如姓名类精准——模型可能倾向于把所有日期都当隐私。

### 4.9 纯公开信息 ✅

```
原文: The Eiffel Tower is located in Paris, France.
      The tour costs 25 euros.
结果: ✅ 未检测到隐私信息！
```

埃菲尔铁塔、巴黎——公开地标和城市，正确跳过。

---

## 五、测试总结

| 测试类别 | 用例数 | 结果 |
|----------|--------|------|
| 基础英文 PII | 1 | ✅ 4/4 |
| 公众人物跳过 | 3 | ✅ Obama/Elon 正确跳过 |
| 中文 PII | 3 | ✅ 地址电话邮箱稳定，人名偶漏 |
| 密钥密码 | 3 | ✅ API Key/密码/AWS Secret 识别 |
| URL 区分 | 2 | ✅ 私人 URL 标记，公开 URL 跳过 |
| 日期识别 | 1 | ⚠️ 所有日期都标记，区分度待提升 |
| 代码片段 | 1 | ✅ 硬编码凭证全识别 |
| 复杂场景 | 2 | ✅ 客服对话 5/5、混合场景精准 |
| 边界情况 | 2 | ✅ 空字符串安全、公开信息正确跳过 |
| **总计** | **18** | **29 个实体，平均 1.7 个/用例** |

### 亮点

1. **上下文感知是核心壁垒**：公众人物 vs 私人个体的区分，正则做不到，传统 NER 也做不到这个粒度
2. **中英文混合支持**：中文地址、电话、邮箱识别稳定
3. **量化版 772MB**：Mac CPU 推理无压力，单次推理毫秒级
4. **Apache 2.0**：商业友好，随便用

### 不足

1. **中文人名识别不稳定**："张三"漏了但"李四"识别了，可能需要微调
2. **日期类过于激进**：会议日期也被标记为隐私，上下文感知在日期类别上不如姓名类精准
3. **数据库连接串漏网**：`mysql://admin:password@host` 这种格式未识别
4. **AWS Access Key ID 未识别**：只识别了 Secret Key

---

## 六、适用场景

| 场景 | 说明 |
|------|------|
| **训练数据清洗** | LLM 训练语料中混入 PII 是合规大忌，自动清洗 |
| **日志脱敏** | 用户反馈、客服对话等非结构化文本批量脱敏 |
| **代码审查** | 检测代码中硬编码的 API Key、密码、个人信息 |
| **合规审计** | GDPR、个人信息保护法的数据预处理 |
| **LLM 安全网关** | 在用户输入送进大模型前自动过滤敏感信息 |

---

## 七、完整 Demo 代码

完整可运行的 Demo 脚本（含 18 个测试用例）：

```python
#!/usr/bin/env python3
"""
OpenAI Privacy Filter - ONNX 本地部署 Demo
使用 model_q4f16 (INT4量化+FP16，772MB) 模型
"""

import os
import json
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# ============ 路径配置 ============
MODEL_DIR = os.path.join(os.path.dirname(__file__), "model")
ONNX_PATH = os.path.join(MODEL_DIR, "onnx/model_q4f16.onnx")
TOKENIZER_PATH = os.path.join(MODEL_DIR, "tokenizer.json")
CONFIG_PATH = os.path.join(MODEL_DIR, "config.json")
CALIB_PATH = os.path.join(MODEL_DIR, "viterbi_calibration.json")

# ============ 加载模型和配置 ============
print("🐷 正在加载模型...")
tokenizer = Tokenizer.from_file(TOKENIZER_PATH)

with open(CONFIG_PATH) as f:
    config = json.load(f)

id2label = config["id2label"]

# 加载 ONNX Runtime session
session = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
print(f"✅ 模型加载完成！输入: {[i.name for i in session.get_inputs()]}")

# ============ 标签归类 ============
LABEL_CATEGORIES = {
    "private_person": "👤 私人姓名",
    "private_address": "📍 私人地址",
    "private_email": "📧 私人邮箱",
    "private_phone": "📱 私人电话",
    "private_url": "🔗 私人URL",
    "private_date": "📅 私人日期",
    "account_number": "💳 账号信息",
    "secret": "🔑 密钥/密码",
}


def predict(text: str) -> list[dict]:
    """对输入文本进行隐私实体识别"""
    encoding = tokenizer.encode(text)
    input_ids = np.array([encoding.ids], dtype=np.int64)
    attention_mask = np.array([encoding.attention_mask], dtype=np.int64)

    outputs = session.run(None, {"input_ids": input_ids, "attention_mask": attention_mask})
    logits = outputs[0]  # shape: (1, seq_len, num_labels)
    predictions = np.argmax(logits, axis=-1)[0]

    # 解析 BIOES 标签
    tokens = encoding.tokens
    entities = []
    current_entity = None

    for i, (token, pred_id) in enumerate(zip(tokens, predictions)):
        label = id2label.get(str(pred_id), "O")
        if label == "O":
            if current_entity:
                current_entity["end"] = i
                entities.append(current_entity)
                current_entity = None
            continue

        bio_tag, entity_type = label.split("-", 1)

        if bio_tag == "B" or bio_tag == "S":
            if current_entity:
                current_entity["end"] = i
                entities.append(current_entity)
            current_entity = {
                "type": entity_type,
                "start": i,
                "end": i + 1,
                "tokens": [token],
            }
        elif bio_tag == "I" or bio_tag == "E":
            if current_entity and current_entity["type"] == entity_type:
                current_entity["tokens"].append(token)
                current_entity["end"] = i + 1

    if current_entity:
        current_entity["end"] = len(tokens)
        entities.append(current_entity)

    # 还原文本片段
    for ent in entities:
        ent["text"] = tokenizer.decode(encoding.ids[ent["start"] : ent["end"]])

    return entities


def redact_text(text: str, entities: list[dict]) -> str:
    """用 [REDACTED] 替换识别出的隐私实体"""
    result = text
    # 按位置从后往前替换，避免偏移
    for ent in sorted(entities, key=lambda e: e["start"], reverse=True):
        result = result[: ent["start_char"]] + f"[{ent['type'].upper()}]" + result[ent["end_char"] :]
    return result


def analyze_text(text: str):
    """完整分析一段文本"""
    print(f"\n{'='*60}")
    print(f"📝 原文: {text}")
    print(f"{'='*60}")

    # 先获取原始文本的字符级位置
    encoding = tokenizer.encode(text)
    # 构建 token -> char 映射
    offsets = encoding.offsets  # list of (start_char, end_char)

    entities = predict(text)

    # 补充字符级位置
    for ent in entities:
        if ent["start"] < len(offsets) and ent["end"] <= len(offsets):
            ent["start_char"] = offsets[ent["start"]][0]
            ent["end_char"] = offsets[ent["end"] - 1][1] if ent["end"] > 0 else offsets[ent["start"]][1]

    if not entities:
        print("✅ 未检测到隐私信息！")
        return

    print(f"\n🔍 检测到 {len(entities)} 个隐私实体:\n")
    for i, ent in enumerate(entities, 1):
        cat = LABEL_CATEGORIES.get(ent["type"], ent["type"])
        print(f"  {i}. {cat}")
        print(f"     内容: \"{ent['text']}\"")
        print()

    # 脱敏后的文本
    redacted = redact_text(text, entities)
    print(f"🛡️  脱敏结果: {redacted}")


# ============ 全面测试用例 ============
if __name__ == "__main__":
    test_cases = [
        # === 基础英文测试 ===
        ("基础英文个人信息", "My name is John Smith, I live at 123 Main Street, San Francisco. You can reach me at john.smith@email.com or call me at 555-123-4567."),
        
        # === 公众人物上下文感知 ===
        ("公众人物-Obama", "Barack Obama visited the White House yesterday. His email is public."),
        ("公众人物-Elon Musk", "Elon Musk tweeted about Tesla from his office in Austin, Texas."),
        ("混合-公众+私人", "Barack Obama and my neighbor John Smith both attended the event at 456 Oak Avenue."),
        
        # === 中文测试 ===
        ("中文地址电话", "请将包裹寄到北京市朝阳区建国路88号，收件人张三，电话13800138000。"),
        ("中文邮箱姓名", "我的名字是李四，邮箱是 lisi@example.com，家住上海市浦东新区张江路100号。"),
        ("中文日期银行卡", "我的生日是1990年5月20日，银行卡号是6222021234567890。"),
        
        # === 密钥密码测试 ===
        ("API密钥+密码", "API key is sk-abc123def456, and the database password is SuperSecret123!"),
        ("AWS凭证", "AWS access key: AKIAIOSFODNN7EXAMPLE, secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
        ("数据库连接串", "mysql://admin:MyP@ssw0rd!@192.168.1.100:3306/production"),
        
        # === URL测试 ===
        ("私人社交链接", "Check out my personal blog at https://john-smith.blogspot.com and my LinkedIn at https://linkedin.com/in/johnsmith"),
        ("公开URL", "The documentation is available at https://docs.python.org and https://github.com/openai"),
        
        # === 边界情况 ===
        ("纯公开信息", "The Eiffel Tower is located in Paris, France. The tour costs 25 euros."),
        ("空字符串", ""),
        ("纯数字", "My phone is 123-456-7890 and my zip code is 94105."),
        ("英文日期", "My date of birth is January 15, 1985 and the meeting is on 2024-12-25."),
        
        # === 混合场景 ===
        ("客服对话", "Hi, my name is Sarah Jones, my account number is 4111-1111-1111-1111. I need to change my address from 789 Pine Street, Boston to 321 Elm Street, Chicago. My email is sarah.j@personal.com."),
        ("代码片段", "const apiKey = 'ghp_abc123def456'; const user = { name: 'Tom Wilson', email: 'tom@company.com' };"),
    ]

    total_detected = 0
    total_tests = 0
    for label, text in test_cases:
        if not text or not text.strip():
            print(f"\n{'='*60}")
            print(f"📝 [{label}] 原文: (空字符串)")
            print(f"{'='*60}")
            print("⏭️  跳过空字符串")
            continue
        total_tests += 1
        analyze_text(text)
        entities = predict(text)
        total_detected += len(entities)

    print(f"\n{'='*60}")
    print(f"🐷 全面测试完成！")
    print(f"   测试用例: {len(test_cases)} 个")
    print(f"   有效测试: {total_tests} 个")
    print(f"   检测实体: {total_detected} 个")
    print(f"   平均每用例: {total_detected/total_tests:.1f} 个实体")
```

完整脚本和测试用例已开源在我的工具集里，感兴趣的朋友可以直接拿去跑。

---

## 八、总结

OpenAI Privacy Filter 是一个**实用价值很高的工具型模型**。它不是通用大模型，不会写诗画画，但它在"识别文本中的隐私信息"这件事上做得相当精准——尤其是上下文感知区分公众人物这个能力，是目前开源方案里的独一份。

772MB 的量化版在 Mac 上就能跑，推理速度毫秒级，完全可以嵌入到数据管道、日志脱敏系统、代码审查工具里默默干活。

**推荐指数：🐷🐷🐷🐷（4/5）**

扣一分是因为中文人名识别还不够稳，以及日期类的上下文感知有待加强。但瑕不掩瑜，值得部署。

---

> 📦 完整代码 & 测试用例：[GitHub](https://github.com/xiaozhongcheng/timelog/tree/main/data/app/privacy-filter)
> 🤗 HuggingFace 模型：[openai/privacy-filter](https://huggingface.co/openai/privacy-filter)
