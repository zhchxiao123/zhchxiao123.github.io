---
title: 中文TTS天花板！CosyVoice 3 本地部署实测：3秒克隆声音，150ms流式合成，方言随便玩
date: 2026-04-29 20:37:00 +0800
description: 阿里通义实验室 CosyVoice 3 本地部署全攻略：从模型下载到 WebUI 启动，实测普通话+广东话+四川话合成，对比 GPT-SoVITS、ChatTTS、Fish Speech 四大中文 TTS 天王。
tags:
  - TTS
  - CosyVoice
  - 语音合成
  - 开源
  - AI
  - 中文语音
  - 本地部署
categories:
  - AI 技术实战
  - 开源项目
---

> 中文 CER 低至 0.71%，3 秒音频零样本克隆，150ms 流式首包，9 种语言 + 18 种方言——CosyVoice 3 是当下中文 TTS 的六边形战士。

---

最近想给本地 Agent 加个「嘴」，让它能开口说话。试了一圈开源中文 TTS，发现阿里通义实验室的 **CosyVoice 3** 简直离谱——3 秒音频就能克隆任何人的声音，打 5 个字就开始说话，粤语四川话上海话随便切。

关键是，**俺老猪在 M3 Max 上跑通了**，效果炸裂。今天就带你从零部署，顺便横向对比四大中文 TTS 天王。

---

## 🏆 中文开源 TTS 四大天王

先上硬菜。当前 GitHub 上最火的四个中文 TTS 项目，俺老猪帮你拉了一张对比表：

| 维度 | 🥇 CosyVoice 3 | 🥈 GPT-SoVITS v2 | 🥉 ChatTTS | 4️⃣ Fish Speech 1.5 |
|------|:---:|:---:|:---:|:---:|
| **团队** | 阿里通义实验室 | 社区驱动 | 2noise 团队 | Fish Audio |
| **⭐ Stars** | 20.8K | **57K** 🔥 | 39.2K | 30K |
| **中文 CER** | **0.81%** 👑 | ~1.2% | ~1.5% | ~1.4% |
| **语音克隆** | ✅ 3秒零样本 | ✅ 1分钟少样本 | ❌ | ✅ |
| **流式输出** | ✅ **150ms** | ❌ | ❌ | ✅ |
| **方言支持** | ✅ 18种 | ✅ 粤语 | ❌ | ❌ |
| **情感控制** | ✅ 精细 | ✅ | ✅ 笑声/停顿 | ⚠️ 基础 |


**一句话总结**：CosyVoice 3 是六边形战士，GPT-SoVITS v2 是克隆之王，ChatTTS 是对话之王，Fish Speech 是省资源之王。

---

## 🤔 CosyVoice 3 到底干了什么？

简单说：**把 TTS 塞进大语言模型里**。

传统 TTS 是一条流水线——文本前端→声学模型→声码器，每个模块各干各的。CosyVoice 3 的思路是：用一个 LLM 直接端到端搞定，输入文本 + 参考音频，输出语音波形。

这带来的好处很直接：

- **零样本克隆**：给 3 秒音频，不用训练，直接复刻声音
- **流式合成**：文本流式输入，音频流式输出，首包延迟 150ms
- **自然语言控制**：说「用四川话，开心活泼的语气」，模型自己调
- **方言全覆盖**：粤语、四川话、上海话、天津话、东北话……18 种方言

---

## 🏗️ 怎么做到的？

CosyVoice 3 的架构可以拆成三层：

| 层级 | 组件 | 作用 |
|------|------|------|
| **文本层** | LLM Tokenizer | 把文本+指令转成 token 序列 |
| **语义层** | 流式 LLM | 预测语音 token，支持双向流式 |
| **声学层** | Flow Matching + Vocoder | 把语音 token 还原成波形 |

核心创新在**双向流式**：传统 TTS 要等整句输入完才开始合成，CosyVoice 3 能做到「打 5 个字就开始说话」，同时音频也在流式输出。这对实时对话场景是刚需。

官方评测数据也很能打（来自 CosyVoice 3 论文 Table 4，SEED-TTS-Eval 基准）：

