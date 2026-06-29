---
title: "声音克隆相似度全网第一！VoxCPM2：无Token化TTS，30语言、自然语言造声、48kHz原生输出"
date: 2026-06-01 17:53:16 +0800
categories: [AI, 工具]
tags: [VoxCPM2, TTS, 声音克隆, OpenBMB, 开源, 语音合成, 多语言]
description: "VoxCPM2 深度评测：2B参数，英文相似度85.4%碾压闭源商业模型，支持30种语言、Apache-2.0全商用开源。"
pin: false
---


> 2B参数，训练数据超200万小时，声音克隆相似度英文85.4%碾压闭源商业模型，Apache-2.0全商用开源。

---

你有没有遇到过这种场景：想给播客加配音，但市面上TTS音色要么千篇一律，要么克隆出来差那么一口气——细节、节奏、情绪全没了。

OpenBMB 最近放出来的 **VoxCPM2** 直接把这个问题砸烂了。

## 🏆 成绩单先看

**Seed-TTS-eval 零样本TTS（开源模型横评）**

| 模型 | 参数量 | 英文WER↓ | 英文SIM↑ | 中文CER↓ | 中文SIM↑ |
|------|--------|---------|---------|---------|---------|
| F5-TTS | 0.3B | 2.00% | 67.0% | 1.53% | 76.0% |
| CosyVoice2 | 0.5B | 3.09% | 65.9% | 1.38% | 75.7% |
| IndexTTS2 | 1.5B | 2.23% | 70.6% | 1.03% | 76.5% |
| Qwen3-TTS | 1.7B | 1.23% | 71.7% | 1.22% | 77.0% |
| **VoxCPM2** | **2B** | **1.84%** | **75.3%** | **0.97%** | **79.5%** |

**MiniMax多语言声音相似度评测（SIM，开源&商业对比）**

| 语言 | MiniMax | ElevenLabs | FishAudio S2 | **VoxCPM2** |
|------|---------|------------|-------------|------------|
| 英文 | 75.6% | 61.3% | 79.7% | **85.4%** |
| 中文 | 78.0% | 67.7% | 81.6% | **82.5%** |
| 芬兰语 | 83.5% | 75.9% | 81.9% | **89.0%** |
| 波兰语 | 80.2% | 72.9% | 81.9% | **88.4%** |
| 印地语 | 81.8% | 73.0% | 82.1% | **85.6%** |

**24语言中VoxCPM2 SIM第一**，连 MiniMax、ElevenLabs 这些闭源商业模型都被甩在身后。

**指令音色设计评测（InstructTTSEval）**

| 模型 | 英文APS↑ | 英文DSD↑ | 英文RP↑ |
|------|---------|---------|--------|
| Qwen3TTS | 82.9 | 82.4 | 68.4 |
| **VoxCPM2** | **84.2** | **83.2** | **71.4** |

英文音色设计三项全部第一，用自然语言描述就能造出你想要的声音。

---

## 🤔 它到底干了什么？

一句话：**用文字描述生成声音、从几秒参考音频克隆任意人声、30种语言直出48kHz高质量音频**。

VoxCPM2 最大的突破是 **Tokenizer-Free**——传统TTS要先把音频切成离散Token再预测，这个过程天然丢信息。VoxCPM2 完全在连续隐空间里运作，直接扩散生成，理论上没有离散化的信息损耗。

支持四种核心用法：

| 模式 | 需要什么 | 能控制什么 |
|------|---------|-----------|
| 普通TTS | 文本 | 无 |
| 音色设计 | 文本+括号描述 | 性别/年龄/情绪/语速/音色 |
| 可控声音克隆 | 参考音频+文本 | 音色+可叠加风格指令 |
| 极致克隆 | 参考音频+转录文本 | 完全还原韵律节奏情绪 |

---

## 🏗️ 怎么做到的？

VoxCPM2 基于 **MiniCPM-4** 语言模型底座，四阶段流水线：

| 阶段 | 名称 | 干什么 |
|------|------|--------|
| 1 | LocEnc（局部编码器）| 把参考音频编码成连续表征 |
| 2 | TSLM（文本-语音LM）| 语言模型推断音色与韵律 |
| 3 | RALM（检索增强LM）| 对齐文本与音频序列 |
| 4 | LocDiT（扩散Transformer）| Flow Matching生成最终音频 |

AudioVAE V2 的非对称编解码设计让它可以**输入16kHz参考、输出48kHz成品**，内置超分，不需要外挂升采样器。

---

## 🧪 实战演练

### 安装

```bash
pip install voxcpm
# 需要：Python 3.10-3.12，PyTorch ≥ 2.5，CUDA ≥ 12.0
```

### 实测1：最简TTS

```python
from voxcpm import VoxCPM
import soundfile as sf

model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)

wav = model.generate(
    text="今天天气真不错，适合来一段播客。",
    cfg_value=2.0,
    inference_timesteps=10,
)
sf.write("demo.wav", wav, model.tts_model.sample_rate)
```

加载模型约8GB显存，RTX 4090实测RTF约0.30，生成10秒音频约3秒。

### 实测2：音色设计（不需要参考音频）

```python
# 括号里写自然语言描述，后面跟要合成的文本
wav = model.generate(
    text="(30岁男性，低沉磁性，语速偏慢，有些沧桑感)今天我们来聊聊AI语音的未来。",
    cfg_value=2.0,
    inference_timesteps=10,
)
sf.write("custom_voice.wav", wav, model.tts_model.sample_rate)
```

不需要任何参考录音，描述对了音色就出来了。多生成几次挑最满意的。

### 实测3：可控声音克隆

```python
# 克隆音色，同时叠加风格控制
wav = model.generate(
    text="(语速稍快，充满活力)这是一段带风格控制的克隆语音演示！",
    reference_wav_path="your_voice.wav",  # 5-10秒参考音频即可
    cfg_value=2.0,
    inference_timesteps=10,
)
sf.write("controlled_clone.wav", wav, model.tts_model.sample_rate)
```

### 实测4：极致克隆

```python
# 提供参考音频+其对应文本，完美保留原声所有细节
wav = model.generate(
    text="这段话会以参考音频完全相同的音色、节奏、情绪方式呈现出来。",
    prompt_wav_path="reference.wav",
    prompt_text="参考音频里说的那段话",
    reference_wav_path="reference.wav",
)
sf.write("ultimate_clone.wav", wav, model.tts_model.sample_rate)
```

### 实测5：命令行快速使用

```bash
# 音色设计，一行出音频
voxcpm design --text "(温柔女声，略带微笑)欢迎收听今天的节目" --output out.wav

# 声音克隆
voxcpm clone --text "克隆这个人的声音来说话" --reference-audio voice.wav --output clone.wav

# 批量处理文本文件
voxcpm batch --input texts.txt --output-dir outs/
```

### 性能汇总

| 推理方式 | RTF (RTX 4090) | 显存占用 | 备注 |
|---------|---------------|---------|------|
| 标准PyTorch | ~0.30 | ~8GB | 默认方式 |
| Nano-vLLM | ~0.13 | ~8GB | 高并发部署 |
| vLLM-Omni | 高吞吐 | 多GPU | OpenAI兼容接口 |
| CPU推理 | 较慢 | — | VoxCPM.cpp支持 |

RTF=0.13意味着生成1秒音频只需要0.13秒，实时流式播放完全没问题。

---

## 🎯 谁该用？怎么选？

| 场景 | 推荐方案 |
|------|---------|
| 播客/有声书配音 | 极致克隆 — 克隆主播声音保持风格统一 |
| 产品语音助手 | 音色设计 — 自定义品牌专属声音 |
| 多语言内容本地化 | 普通TTS — 30语言一个模型全搞定 |
| 个人项目/研究 | pip install voxcpm，本地跑起来 |
| 生产高并发服务 | vLLM-Omni — OpenAI兼容API，多GPU直接部署 |
| 没有GPU | VoxCPM.cpp — CPU/Vulkan推理 |
| ComfyUI工作流 | ComfyUI-VoxCPM或ComfyUI_RH_VoxCPM |

VoxCPM2 的生态已经相当完整：Rust实现、ONNX导出、Apple Neural Engine后端、ComfyUI节点……开源社区已经把各个方向都覆盖了。

---

## 总结

VoxCPM2 把「听不出是AI配的」这件事做得比大多数闭源商业服务还好。

声音克隆相似度多项第一，音色设计指标全面碾压同类开源，30语言加9种中文方言，Apache-2.0随便商用，一行`pip install voxcpm`装完就跑。

对做播客、做内容、做AI产品的朋友来说，现在有了一个不用花钱、不用API Key就能上的顶级TTS方案。

---

**项目地址**：https://github.com/OpenBMB/VoxCPM

**模型权重**：HuggingFace `openbmb/VoxCPM2` | ModelScope `OpenBMB/VoxCPM2`

**许可证**：Apache-2.0（商业可用）

**在线体验**：HuggingFace Spaces: OpenBMB/VoxCPM-Demo

---

*觉得有用？点赞转发让更多人看到 💪*