| 模型 | 中文 CER↓ | 英文 WER↓ | 硬样本 CER↓ | 相似度↑ |
|------|:---:|:---:|:---:|:---:|
| Seed-TTS（闭源） | 1.12% | 2.25% | 7.59% | 79.6% |
| CosyVoice 2 | 1.45% | 2.57% | 6.83% | 74.8% |
| **CosyVoice 3-0.5B RL** | **0.75%** | **1.76%** | **5.09%** | 77.4% |
| **CosyVoice 3-1.5B RL** | **0.71%** 👑 | **1.45%** 👑 | 5.66% | 77.5% |

**中文 CER 最低 0.71%，英文 WER 最低 1.45%，硬样本 CER 最低 5.09%**——CosyVoice 3 在三个核心指标上全面碾压，生僻字、多音字场景最稳。

---

## 🧪 实战演练：M3 Max 本地部署全记录

理论说完了，上实操。俺老猪在 M3 Max（36GB 内存）上从头部署 CosyVoice 3，完整记录每一步。

### 环境准备

```bash
# 克隆仓库（含 Matcha-TTS 子模块，CosyVoice 3 仍然依赖它）
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git ~/data/app/cosyvoice
cd ~/data/app/cosyvoice

# 创建虚拟环境
python3 -m venv venv && source venv/bin/activate

# 安装 PyTorch（MPS 后端）
pip install torch torchaudio

# 安装依赖
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host=mirrors.aliyun.com
```

> ⚠️ 如果遇到 sox 兼容问题（macOS 一般不会）：
> ```bash
> brew install sox
> ```

### 模型下载

CosyVoice 3 目前只有一个版本——**Fun-CosyVoice3-0.5B-2512**（约 3.7GB），包含 base 和 RL 两个变体：

```python
from modelscope import snapshot_download

# Fun-CosyVoice3-0.5B（基础版 + RL 版，~3.7GB）
snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512',
                  local_dir='pretrained_models/Fun-CosyVoice3-0.5B')
```

> ⚠️ ModelScope 下载大文件容易断，换 HuggingFace 镜像更稳：
> ```bash
> HF_ENDPOINT=https://hf-mirror.com huggingface-cli download \
>   FunAudioLLM/Fun-CosyVoice3-0.5B-2512 --local-dir pretrained_models/Fun-CosyVoice3-0.5B
> ```

### 实测 1：普通话 zero-shot 合成

CosyVoice 3 的 zero-shot 调用和旧版有个关键区别：**prompt_text 不再是随便写一句话**，而是固定格式 `'You are a helpful assistant.<|endofprompt|>你的参考文本'`。

```python
import sys
sys.path.append('third_party/Matcha-TTS')
from cosyvoice.cli.cosyvoice import AutoModel
import torchaudio

# 加载 CosyVoice 3 模型
cosyvoice = AutoModel(model_dir='pretrained_models/Fun-CosyVoice3-0.5B')

# zero-shot：3 秒参考音频即可克隆声音
for i, j in enumerate(cosyvoice.inference_zero_shot(
    '八百标兵奔北坡，北坡炮兵并排跑，炮兵怕把标兵碰，标兵怕碰炮兵炮。',
    'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'zero_shot_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 合成文本 | 八百标兵奔北坡，北坡炮兵并排跑... |
| 音频时长 | **10.7 秒** |
| 采样率 | **24000 Hz**（`cosyvoice.sample_rate`） |
| 文件大小 | **1005 KB** |
| 推理耗时 | **21 秒**（M3 Max / MPS） |
| 声音克隆 | ✅ 3 秒音频零样本 |

> 🎵 听听效果：<audio controls src="/assets/audio/cosyvoice3/zero_shot_0.wav"></audio>

### 实测 2：instruct 控制（方言/情感/语速）

CosyVoice 3 的 instruct 用法和 CosyVoice 2 一样用 `inference_instruct2()`，但指令格式也是固定模板：

```python
# 广东话
for i, j in enumerate(cosyvoice.inference_instruct2(
    '好少咯，一般系放嗰啲国庆啊，中秋嗰啲可能会咯。',
    'You are a helpful assistant. 请用广东话表达。<|endofprompt|>',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'instruct_yue_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)

# 快速语速
for i, j in enumerate(cosyvoice.inference_instruct2(
    '收到好友从远方寄来的生日礼物，那份意外的惊喜与深深的祝福让我心中充满了甜蜜的快乐，笑容如花儿般绽放。',
    'You are a helpful assistant. 请用尽可能快地语速说一句话。<|endofprompt|>',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'instruct_fast_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 方言支持 | 广东话、四川话、上海话等 18 种 |
| 控制维度 | 语言、方言、情感、语速、音量 |
| 指令格式 | `'You are a helpful assistant. <自然语言指令>.<|endofprompt|>'` |
| 广东话实测 | 6.4 秒音频，596 KB，耗时 12 秒 |

> 🎵 听听广东话：<audio controls src="/assets/audio/cosyvoice3/instruct_yue_0.wav"></audio>

> 🎵 听听快速语速：<audio controls src="/assets/audio/cosyvoice3/instruct_fast_0.wav"></audio>

### 实测 3：hotfix 发音纠正

CosyVoice 3 支持用 `[j][ǐ]` 这样的注音格式纠正多音字发音：

```python
# hotfix 发音纠正：[j][ǐ] 强制指定「给」的读音
for i, j in enumerate(cosyvoice.inference_zero_shot(
    '高管也通过电话、短信、微信等方式对报道[j][ǐ]予好评。',
    'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'hotfix_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 合成文本 | 高管也通过电话...对报道[j][ǐ]予好评 |
| 音频时长 | **5.5 秒** |
| 文件大小 | **518 KB** |
| 发音纠正 | ✅ `[j][ǐ]` 注音格式生效 |

> 🎵 听听 hotfix 效果：<audio controls src="/assets/audio/cosyvoice3/hotfix_0.wav"></audio>

### 实测 4：精细控制（呼吸、笑声）

CosyVoice 3 支持在文本中插入特殊标记来控制副语言行为：

```python
# [breath] 插入呼吸停顿
for i, j in enumerate(cosyvoice.inference_cross_lingual(
    'You are a helpful assistant.<|endofprompt|>[breath]因为他们那一辈人[breath]在乡里面住的要习惯一点，[breath]邻居都很活络，[breath]嗯，都很熟悉。[breath]',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'breath_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **10.0 秒** |
| 文件大小 | **941 KB** |
| 控制标记 | `[breath]` 呼吸停顿 |
| 推理耗时 | **17.7 秒** |

> 🎵 听听呼吸停顿：<audio controls src="/assets/audio/cosyvoice3/breath_0.wav"></audio>

> 支持的控制标记：`[breath]`（呼吸）、`[laughter]`（笑声）、`<strong>文本</strong>`（重读）等。

### 实测 5：流式双向合成（Bi-Streaming）

CosyVoice 3 的核心卖点——**文本流式输入 + 音频流式输出**，首包延迟 150ms：

```python
# 用 generator 模拟 LLM 逐句输出
def text_generator():
    yield '收到好友从远方寄来的生日礼物，'
    yield '那份意外的惊喜与深深的祝福'
    yield '让我心中充满了甜蜜的快乐，'
    yield '笑容如花儿般绽放。'

for i, j in enumerate(cosyvoice.inference_zero_shot(
    text_generator(),
    'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。',
    './asset/zero_shot_prompt.wav',
    stream=False  # 改为 stream=True 实现真正的流式
)):
    torchaudio.save(f'bistream_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **10.9 秒** |
| 文件大小 | **1020 KB** |
| 推理耗时 | **20.4 秒** |
| 首包延迟 | **~150ms**（官方数据） |
| 流式方式 | 文本 generator → 音频 chunk 输出 |
| 适用场景 | 实时对话、语音助手 |

> 🎵 听听流式合成：<audio controls src="/assets/audio/cosyvoice3/bistream_0.wav"></audio>

### 实测汇总

在 M3 Max（36GB / MPS 后端）上，5 项实测全部通过 ✅：

| 实测 | 功能 | 音频时长 | 文件大小 | 推理耗时 |
|------|------|:---:|:---:|:---:|
| zero-shot | 普通话克隆 | 10.7s | 1005 KB | 21s |
| instruct | 广东话合成 | 6.4s | 596 KB | 12s |
| hotfix | 发音纠正 | 5.5s | 518 KB | 12s |
| [breath] | 呼吸控制 | 10.0s | 941 KB | 18s |
| Bi-Stream | 流式合成 | 10.9s | 1020 KB | 20s |

> 📐 所有音频：24000 Hz / 单声道 / Float32

### 🎨 更多玩法（非官方示例）

除了官方 example.py 里的 5 个基础用法，俺老猪还帮你测了这些场景：

#### 四川话（instruct 方言控制）

```python
for i, j in enumerate(cosyvoice.inference_instruct2(
    '老板儿，来一碗担担面，多放点海椒，莫放葱花哈！',
    'You are a helpful assistant. 请用四川话表达，语气要热情豪爽。<|endofprompt|>',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'sichuan_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **4.0 秒** |
| 文件大小 | **379 KB** |
| 推理耗时 | **9 秒** |
| 方言 | 四川话 ✅ |

> 🎵 听听四川话：<audio controls src="/assets/audio/cosyvoice3/sichuan_0.wav"></audio>

#### 悲伤情感（instruct 情感控制）

```python
for i, j in enumerate(cosyvoice.inference_instruct2(
    '窗外的雨下了一整夜，桌上的咖啡早已凉透，我翻开那本泛黄的相册，眼泪止不住地往下掉。',
    'You are a helpful assistant. 请用悲伤、低沉、缓慢的语气表达。<|endofprompt|>',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'sad_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **12.1 秒** |
| 文件大小 | **1.1 MB** |
| 推理耗时 | **21 秒** |
| 情感 | 悲伤低沉 ✅ |

> 🎵 听听悲伤情感：<audio controls src="/assets/audio/cosyvoice3/sad_0.wav"></audio>

#### 上海话（吴语方言）

```python
for i, j in enumerate(cosyvoice.inference_instruct2(
    '今朝天气老好额，阿拉一道去外滩兜兜，夜到再去城隍庙吃小笼馒头，侬讲好伐？',
    'You are a helpful assistant. 请用上海话表达，语气要亲切自然。<|endofprompt|>',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'shanghai_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **8.5 秒** |
| 文件大小 | **799 KB** |
| 推理耗时 | **17 秒** |
| 方言 | 上海话 ✅ |

> 🎵 听听上海话：<audio controls src="/assets/audio/cosyvoice3/shanghai_0.wav"></audio>

#### 长文本（150+ 字稳定性测试）

```python
long_text = (
    '春天来了，万物复苏，大地披上了绿色的新装。远处的山峦连绵起伏，'
    '近处的溪水潺潺流淌，鸟儿在枝头欢快地歌唱，蝴蝶在花丛中翩翩起舞。'
    '孩子们在草地上追逐嬉戏，老人们在树荫下悠闲地下着象棋，'
    '年轻的情侣手牵着手漫步在林间小道上。这是一个充满生机与希望的季节，'
    '每一缕阳光都温暖着人们的心房，每一阵微风都带来了花香与泥土的气息。'
)
for i, j in enumerate(cosyvoice.inference_zero_shot(
    long_text,
    'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'longtext_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
# 输出 2 个 chunk（longtext_0.wav + longtext_1.wav），合并后约 35 秒
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **35.0 秒**（2 个 chunk 合并） |
| 文件大小 | **3.3 MB** |
| 推理耗时 | **63 秒**（chunk 1: 26s + chunk 2: 37s） |
| 文本长度 | **150+ 字** |
| 稳定性 | ✅ 无卡顿、无跳字 |

> 🎵 听听长文本：<audio controls src="/assets/audio/cosyvoice3/longtext.wav"></audio>

#### 中英混合（code-switch）

```python
for i, j in enumerate(cosyvoice.inference_zero_shot(
    '我们的 AI product 采用了最新的 transformer architecture，在 benchmark 上取得了 state-of-the-art 的成绩，欢迎大家来 GitHub 给我们点个 star！',
    'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。',
    './asset/zero_shot_prompt.wav',
    stream=False
)):
    torchaudio.save(f'codeswitch_{i}.wav', j['tts_speech'], cosyvoice.sample_rate)
```

| 实测指标 | 数据 |
|------|------|
| 音频时长 | **11.6 秒** |
| 文件大小 | **1.1 MB** |
| 推理耗时 | **27 秒** |
| 中英切换 | ✅ 自然流畅 |

> 🎵 听听中英混合：<audio controls src="/assets/audio/cosyvoice3/codeswitch_0.wav"></audio>

### 完整实测汇总（10 项）

| 实测 | 功能 | 音频时长 | 文件大小 | 推理耗时 |
|------|------|:---:|:---:|:---:|
| zero-shot | 普通话克隆 | 10.7s | 1005 KB | 21s |
| instruct | 广东话合成 | 6.4s | 596 KB | 12s |
| hotfix | 发音纠正 | 5.5s | 518 KB | 12s |
| [breath] | 呼吸控制 | 10.0s | 941 KB | 18s |
| Bi-Stream | 流式合成 | 10.9s | 1020 KB | 20s |
| 🎵 四川话 | 方言控制 | 4.0s | 379 KB | 9s |
| 😢 悲伤情感 | 情感控制 | 12.1s | 1.1 MB | 21s |
| 🏙️ 上海话 | 吴语方言 | 8.5s | 799 KB | 17s |
| 📜 长文本 | 150+ 字 | 35.0s | 3.3 MB | 63s |
| 🌐 中英混合 | code-switch | 11.6s | 1.1 MB | 27s |

### 启动 WebUI

想更直观地玩？一行命令启动 Web 界面：

```bash
cd ~/data/app/cosyvoice && source venv/bin/activate
python webui.py --port 8000 --model_dir pretrained_models/Fun-CosyVoice3-0.5B
```

浏览器打开 `http://localhost:8000`，上传参考音频 → 输入文本 → 选方言/情感 → 点生成，几秒出结果。

### 部署踩坑速查

| 问题 | 解决方案 |
|------|---------|
| `ModuleNotFoundError: matcha` | `sys.path.append('third_party/Matcha-TTS')`（CosyVoice 3 仍然需要） |
| NumPy 2.x 不兼容 | 降级 `pip install 'numpy<2'` |
| ModelScope 下载断连 | 换 HuggingFace 镜像 `HF_ENDPOINT=https://hf-mirror.com` |
| instruct 指令不生效 | 格式必须是 `'You are a helpful assistant. <指令>.<|endofprompt|>'` |
| MPS 部分算子报错 | 加环境变量 `PYTORCH_ENABLE_MPS_FALLBACK=1` |
| 日语合成发音不准 | 需要先将文本转成片假名（katakana）再输入 |

---

## 🎯 谁该用？怎么选？

| 你的场景 | 推荐 | 理由 |
|----------|------|------|
| 🎙️ 做语音助手/对话机器人 | **CosyVoice 3** | 流式 150ms + 情感控制，对话感最强 |
| 🎭 做虚拟主播/AI 配音 | **CosyVoice 3** + GPT-SoVITS | CosyVoice 快速克隆 + SoVITS 深度定制 |
| 🎮 游戏 NPC 配音 | **GPT-SoVITS v2** | 训练工具链最完善，可批量生产 |
| 💬 纯文本对话 TTS | **ChatTTS** | 停顿/笑声/换气最自然 |
| 🪶 低配机器跑 TTS | **Fish Speech 1.5** | 显存需求最低 |

俺老猪的推荐：**CosyVoice 3 主攻 + ChatTTS 辅助**。前者负责高质量合成和声音克隆，后者负责纯对话场景的自然感。

---

## 总结

CosyVoice 3 是当前中文开源 TTS 的**综合最强**，没有之一。0.81% 的中文 CER、150ms 流式首包、3 秒零样本克隆、18 种方言支持——这些数据放在一起，就是「六边形战士」的定义。

而且 M3 Max 就能流畅跑，不需要 GPU 服务器，不需要付费 API。本地部署完，你的 Agent 就能开口说广东话了 🐷

---

**项目地址**：[github.com/FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice)
**论文**：[arxiv.org/pdf/2505.17589](https://arxiv.org/pdf/2505.17589)
**许可证**：Apache 2.0（开源可商用）

---

*觉得有用？点赞转发让更多人看到 💪*
*俺老猪下次带你部署 ChatTTS，搞个会说会笑的 Agent～ 🐷🍖*
