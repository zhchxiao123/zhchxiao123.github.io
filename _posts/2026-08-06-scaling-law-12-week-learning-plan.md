---
layout: post
title: "从零到能跑 Scaling Law 实验"
date: 2026-08-06 12:00:00 +0800
categories: [AI, 深度学习, Scaling Law]
tags: [Scaling Law, LLM, 学习笔记, 工程实践]
description: 12 周学习方案 · 起点：会 Python、没训过神经网络 · 终点：自己训一批模型并拟合出 $N_{\text{opt}}\propto C^{a}$ · 每周 15 小时
math: true
---

> 这是我从零开始跑 Scaling Law 实验的 12 周学习方案，覆盖环境搭建、深度学习基础、Transformer 手写、训练工程、拟合练习与真实实验设计。配套理论笔记见 [大模型 Scaling Law 学习笔记](/posts/scaling-law-learning-notes/)。

## 路线总览

> [!NOTE]
> **先说结论：这件事比你想的更可行**
> 调研中最重要的一个发现是——**拟合 scaling law 不需要大集群**。已有至少两个公开的复现工作证明了这点：
> -   **MinChilla**：2 张 A5000、约 12 小时，拟合出 $N\_{\text{opt}}\propto C^{0.48}$，而 Chinchilla 原文 Approach 2 是 $C^{0.49}$ —— **误差 0.01**。
> -   **shehper/scaling\_laws**：单张 A100 跑 3-4 天，复现 Kaplan 的 $\alpha\_N=0.082$（原文 0.076）、$N\_{\text{opt}}\propto C^{0.73}$（原文 0.72）。
> 瓶颈不是算力，是**实验纪律**——超参怎么随规模调、参数怎么数、FLOPs 怎么算。这份方案的重心就放在这里。

### 整体地图

| 阶段 | 周次 | 你在学什么 | 产出 | 时长 |
| --- | --- | --- | --- | --- |
| **0 · 热身** | 第 0 周 | 环境、镜像源、数学自检 | 能跑通第一个 PyTorch 脚本 | 8h |
| **1 · 地基** | 第 1–3 周 | 张量、自动微分、反向传播、MLP、优化器、语言模型与困惑度 | 手写一个能算梯度的微型框架 | 45h |
| **2 · 架构** | 第 4–6 周 | 注意力、位置编码、Transformer、Tokenizer、预训练流程 | **一个你自己写的、能生成文本的 GPT** | 45h |
| **3 · 工程** | 第 7–8 周 | 混合精度、梯度累积、LR 调度、checkpoint、实验记录 | **参数化的训练脚本（实验框架）** | 30h |
| **4 · 拟合** | 第 9 周 | Scaling law 理论 + 用公开数据练拟合 | 能复现 Epoch AI 修正后的 Chinchilla 系数 | 15h |
| **5 · 实验** | 第 10–12 周 | IsoFLOP 扫描、离群点处理、外推验证 | **你自己的 scaling law 曲线 + 报告** | 45h |

合计约 **190 小时 / 12–13 周**。金钱成本：阶段 0–4 全免费，阶段 5 约 **¥350–700**（或用免费算力更省，见 §7）。

> [!IMPORTANT]
> **这条路线的三个设计取舍**
> **1\. 砍掉计算机视觉。** 传统深度学习教程有一半篇幅是 CNN / 图像分类 / 目标检测。对你的目标它们只贡献一个概念（残差连接），所以只读那一节，其余全跳。这一刀省下约 40 小时。  
> **2\. 不追求"完整性"，追求"能跑通一条完整链路"。** 你不需要懂 FSDP、CUDA kernel、RLHF。1M–200M 的模型单卡就装得下，引入分布式只会带来 bug 和不可复现性。  
> **3\. 把"先拟合、后训练"提前到阶段 4。** 这是本方案与常规路线最大的不同——有公开的 (N, D, loss) 数据集（最小的只有 107 KB），你可以**在花一分钱之前**先把拟合代码写对、把坑踩完。等你自己的训练数据出来时，分析管线已经是成熟的了。

### 和 Scaling Law 笔记的对接

你现在看不懂那份笔记，是正常的——它默认了大约 100 小时的前置知识。下面是明确的对接表，学完每个阶段你能读懂哪些章节：

| 学完 | 就能读懂笔记的 | 为什么 |
| --- | --- | --- |
| **第 3 周**（地基结束） | §1 全章、§2.1、§2.6 涌现之争 | 你已经知道 loss 是什么、困惑度怎么算、幂律长什么样、参数量怎么数 |
| **第 6 周**（写完 GPT） | §2.2 Kaplan、§2.3 Chinchilla、§4.1 数据重复、§5.5 多模态 | 你手写过 Transformer，知道 $N\approx 12 n\_{\text{layer}}d^2$ 从哪来，也知道 embedding 参数为什么是个问题 |
| **第 8 周**（工程结束） | §2.4 两法之争、§3 全章、§5.4 超参外推 | 你踩过 LR schedule 和 warmup 的坑，才能理解为什么它们能把指数从 0.50 推到 0.73 |
| **第 9 周**（拟合练习） | §2.5 复现争议、§2.7 函数形式 | 你亲手用 Huber loss + L-BFGS 拟合过，才知道"平均 vs 求和"那个 bug 有多致命 |
| **第 12 周**（实验完成） | **§4、§5、§7 决策手册**——整份笔记 | 这时你看的不再是"别人的结论"，而是"我知道他们是怎么得到这个结论的" |
| （后续，可选） | §6 Test-time 与 RL | 这一章需要额外的 RL 基础，不在本方案范围内。见 §10 的延伸建议 |

> [!TIP]
> **怎么用那份笔记**
> **不要现在通读。** 按上表，每个阶段结束后回去读对应章节——这时候读会有"啊，原来说的是这个"的感觉，而不是"每个字都认识但连不起来"。  
> 唯一的例外是**§9 常量速查表**：可以现在就扫一眼，把它当作"这个领域大概在讨论什么量级的数字"的地图。20 tokens/param、$\alpha\approx0.34$、7-8 bits 最优精度——这些数字你会反复见到。

### 开始前的自我评估

下面是三个自测。**不用全会**——它们的作用是告诉你哪里需要额外补，而不是拦你。

#### 数学（决定你要不要加补丁）

1.  $f(x)=3x^2+2x$，$\frac{df}{dx}$ 是多少？
2.  如果 $y=f(g(x))$，$\frac{dy}{dx}$ 怎么写？（链式法则）
3.  矩阵 $A$ 是 $3\times4$，$B$ 是 $4\times2$，$AB$ 是几乘几？$BA$ 能算吗？
4.  $\log(ab)=?$ $\log(a^b)=?$ 为什么幂律 $y=ax^b$ 在 log-log 图上是直线？

| 结果 | 建议 |
| --- | --- |
| 1–4 全会 | 直接开始，边学边补 |
| 会 1、3，卡在 2 或 4 | 照常开始，但第 1 周额外花 3 小时看 [3Blue1Brown 线性代数本质](https://www.3blue1brown.com/topics/linear-algebra)（有中文字幕）和微积分本质的前 4 集。**第 4 题必须搞懂**——整份 scaling law 笔记的图都是 log-log 的 |
| 大部分不会 | 先花 1 周补：3Blue1Brown 两个系列（线代 + 微积分）各看前 6 集，约 8 小时。**不需要会做题，只需要有几何直觉**。方案顺延 1 周 |

#### Python（应该都会，确认一下）

你需要熟练：类与继承、装饰器（看得懂就行）、列表/字典推导、上下文管理器（`with`）、`argparse` 或类似的配置管理、虚拟环境。**NumPy 的广播（broadcasting）规则**如果不熟，第 1 周会花额外时间——建议提前花 1 小时看一遍。

#### 工程（缺了会在阶段 5 卡住）

Linux 命令行基本操作、SSH 连远程机器、`tmux` 或 `screen`（跑长任务必备，否则断线就前功尽弃）、git 基本流程。**如果没用过 tmux，现在花 20 分钟学 `tmux new -s x` / `Ctrl-b d` / `tmux a -t x` 三个命令就够。**

## 阶段 0 · 环境与热身第 0 周 · 8 小时

目标很低：**让"跑代码"这件事不再有摩擦**。这一步做扎实，后面 12 周省下的时间远超 8 小时。

#### 1\. 建环境（2h）

推荐用 **miniforge + conda**（避开 Anaconda 商业授权的麻烦），或者更轻的 `uv`。先配好国内镜像源，否则装 PyTorch 会等到怀疑人生。

```
# pip 镜像（清华 TUNA，2026-08 核实可用）
pip config set global.index-url https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple

# HuggingFace 镜像（下数据集必备）
echo 'export HF_ENDPOINT=https://hf-mirror.com' >> ~/.bashrc && source ~/.bashrc

# 环境
conda create -n llm python=3.11 -y && conda activate llm
pip install torch numpy matplotlib jupyter tiktoken datasets tqdm wandb scipy
```

> [!WARNING]
> **PyTorch 版本的一个坑**
> `pip install torch` 从 PyPI 拉的是默认 CUDA 版本，走清华镜像能正常拉到。但如果你要指定 CUDA 版本（`--index-url https://download.pytorch.org/whl/cu128`），**那个源没有国内镜像，会非常慢**。  
> 解决办法：本地开发用默认版本即可；到阶段 5 租云 GPU 时，**直接选平台预装 PyTorch 的镜像**（AutoDL、恒源云都有），不要自己装。  
> 版本要求：**≥2.5 即可**（需要 `scaled_dot_product_attention` 和 `torch.compile`）。本方案对具体版本不敏感。

#### 2\. 验证 GPU（0.5h）

```
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
```

**没有 GPU 完全不影响前 6 周**——阶段 1、2 的所有内容在笔记本 CPU 上都能跑。真正需要 GPU 是第 7 周之后。

#### 3\. 学会 tmux（0.5h）

三个命令：`tmux new -s train` 开会话、`Ctrl-b` 然后 `d` 脱离、`tmux a -t train` 重新接上。阶段 5 你会跑几十个几小时的任务，没有这个断线就白跑。

#### 4\. 热身：跑通一个"什么都不懂但能跑"的例子（3h）

去 [nanoGPT](https://github.com/karpathy/nanoGPT) 跑一次莎士比亚字符级训练。**现在完全不需要看懂代码**，目的只是建立"训练一个语言模型"的体感：

```
git clone https://gh-proxy.com/https://github.com/karpathy/nanoGPT.git
cd nanoGPT && python data/shakespeare_char/prepare.py

# 有 GPU（约 3 分钟）
python train.py config/train_shakespeare_char.py

# 纯 CPU（约 3 分钟，玩具规模）
python train.py config/train_shakespeare_char.py --device=cpu --compile=False \
  --eval_iters=20 --log_interval=1 --block_size=64 --batch_size=12 \
  --n_layer=4 --n_head=4 --n_embd=128 --max_iters=2000 --lr_decay_iters=2000 --dropout=0.0

python sample.py --out_dir=out-shakespeare-char
```

看着 loss 从 4.2 掉到 1.5，然后模型开始吐出像莎士比亚的胡话。**这个画面是你接下来 12 周的锚点**——之后学的每一样东西，都是在解释刚才那三分钟里发生了什么。

> [!TIP]
> **遇到报错先加 --compile=False**
> nanoGPT 默认启用 `torch.compile`，在部分平台（尤其 Windows）不可用。任何编译相关的报错，先关掉它再说。

#### 5\. 建实验日志（2h）

建一个 git 仓库，结构大致这样。**从第一天就开始记**——阶段 5 的报告靠的就是这些流水账。

```
my-scaling-lab/
├── notes/          # 每周学习笔记（markdown）
├── exercises/      # 阶段 1-2 的手写代码
├── framework/      # 阶段 3 的实验框架
├── fitting/        # 阶段 4-5 的拟合脚本
└── results/        # 实验结果 CSV
```

> [!IMPORTANT]
> **✓ 阶段 0 过关标准**
> 能在 5 分钟内从零建好一个能 import torch 的环境；跑出过一次莎士比亚模型的输出；知道 tmux 怎么用。

## 阶段 1 · 深度学习地基第 1–3 周 · 45 小时

**主教材**：[《动手学深度学习》中文版 (zh.d2l.ai)](https://zh.d2l.ai/)，PyTorch 版。免费在线，每节都有可运行代码，[论坛](https://discuss.d2l.ai/c/16)至今活跃（2026 年 8 月仍有新帖）。

> [!WARNING]
> **关于 d2l 你需要知道的两件事**
> **1\. 中文版停更在 2022 年（v2.0.0）。** 官方 README 明说"新版将继续用英文编写"。这意味着它**没有 LLM 预训练、没有 RLHF、没有混合精度、没有 scaling law**。  
> **2\. 但它仍然是最优选择**——中文 + 文字 + 可运行代码 + 活跃论坛，四项全中，找不到第二个。**把它定位成"到 2022 年为止的深度学习基础"，不是 LLM 教程**，第 4 周开始接第二本就行。  
> 潜在问题：d2l 的 pip 包对 torch 版本有 pin，新版 torch 可能有 API 漂移。**建议开独立 conda 环境，按书里「16.1 安装」的版本装**，别用系统最新 torch。

### 第 1 周：张量与梯度15 小时

#### 读什么（8h）

-   **d2l 第 2 章 预备知识**——张量操作、自动微分、概率基础。这是 PyTorch 手感的唯一入口，**每个代码块都自己敲一遍**，不要复制粘贴。
-   **d2l 第 3 章 线性神经网络**——线性回归、softmax 回归。注意它的写法模板：每个模型都"从零实现"一遍再"简洁实现"一遍。**这个模板是全书方法论的核心**，也是你以后读任何论文代码的基本功。

#### 动手（7h）——本周的重头戏

**手写 micrograd**。这是整条路线上**唯一真正打开"梯度"黑盒**的机会，而它只有 150 行。

方式：看 Karpathy 的 [The spelled-out intro to neural networks and backpropagation](https://youtu.be/VMj-3S1tku0)（2h25m，B 站有中文字幕搬运），**但不要只看——从空文件开始跟着写**。参考实现在 [karpathy/micrograd](https://github.com/karpathy/micrograd)，写完再对照。

你要实现的：

-   `Value` 类：包住一个标量，记录它是由哪些值经过什么运算得来的
-   `__add__`、`__mul__`、`tanh` 等运算，每个都挂一个 `_backward` 闭包
-   `backward()`：拓扑排序 + 反向遍历，把梯度一路传回去
-   一个 `MLP` 类，用它训练一个二分类任务

> [!IMPORTANT]
> **为什么这 7 小时是全程性价比最高的**
> 做完之后，`loss.backward()` 对你就不再是魔法，而是"我知道它在干什么的加速库"。**跳过这一步，后面每一次调试梯度问题你都只能靠猜。**  
> 它还有一个隐藏收益：阶段 5 你要判断"我的 loss 不降是超参问题还是代码 bug"，这个判断力直接来自你对反向传播的理解深度。

> [!IMPORTANT]
> **✓ 第 1 周过关标准**
> 不看原码，独立写出 `Value.__mul__` 的 `_backward` 闭包；能解释"为什么梯度要累加而不是覆盖"。

### 第 2 周：训练一个网络15 小时

#### 读什么（12h）

-   **d2l 第 4 章 多层感知机**——**本阶段最重要的一章**。4.4 到 4.10（模型选择/过拟合、权重衰减、Dropout、前向反向传播、数值稳定性与初始化）是你之后所有调参直觉的来源。慢慢读。
-   **d2l 第 5 章 深度学习计算**——层与块、参数管理、自定义层、读写文件、GPU。**第 6 周你要自己搭 Transformer，全靠这一章的基本功。**
-   **d2l 第 6 章 卷积神经网络**——快速略读 2 小时，知道卷积是什么即可
-   **d2l 7.5（批量规范化）+ 7.6（残差网络 ResNet）**——**只读这两节，第 7 章其余全跳**。归一化 + 残差连接是 Transformer 的直接前置。

#### 动手（3h）

用 PyTorch 重写第 1 周的 micrograd 实验：同一个二分类任务，用 `nn.Module` + `optim.SGD` 实现，对比两者的 loss 曲线是否一致。**这个对照会让你确信 PyTorch 没有做任何"额外的魔法"。**

> [!TIP]
> **卡住时的第二解释**
> d2l 强在代码、弱在直觉。卡住时去翻 [《李宏毅深度学习教程》](https://github.com/datawhalechina/leedl-tutorial)（16.6k star，2025-06 仍在更新）的对应章节——它强在直觉、弱在代码，正好互补。通常 20 分钟能解决一个卡点。  
> **不要通读它**，只当查询工具用。

> [!IMPORTANT]
> **✓ 第 2 周过关标准**
> 能解释：为什么需要激活函数？权重衰减和 Dropout 各在防止什么？为什么深层网络需要残差连接？能用 `nn.Module` 从零搭一个三层 MLP 并训练。

### 第 3 周：语言模型与优化器15 小时

这一周你会第一次接触 scaling law 的**因变量**（loss / 困惑度）和**最大的实验陷阱来源**（优化器与学习率调度）。

#### 读什么（12h）

-   **d2l 第 8 章 循环神经网络**——重点是 **8.1 序列模型、8.2 文本预处理、8.3 语言模型和数据集**。**8.3 里的困惑度定义必须搞懂**：$\text{PP} = \exp(L)$，其中 $L$ 是每 token 平均交叉熵。这就是 scaling law 里那个 $L$。RNN 本身（8.4–8.7）快速过即可，它对 LLM 已属历史。
-   **d2l 第 9 章**——大部分可跳。只看 9.6 编码器-解码器架构的概念
-   **d2l 第 11 章 优化算法**——**必读，且要读细**。11.4 随机梯度下降、11.6 动量法、11.8 RMSProp、**11.10 Adam**、**11.11 学习率调度**。

> [!IMPORTANT]
> **第 11 章为什么这么重要**
> 你的 scaling law 实验成败，**90% 取决于优化器和 LR schedule 处理得对不对**。  
> 剧透一下笔记 §2.4 的内容：Kaplan 2020 得出 $N\propto C^{0.73}$、Chinchilla 2022 得出 $C^{0.50}$，业界为此走了两年弯路。后来发现原因之一就是 **Kaplan 对所有模型用了固定 3000 步的 warmup**——这对小模型太长了，人为压低了小模型的表现，让曲线偏向"大模型更划算"。  
> 现在你可能还看不懂这段话。**但读完第 11 章你就懂了**，而且会立刻明白为什么本方案在阶段 5 反复强调"warmup 要按总步数的百分比设，不要设固定步数"。

#### 动手（3h）

写一个脚本，画出三种 LR schedule 的曲线：constant、cosine decay、linear warmup + cosine decay。然后在第 2 周的 MLP 任务上分别跑一遍，对比 loss 曲线。**亲眼看到 schedule 对最终 loss 的影响有多大。**

> [!IMPORTANT]
> **✓ 第 3 周过关标准 —— 也是第一个里程碑**
> -   能解释交叉熵损失和困惑度的关系，知道 $L=2.2$ 意味着什么（提示：$e^{2.2}\approx 9$，相当于每个 token 在 9 个候选里猜）
> -   能说清 Adam 相比 SGD 多做了什么（一阶矩、二阶矩、偏差修正）
> -   能解释为什么需要 warmup
> **现在去读 scaling law 笔记的 §1 和 §2.1**——应该基本能读懂了。读不懂的地方记下来，它们是你后面几周的具体目标。

## 阶段 2 · Transformer 与 LLM第 4–6 周 · 45 小时

这一阶段结束时，你会有**一个自己从零写出来、能生成文本的 GPT**。这是整个方案的第一个大产出。

#### 教材选择：happy-llm 为主

**主教材**：[Datawhale happy-llm](https://github.com/datawhalechina/happy-llm)（32.3k star）· [在线阅读](https://datawhalechina.github.io/happy-llm/)。免费、中文原生、有完整代码、官方还放出了训练好的 215M 模型权重可对照。

**备选/补读**：Sebastian Raschka《Build a LLM from Scratch》中文版《**从零构建大模型**》（人民邮电，2025-04，325 页，译者覃立波/冯骁骋/刘乾）· [代码仓库 97.4k star](https://github.com/rasbt/LLMs-from-scratch)。

> [!TIP]
> **两者怎么选**
> 内容高度重叠（都是"手写 GPT 并预训练"）。**建议：以 happy-llm 为主线**——免费、在线、中文原生、贴近国产模型生态（讲的是 LLaMA2 架构和 RoPE/RMSNorm/GQA，正是现在实际在用的）。  
> 如果读 happy-llm 觉得跳跃太快，再买 Raschka 中文版当"慢速版"补读——他的行文粒度更细，一步一图。**但不要两本都完整做完**，那会白白多花 3-4 周。

### 第 4 周：注意力机制15 小时

#### 读什么（10h）

-   **d2l 第 10 章 注意力机制**——**全书优先级最高的一章**。10.1 注意力提示 → 10.3 注意力评分函数 → 10.5 多头注意力 → **10.6 自注意力和位置编码** → **10.7 Transformer**。这是你唯一一次跟着完整教材手写 Transformer。
-   **happy-llm 第 1 章 NLP 基础 + 第 2 章 Transformer 架构**——用现代视角重讲一遍。它会补上 d2l 缺的部分：RMSNorm、RoPE、SwiGLU、GQA，这些才是 2026 年实际在用的组件。

#### 动手（5h）

**不看任何参考，手写因果多头注意力**（causal multi-head attention）。要求：

-   输入 `(batch, seq_len, d_model)`，输出同形状
-   正确的因果 mask（第 $i$ 个位置看不到 $i$ 之后的）
-   多头拆分与合并
-   写单元测试：验证 mask 生效（改动第 $j$ 个 token 不应影响第 $i\lt j$ 个位置的输出）

> [!IMPORTANT]
> **这里有个和 scaling law 直接相关的知识点**
> 写完之后你会知道：Transformer 的参数量大致是 $N \approx 12\, n\_{\text{layer}}\, d\_{\text{model}}^2$（每层：注意力的 Q/K/V/O 四个 $d\times d$ 矩阵 = $4d^2$，FFN 的两个 $d\times 4d$ 矩阵 = $8d^2$，合计 $12d^2$）。  
> **这正是 Kaplan 2020 论文里那个公式。** 而它**不包括 embedding** —— 这个"不包括"后来引发了整个领域两年的混乱（笔记 §2.4）。你现在手写一遍，就永远不会搞混这个口径问题了。

> [!TIP]
> **位置编码：什么时候读苏剑林**
> [科学空间（kexue.fm）](https://kexue.fm/)是中文圈讲位置编码最好的地方，无可替代。但它数学密度极高（难度 5/5），**现在读会挫败**。  
> 正确时机是**本周手写完 attention 之后**，这时你能对上号了。只读两篇：[《让研究人员绞尽脑汁的Transformer位置编码》](https://kexue.fm/archives/8130)和 [《旋转式位置编码 RoPE》](https://kexue.fm/archives/8265)（RoPE 的原始出处就是这篇博客）。其余等到阶段 5。

> [!IMPORTANT]
> **✓ 第 4 周过关标准**
> 不查资料手写出因果多头注意力并通过 mask 测试；能解释为什么 attention 要除以 $\sqrt{d\_k}$；能说出 RoPE 和绝对位置编码的区别。

### 第 5–6 周：手写并预训练 GPT30 小时

#### 读什么 + 动手（happy-llm 第 3–5 章，26h）

-   **第 3 章 预训练语言模型**——Encoder-only / Decoder-only / Encoder-Decoder 的分野，BERT vs GPT 路线之争。（4h）
-   **第 4 章 大语言模型**——现代 LLM 的组成、训练三阶段（预训练 / SFT / 对齐）。（4h）
-   **第 5 章 动手搭建大模型**——**本阶段的核心**。（18h）
    -   实现 LLaMA2 架构（RMSNorm + RoPE + SwiGLU + GQA）
    -   训练自己的 Tokenizer
    -   **完整跑一次小型 LLM 的预训练**

#### 额外动手（4h）：参数量与 FLOPs 计算器

这是**本方案额外加的一个练习，不在任何教材里，但对你的目标极其关键**。写一个函数：

```
def model_stats(d_model, n_layer, n_head, vocab_size, seq_len, d_ff=None):
    """返回参数量与 FLOPs 的详细分解"""
    d_ff = d_ff or 4 * d_model
    # 逐项算：embedding / 每层 attention / 每层 FFN / 输出层
    # 返回 dict: params_embed, params_nonembed, params_total,
    #            flops_per_token_naive (=6N), flops_per_token_precise
    ...
```

精确的每 token FLOPs（前向+反向）应该包含三部分：

$$C\_{\text{per token}} = \underbrace{6 N\_{\text{nonembed}}}\_{\text{主体}} + \underbrace{6\, d\_{\text{model}} V}\_{\text{输出层}} + \underbrace{12\, n\_{\text{layer}}\, L\_{\text{ctx}}\, d\_{\text{model}}}\_{\text{注意力打分}}$$

然后**用它算几个真实模型验证**：GPT-2 small 应该得到 124M 参数（含 embedding）/ 85M（不含）；LLaMA-7B 应该接近 6.7B。

> [!WARNING]
> **这个练习会让你提前发现一个坑**
> 用你的计算器试试 `d_model=256, vocab_size=50257`（GPT-2 词表）：
> -   Embedding 参数 = 50257 × 256 = **12.9M**
> -   Transformer 主体 ≈ **5M**
> **Embedding 是主体的 2.6 倍。** 这时候"模型有多大"这个问题根本没有唯一答案——而你拟合出的 scaling law 指数会因为这个选择而剧烈变化。  
> 这就是为什么阶段 5 的实验设计里，第一条硬性要求就是**自训一个小词表（8k–16k）**。现在提前踩到这个坑，比在花了 ¥500 训完之后才发现要好得多。

> [!IMPORTANT]
> **✓ 阶段 2 过关标准 —— 第二个里程碑**
> -   有一个你自己写的、能生成（哪怕很烂的）文本的 GPT
> -   能不查资料说出：从一段原始文本到模型输出 loss，中间经过哪些步骤
> -   你的参数/FLOPs 计算器能正确算出 GPT-2 small 的 124M
> **现在去读 scaling law 笔记的 §2.2、§2.3、§4.1**。Kaplan 的三条律、Chinchilla 的 $L=E+A/N^\alpha+B/D^\beta$、20 tokens/param——这些现在应该都能看懂了。

## 阶段 3 · 训练工程第 7–8 周 · 30 小时

阶段 2 教你"模型怎么写"，这一阶段教你**"训练怎么跑得对、跑得快、跑得可复现"**。scaling law 实验的成败几乎全在这里。

### 第 7 周：读懂 nanoGPT15 小时

> [!WARNING]
> **先说明：nanoGPT 已被作者标记为废弃（2025-11）**
> README 原文："nanoGPT (this repo) is now very old and deprecated but I will leave it up for posterity"，建议转用 [nanochat](https://github.com/karpathy/nanochat)。  
> **但对你这个目标，我仍然推荐 nanoGPT，理由很具体**：你要做的是**跑几十次小规模训练**，需要的是单文件配置、秒级启动、无强制分布式、600 行能全文通读、显存需求可任意缩小。nanoGPT 每一条都满足；nanochat（8,304 行、uv 依赖树、为 8×H100 设计）每一条都不满足。  
> 更重要的是：**已有的小规模 scaling law 复现工作（shehper/scaling\_laws）就是 nanoGPT 的派生**，沿用同一基座你能直接对照它的配置和结果。  
> "废弃"的实际风险：issue 不会再被处理（但有 10k fork，遇到问题先搜 fork）、依赖未 pin（但只用 `train.py`+`model.py`+字符级数据这条路径的话，只需要 torch/numpy/tiktoken，最稳）。

#### 任务 1：逐行读懂 `train.py` 和 `model.py`（8h）

总共约 600 行。**不要泛读，要能解释每一行为什么这么写。**重点盯这几处：

| 代码位置 | 要搞懂什么 | 为什么对你重要 |
| --- | --- | --- |
| `configure_optimizers()` | 为什么 weight decay **只施加于 2D 权重矩阵**，不施加于 bias 和 LayerNorm 参数 | 参数分组错了会让 scaling 曲线出现无法解释的偏移 |
| `get_lr()` | warmup + cosine decay 的实现；`lr_decay_iters` 和 `max_iters` 的关系 | **这是 Kaplan/Chinchilla 之争的核心机制**（笔记 §2.4） |
| 梯度累积循环 | 为什么 loss 要除以 `gradient_accumulation_steps`；DDP 下的 `no_sync()` | 阶段 5 你要在小显存上模拟大 batch |
| `torch.autocast` + `GradScaler` | bf16 和 fp16 的区别；为什么 bf16 不需要 GradScaler | 见下方警告框 |
| checkpoint 保存 | 存了哪些东西？**数据读取位置存了吗？** | 断线续训不完整会毁掉整条曲线 |
| `estimate_loss()` | `@torch.no_grad()` 和 `model.eval()` 的作用 | 忘了会导致显存泄漏和评测不一致 |

#### 任务 2：读 build-nanogpt 的 git 历史（5h）

[build-nanogpt](https://github.com/karpathy/build-nanogpt) 的特点是**按 commit 逐步构建**，从空文件开始。用 `git log --reverse` 顺着读，你会看到从"教学版 GPT"到"工程版训练脚本"多出来的东西：权重初始化缩放、weight decay 分组、`torch.compile`、flash attention、DDP。**这对文字学习者特别友好**——commit diff 就是教材。

#### 任务 3：工程知识清单自查（2h）

对照下表，确认每一项你都知道"是什么 + 本任务要不要用"：

| 概念 | 本任务 | 一句话要点 |
| --- | --- | --- |
| BPE Tokenizer | ✅ 必需 | 阶段 5 要**自训小词表**，不能用 GPT-2 的 50257 |
| 数据打包（packing） | ✅ 必需 | 文档首尾相接存成 `uint16` memmap，随机切窗口。**不要用 padding**，浪费算力且污染 token 计数 |
| 混合精度 bf16 | ✅ 必需 | **用 bf16 不要用 fp16**（30 系以上都支持）。见下方警告 |
| 梯度累积 | ✅ 必需 | 跨尺度实验中全局 batch 必须可控 |
| LR warmup + 调度 | ✅ 必需 | warmup 设为**总步数的 1–2%**，不是固定步数 |
| AdamW 参数分组 | ✅ 必需 | $\beta=(0.9, 0.95)$（LLM 惯例，不是 0.999），wd=0.1 只给 2D 权重 |
| 梯度裁剪 | ✅ 必需 | 先跑 100 步**记录 grad norm 分布再定阈值**，不要盲目用 1.0 |
| SDPA / Flash Attention | ✅ 必需 | 直接用 `F.scaled_dot_product_attention(..., is_causal=True)`，**不需要装 flash-attn 包** |
| checkpoint 完整保存 | ✅ 必需 | 权重 + 优化器 + step + RNG 状态 + **数据位置**，缺一不可 |
| 实验记录 (wandb) | ✅ 必需 | 见第 8 周 |
| 随机种子固定 | ✅ 必需 | 拟合对噪声敏感，**每个关键配置至少 2 个 seed** |
| MFU / 吞吐记录 | ✅ 必需 | 判断"是不是在浪费钱"的唯一指标 |
| `torch.compile` | 🟡 推荐 | 1.3–2× 加速。**调试期关掉，正式跑打开** |
| gradient checkpointing | ❌ 不需要 | 200M 模型在 16G 卡上装得下 |
| DDP 多卡 | 🟡 可选 | 只在想缩短墙钟时用。注意有效 batch 会变 |
| FSDP / ZeRO / DeepSpeed | ❌ 完全不需要 | 只会带来配置复杂度和不可复现性 |

> [!WARNING]
> **bf16 vs fp16：一个能救你几天的建议**
> nanoGPT 有一个**至今未解决**的 issue（#554）：训练 3 万–10 万步之间 loss 突然飙到 NaN，多人尝试各种办法无果。  
> 最有效的单一对策是 **用 bf16 而不是 fp16**。fp16 的动态范围只有约 $6\times10^{-5}$ 到 $65504$，attention logits 和残差累加极易溢出；bf16 与 fp32 同指数范围，几乎消除这类 NaN。**30 系以上显卡、A100、H100 都支持 bf16。**  
> 只有 T4 / P100（Colab、Kaggle 的免费卡）没有 bf16，必须 fp16 + `GradScaler`——这也是我不推荐用免费 Colab 做主实验的原因之一。  
> 附带提醒：fp16 下 `GradScaler` 会**静默跳过**非有限梯度，表现为"loss 莫名不降"。打印 `scaler.get_scale()` 的变化能发现这个问题。

### 第 8 周：造你的实验框架15 小时

**这一周的产出是整个方案的关键交付物**，不是可选项——它就是阶段 5 的实验基础设施。

#### 任务：把 nanoGPT 改造成参数化的扫描框架

目标：能用一行命令跑任意 $(N, D)$ 配置，并输出结构化日志。

```
python train_scan.py \
  --d_model 512 --n_layer 8 --n_head 8 \
  --tokens 2e9 --flop_budget 1e17 \
  --seed 0 --out results/run_042.json
```

必须记录的字段（**照抄这个 schema**，它对齐了公开数据集 `open-athena/isoflop-experiments` 的格式，方便你后面直接对比）：

```
{
  "run_id": "042",
  "config": {
    "d_model": 512, "n_layer": 8, "n_head": 8, "d_ff": 2048,
    "vocab_size": 16384, "seq_len": 1024,
    "params_embed": 8388608,
    "params_nonembed": 25165824,   # 两个都要记！
    "params_total": 33554432
  },
  "compute": {
    "tokens": 2.0e9,
    "flops_naive_6ND": 4.03e17,     # 6 × N_nonembed × D
    "flops_precise": 4.41e17         # 含输出层与 attention 项
  },
  "hparams": {
    "lr_peak": 2.5e-3, "lr_min_ratio": 0.1,
    "warmup_frac": 0.015, "schedule": "cosine",
    "batch_tokens": 262144, "beta1": 0.9, "beta2": 0.95,
    "weight_decay": 0.1, "grad_clip": 1.0, "seed": 0
  },
  "results": {
    "final_val_loss": 3.2841, "min_val_loss": 3.2839,
    "final_val_bpb": 0.9123,
    "wall_clock_s": 4821, "mfu": 0.31, "tokens_per_sec": 415000
  }
}
```

> [!IMPORTANT]
> **五条容易被忽略但必须做对的细节**
> **1\. loss 记录到 6 位小数。** Epoch AI 指出，Chinchilla 原文把系数四舍五入到 2 位小数就已经影响了结论（笔记 §2.5）。  
> **2\. 两套参数口径都记。** 含 embedding 和不含，拟合时两套都跑一遍——它们的差异本身就是一个有价值的实验结果。  
> **3\. LR schedule 的 decay horizon 必须等于该次运行自己的 $D$。** 绝不能跑一条长 run 然后拿中间 checkpoint 当短 run 的结果——那些点的 LR 还没退火完，loss 系统性偏高。**这正是 Kaplan 犯的错。**  
> **4\. warmup 按比例不按步数。** 设成总步数的 1.5%。  
> **5\. 记录 bits-per-byte 而不只是 loss。** 不同 tokenizer 下 nats/token 不可比，bpb 可比。

#### 配套：实验记录工具

-   **wandb**：免费版 5 GB/月存储。**学术邮箱可申请免费无限用**。大陆访问不稳定时用 `wandb offline` 本地记录，之后 `wandb sync`。
-   **同时写本地 CSV/JSON**——最终拟合一定是在本地用 scipy 做的，你需要一份干净的表格，**不要依赖从 wandb 网页导出**。

#### 验证框架（3h）

跑 6 个配置的迷你扫描（每个几分钟，用莎士比亚数据），确认：日志格式正确、断点续训能恢复、两次相同 seed 的结果完全一致。

> [!IMPORTANT]
> **✓ 阶段 3 过关标准 —— 第三个里程碑**
> -   有一个能用命令行参数控制模型尺寸和 token 数的训练脚本
> -   输出结构化 JSON，字段完整
> -   能中断后从 checkpoint 完整恢复（包括数据位置）
> -   相同 seed 两次运行结果一致
> **现在去读笔记 §2.4（两法之争）和 §3（实操章节）**。§3 的"十个坑"你现在应该能对号入座——其中至少三个你这两周已经亲手处理过了。

## 阶段 4 · 先拟合，不训练第 9 周 · 15 小时

> [!NOTE]
> **这一周是本方案最"划算"的部分**
> 常规路线会让你直接去训练，然后在分析阶段发现拟合代码有 bug、数据点不够、跨度太小——但钱已经花掉了。  
> **而存在多个公开的 (N, D, loss) 数据集，最小的只有 107 KB。** 你可以在花一分钱之前，把整条分析管线跑通、把坑踩完。等你自己的数据出来时，只需要换个文件路径。

### 第 9 周：零成本拟合练习15 小时

#### 可用的公开数据集

| 数据集 | 规模 | 字段 | 用途 |
| --- | --- | --- | --- |
| [open-athena/isoflop-experiments](https://huggingface.co/datasets/open-athena/isoflop-experiments) ⭐ | **107 KB**，814 行，7 个 subset | params, tokens, loss, budget | **最佳起点**。聚合了 5 篇论文的数据（Chinchilla 复现、Llama 3、(Mis)Fitting 等），同一 schema |
| [Gemstones](https://github.com/mcleish7/gemstone-scaling-laws)（arXiv:2502.06857） | **143 KB**（直接在 GitHub 仓库里），约 1250 行 | width, depth, tokens, params, final\_loss | 13 个 width×depth 配置，48M–2B 参数。**额外能练宽深律** |
| [Epoch AI Chinchilla 重建](https://github.com/epoch-research/analyzing-chinchilla) | ~400 点 | N, D, L | 从 Chinchilla 论文 Figure 4 的 SVG 里逆向提取的原始数据 |
| [Delphi](https://huggingface.co/datasets/marin-community/delphi-blog-data) | 4117 行，6 subset | params, tokens, loss, gflops | 含**超参扫描**和 **seed 方差**子集，2026 年的现代配方 |

> [!WARNING]
> **两个需要注意的**
> **Gemstones 的绘图缓存**（`smcleish/scaling-laws-cache`）总计 **142 GB**，作者自己提示"只下你需要的具体文件"。**你需要的那 143 KB 直接在 GitHub 仓库的 `benchmarks/` 目录里，git clone 即得，不要碰那个 142 GB 的 HF 数据集。**  
> **Pythia 的 loss 曲线**虽然公开，但作者自称是"messy wandb project"，需要用 wandb API 自己拉，没有现成 CSV；而且所有尺寸都训到固定 300B tokens，不是 IsoFLOP 设计。**作为练习材料性价比低于上面四个。**

#### 拟合工具

| 工具 | 说明 |
| --- | --- |
| [Open-Athena/vpnls](https://github.com/Open-Athena/vpnls) ⭐ | `pip install vpnls[scipy]`。拟合 $L=E+A/N^\alpha+B/D^\beta$，用 Variable Projection 重参数化解决非凸问题。示例脚本直接读上面那个 107 KB 数据集 |
| [kyo-takano/chinchilla](https://github.com/kyo-takano/chinchilla) ⭐ | `pip install chinchilla`。除了拟合，还有 **Simulation Mode**——见下方框，这个功能对你极其有价值 |
| [apple/ml-scalefit](https://github.com/apple/ml-scalefit) | JAX 实现，Basin-Hopping 优化 + bootstrap 不确定性量化。自带 `data/chinchilla.csv` |

#### 本周的六个任务

1.  **复现 Epoch AI 的修正系数（3h）**  
    用 `open-athena/isoflop-experiments` 的 `epochai_chinchilla` subset，跑 Approach 3。**目标：拟合出 $E=1.8172,\\ \alpha=0.3478,\\ \beta=0.3658$。** 拟合不出来就说明你的实现有问题，改到对为止。
2.  **体会"指数不是常数"（2h）**  
    换 `llama_3` 和 `marin_202603` subset 各拟一遍。你会看到指数明显漂移——**scaling law 的系数依赖于数据、tokenizer、架构，不是物理常数。**这个体会会救你后面很多困惑。
3.  **手写一遍拟合，不用现成库（4h）**  
    用 `scipy.optimize.minimize` 自己实现 Chinchilla Approach 3。必须做对这四件事：
    
    -   在 **log 空间**取残差（$\log\hat L - \log L$，不是 $\hat L - L$）
    -   用 **Huber loss**（$\delta=10^{-3}$）而非 MSE
    -   **求和不要平均**——这正是 Chinchilla 原文的 bug（笔记 §2.5）
    -   **多初值网格**：$\alpha,\beta\in\{0,0.5,\dots,2\}$ 等，目标函数有多个局部极小，单初值几乎必错
    
    然后**故意把"求和"改成"平均"，看结果差多少**——你会亲眼看到那个让整个领域困惑了两年的 bug。
4.  **用 Simulation Mode 做实验设计（3h）** ⭐  
    `kyo-takano/chinchilla` 有一个模拟模式：给定一个**已知的真实 scaling law** + 噪声，测试你的估计器。用它回答一个具体问题：  
    **"我需要多少个数据点、跨多大的 N 范围，才能把指数估到 ±0.02？"**  
    这个答案会直接决定你阶段 5 的实验设计——比任何教程都管用。
5.  **对比 Approach 2 vs Approach 3（2h）**  
    对同一份数据分别用 IsoFLOP 抛物线拟合和参数化拟合，看 $C\_{\text{opt}}$ 分配差多少。[Open Athena 的分析](https://openathena.ai/blog/problems-with-chinchilla-approach-2/)在 Llama 3 数据上报告了约 **6.5% 的算力分配误差**——抛物线近似本身就有系统偏差。
6.  **练宽深律（1h）**  
    用 Gemstones 的数据，拟合 loss 对 width 和 depth 的分别依赖。这是公开数据里少有的能做这件事的。

#### 本周该读的理论

-   **scaling law 笔记 §2.3、§2.5、§3 全章**——现在读，每一句都能对上你正在做的事
-   [Lilian Weng, "Scaling Laws, Carefully"（2026-06）](https://lilianweng.github.io/posts/2026-06-24-scaling-laws/)——最新的方法论综述，**做实验前必读**
-   [Yue Shui《Scaling Laws》](https://syhya.github.io/zh/posts/2025-11-19-scaling-law/)——中文最佳单篇讲解，2026-06 更新过
-   [A Hitchhiker's Guide to Scaling Law Estimation](https://arxiv.org/abs/2410.11840)——回答"我需要几个模型"，结论：**5 个模型是安全下限，且它们可以很小；训多个不同尺寸的小模型好过训少数几个大模型**

> [!IMPORTANT]
> **✓ 阶段 4 过关标准**
> -   你的拟合代码能复现 Epoch AI 的 $\alpha=0.3478,\\ \beta=0.3658$
> -   你知道"Huber 平均 vs 求和"会让结果差多少（亲手试过）
> -   你能说出自己的实验需要几个点、跨多大范围（来自 Simulation Mode 的答案）
> **此时你的分析管线已经完全就绪**——阶段 5 只是给它喂自己的数据。

## 阶段 5 · 自己的实验第 10–12 周 · 45 小时

### 第 10 周：小规模打通15 小时 · 约 ¥15

先用极小规模把整条链路跑通，**不要一上来就烧钱**。

| 项 | 配置 |
| --- | --- |
| 数据 | [TinyStories](https://huggingface.co/datasets/roneneldan/TinyStories)，**字符级**（vocab ~100-200） |
| FLOP 预算 | 4 档：$1\times10^{14},\\ 3\times10^{14},\\ 1\times10^{15},\\ 3\times10^{15}$ |
| 每档模型数 | 7 个（d\_model 从 128 到 768） |
| 参数范围 | 约 0.3M – 6M |
| 总运行数 | 28 |
| 算力 | **< 1 GPU-小时**纯计算，含开销约 3 小时 |
| 成本 | **约 ¥10-15**，或本地 GPU 免费 |

> [!IMPORTANT]
> **为什么这一周用字符级**
> 两个原因，都很实际：
> -   **彻底消除 embedding 支配问题**：vocab=174 时 embedding 参数几乎为零，"N 怎么数"这个争议暂时消失，你可以专注于把流程跑通。
> -   **token 预算放大约 4 倍**：字符级下每字节≈1 token（BPE 约 4 字节/token），TinyStories 的有效 token 从 ~0.45B 变成 ~2B。
> 代价：loss 的绝对尺度和不可约项 $E$ 与文献不可比，**只能比指数**。但这一周本来就只是打通流程。  
> 这也正是 [MinChilla](https://github.com/BenAgro314/Minchilla) 的做法——它用 2 张 A5000 跑 12 小时，拟合出 $N\_{\text{opt}}\propto C^{0.48}$（Chinchilla 原文 0.49）。**你这一周基本就是在重跑它，可以直接对照它的 `saved_outputs/` 验证。**

**本周目标**：拟合出一个大致在 0.4–0.6 之间的指数，验证整条链路（训练 → 日志 → 拟合 → 画图）没有 bug。

> [!WARNING]
> **TinyStories 不能用于主实验**
> 我算了一下容量上限。IsoFLOP 每个预算档需要覆盖 $N\_{\text{opt}}/4$ 到 $4N\_{\text{opt}}$，最小模型那一臂的 token 需求是 $D\_{\max}\approx 7.3\sqrt{C}$。  
> TinyStories 单 epoch 约 4.7 亿 token（字符级约 20 亿）→ 反推 **$C \le 4.1\times10^{15}$**，对应 $N\_{\text{opt}}$ 只能从 0.9M 到 5.8M，**不到 1 个数量级**。指数拟合会非常不稳。  
> 所以第 11 周必须换数据集。

### 第 11–12 周：主实验30 小时 · 约 ¥350-500

#### 实验设计

| 项 | 配置 | 理由 |
| --- | --- | --- |
| **数据** | [FineWeb-Edu `sample-10BT`](https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu)（28.5 GB，约 100 亿 token） | 质量高、现代基线、ODC-By 许可。容量上限 $C\le 1.9\times10^{18}$，**恰好支撑到本实验的最大预算档** |
| **Tokenizer** | **自训 BPE，vocab = 16384，tie embeddings** | **本实验最关键的一个决定**。用 GPT-2 的 50257 会让 embedding 在小模型上支配一切（见第 6 周的警告框） |
| **架构** | LLaMA 式（RMSNorm + RoPE + SwiGLU），seq\_len 1024，$n\_{\text{head}}=d/64$，$n\_{\text{layer}}\approx d/64$ | 宽深比固定，保证"唯一变化的是规模" |
| **FLOP 预算** | 5 档：$10^{16},\\ 3\times10^{16},\\ 10^{17},\\ 3\times10^{17},\\ 10^{18}$ | 跨 2 个数量级 |
| **每档模型** | 7 个，log 间隔覆盖 $N\_{\text{opt}}/4 \to 4N\_{\text{opt}}$ | 网格**不要太宽**——见下方警告 |
| **N 跨度** | 2.3M → 365M（约 2.2 个数量级）；$N\_{\text{opt}}$ 跨度 9.1M → 91M | 足够拟合出可信区间 |
| **D 跨度** | 46M → 7.2B token，**全部单 epoch** | 避免引入数据重复这个额外变量 |
| **主实验运行数** | **35** |  |
| **Seed 运行** | +18（在 $10^{16}$ 和 $10^{17}$ 档，各取最靠近 $N\_{\text{opt}}$ 的 3 个尺寸 × 3 seed） | **这是为了估计噪声底**，额外算力 <5% |
| **总算力** | $1.01\times10^{19}$ FLOPs，约 405 亿 token |  |
| **GPU 时长** | 约 **73 小时**（RTX 4090） | ⚠️ 基于 50 TFLOP/s 有效吞吐的估算，**小模型 MFU 可能只有 15-25%，实际可能多 50%**。先跑一个中等 run 实测再定预算 |
| **成本** | **约 ¥350-500**（AutoDL 4090 @ ¥2.2/h） | 见 §7 |
| **墙钟时间** | 3-4 天单卡串行，或租 2-4 卡并行压到 1 天 |  |

#### 超参设置（这部分决定实验是否可信）

| 超参 | 设置 | 来源 / 理由 |
| --- | --- | --- |
| 学习率 | $\eta = 1.79\, N^{-0.713} D^{0.307}$ | Step Law（arXiv:2503.04715，3700 个模型拟合）。**不要对所有尺度用同一个 LR** |
| batch size | $B = 0.58\, D^{0.571}$ tokens | 同上。注意它**只依赖 $D$ 不依赖 $N$** |
| warmup | **总步数的 1.5%** | 不是固定步数。**这是 Kaplan 犯的错之一** |
| LR schedule | cosine 衰减到峰值的 0.1×，**horizon = 该 run 自己的 $D$** | 绝不能用长 run 的中间 checkpoint |
| AdamW | $\beta\_1=0.9$；$\beta\_2$ 在最小和最大尺寸各扫 $\{0.95, 0.98, 0.99\}$ 一次然后固定 | Porian et al. 发现**小 batch 下 $\beta\_2$ 必须调** |
| weight decay | 0.1，只给 2D 权重 |  |
| 梯度裁剪 | 先跑 100 步看 grad norm 分布再定 | 有实测显示 clip=1.0 会几乎每步都裁（过紧） |
| 精度 | **bf16 混合精度** + fp32 master weights | 不要用 fp16 |

> [!WARNING]
> **三个会毁掉实验的坑**
> **1\. IsoFLOP 网格不要太宽。** 有分析（arXiv:2603.22339，预印本）指出抛物线拟合有系统偏差：网格从 ±2× 加宽到 ±16×，误差从 1.7% 涨到 23%。**用 ±2–4×，并先粗扫一次定位最优点再细扫。**  
> **2\. 大模型偶尔不收敛。** MinChilla 的经验：必须先剔除高 loss 异常点再拟合，或直接用 RANSAC / Huber。**并且要报告你的 $\delta$ 值**——Epoch AI 指出 $\delta$ 的选择显著影响结果。  
> **3\. 不要用 Muon 优化器。** Karpathy 在 nanochat 的实验中发现，**Muon 下的最优参数:token 比约为 8:1，而不是 Chinchilla 的 20:1**——优化器会改变 scaling law 的结论。想复现 Chinchilla 就用 AdamW；想研究"现代配方下的 scaling law"才用 Muon，**并明确声明**。

> [!TIP]
> **一个能省一半算力的技巧（可选）**
> 传统做法：每个 $(C, N)$ 点独立从头训一次，同一个 $N$ 在 5 个预算档下要训 5 次。  
> 用 **WSD 调度**（warmup-stable-decay，见 [epfml/schedules-and-scaling](https://github.com/epfml/schedules-and-scaling)，NeurIPS 2024 Spotlight）：对每个 $N$ 只训**一条**到最大 $D$ 的 constant-LR run，在 $D\_1\lt D\_2\lt\dots\lt D\_5$ 处各分叉一个短 cooldown（占 20%）。**可省 50-60% 算力**，73 GPU-小时压到约 35 小时。  
> 代价：结果反映的是 WSD 而非 cosine 的 scaling law，与 Chinchilla 原文不完全可比。**建议两条都跑**：主实验用 cosine（可比），加一小组 WSD 做对照——"调度形式是否改变指数"本身就是个漂亮的结论。

#### 预期结果

| 量 | 你应该得到 | 参照 |
| --- | --- | --- |
| $a$（$N\_{\text{opt}}\propto C^a$） | **0.46 – 0.53** | Chinchilla A2: 0.49；MinChilla: 0.48 |
| $b$（$D\_{\text{opt}}\propto C^b$） | **0.47 – 0.54** | Chinchilla A2: 0.51；MinChilla: 0.52 |
| 最优 $D/N$ 比 | **15 – 30**（若超参处理得当） | Chinchilla: ~20 |
| $\alpha$（Approach 3） | 0.30 – 0.50 | Epoch 修正值 0.3478 |
| $\beta$ | 0.28 – 0.42 | Epoch 修正值 0.3658 |
| $E$（不可约损失） | **大概 2.2 – 2.9，不要期待 1.69** | $E$ 强依赖 tokenizer 和语料 |
| 外推误差 | 用 4 个低预算档拟合、预测第 5 档，**目标 <10%** | Hitchhiker's Guide: 最优 4%，可接受 5-20% |

> [!WARNING]
> **如果你看到 $D/N$ 随 $C$ 增大而漂移**
> 说明你可能忘了让 warmup 随规模缩放，或者没有逐尺度调 LR。**这正是 Kaplan 的病**——恭喜，你亲手复现了那个历史 bug。修掉它，然后把"修之前 vs 修之后"的对比写进报告，这比一条干净的曲线更有说服力。

### 实验报告该写什么

最后 5 小时写一份报告。**目标不是"得到正确答案"，而是"把过程说清楚"**——(Mis)Fitting 综述调查了 51 篇已发表的 scaling law 论文，发现**超过一半没有描述拟合流程**，**15 篇没说 FLOPs 和参数怎么数**。你把这些写清楚，透明度就已经超过一半的论文了。

#### 必须写的

1.  **方法**：参数怎么数（含/不含 embedding）、FLOPs 怎么算（$6ND$ 还是精确记账）、用了哪些 checkpoint、拟合流程（损失函数、$\delta$、优化器、初值网格）、CI 怎么来的
2.  **主结果**：IsoFLOP 曲线图、$N\_{\text{opt}}(C)$ 的 log-log 拟合、$a$ 和 $b$ 及其置信区间
3.  **外推验证**：留出最大预算档不参与拟合，报告预测误差

#### 更有价值的"副产品"（这些才是你真正学到东西的地方）

1.  **含/不含 embedding 数 $N$，指数差多少？**（预期在小尺度差异巨大，可能 0.05+）
2.  **朴素 $6ND$ vs 精确 FLOPs 记账，指数差多少？**
3.  **Approach 2 vs Approach 3 在同一份数据上给出的算力分配差多少？**（Open Athena 在 Llama 3 数据上报 6.5%）
4.  **同一配置 3-seed 的 loss 标准差是多少？** ← 这是你的**噪声底**，任何小于它的效应都不可信。**这一条最重要**，因为它给了你判断"什么结论可信"的标尺
5.  **warmup 固定步数 vs 按比例缩放，指数变化多少？**（直接复现 Porian et al. 的发现）

> [!IMPORTANT]
> **✓ 最终过关标准**
> -   一张你自己的 IsoFLOP 图
> -   一个带置信区间的 $a$ 值，落在 0.46-0.53
> -   一份说清了所有方法学选择的报告
> -   至少 3 个"副产品"结论
> **然后回去把 scaling law 笔记从头读一遍。** 这次你读的不再是"别人的结论"，而是"我知道他们是怎么得到这个结论的，也知道哪里可能出错"。

## 资源总表

### 主线材料（按使用顺序）

| 阶段 | 资源 | 链接 | 说明 |
| --- | --- | --- | --- |
| 1 | **《动手学深度学习》中文版** | [zh.d2l.ai](https://zh.d2l.ai/) · [论坛](https://discuss.d2l.ai/c/16) · [李沐 B 站视频](https://www.bilibili.com/video/BV18h411r7Z7/) | 免费。**只读 2,3,4,5,8,10,11 章 + 7.5/7.6**，其余全跳。中文版停更在 2022，定位是"深度学习基础"不是 LLM 教程 |
| 1 | **micrograd** | [GitHub](https://github.com/karpathy/micrograd) · [配套视频](https://youtu.be/VMj-3S1tku0) | 150 行。**必须自己从空文件写**，不要 clone 后读 |
| 1-2 | 《李宏毅深度学习教程》 | [GitHub](https://github.com/datawhalechina/leedl-tutorial)（16.6k star，2025-06 更新） | **只当查询工具**，卡壳时翻。强在直觉、弱在代码，与 d2l 互补 |
| 2 | **happy-llm** | [GitHub](https://github.com/datawhalechina/happy-llm)（32.3k star）· [在线](https://datawhalechina.github.io/happy-llm/) | 免费中文。第 1-5 章必读，**第 7 章 RAG/Agent 跳过** |
| 2 | 《从零构建大模型》中文版 | [豆瓣](https://book.douban.com/subject/37305124/) · [代码 97.4k star](https://github.com/rasbt/LLMs-from-scratch) | Raschka 原著，人邮 2025-04。**与 happy-llm 二选一**，或作为慢速补读 |
| 2 | 苏剑林 · 科学空间 | [位置编码综述](https://kexue.fm/archives/8130) · [RoPE](https://kexue.fm/archives/8265) | 难度 5/5。**只在手写完 attention 后读这两篇**，其余等阶段 5 |
| 3 | **nanoGPT** | [GitHub](https://github.com/karpathy/nanoGPT)（58.1k star） | 约 600 行。**已被作者标记废弃但对本任务仍是最优选**（理由见 §3 开头） |
| 3 | build-nanogpt | [GitHub](https://github.com/karpathy/build-nanogpt) | 按 commit 逐步构建，`git log` 就是教材 |
| 4 | **isoflop-experiments** | [HuggingFace](https://huggingface.co/datasets/open-athena/isoflop-experiments) | **107 KB**，814 行，聚合 5 篇论文的数据 |
| 4 | Gemstones | [GitHub](https://github.com/mcleish7/gemstone-scaling-laws) · [论文](https://arxiv.org/abs/2502.06857) | 需要的 143 KB 直接在仓库 `benchmarks/` 里。**不要下那个 142 GB 的 HF 缓存** |
| 4 | vpnls / chinchilla | [vpnls](https://github.com/Open-Athena/vpnls) · [chinchilla](https://github.com/kyo-takano/chinchilla) | 拟合工具。后者的 **Simulation Mode** 用于实验设计 |
| 4-5 | Lil'Log Scaling Laws Carefully | [链接](https://lilianweng.github.io/posts/2026-06-24-scaling-laws/) | 2026-06，最新方法论综述，**做实验前必读** |
| 4-5 | Yue Shui《Scaling Laws》 | [链接](https://syhya.github.io/zh/posts/2025-11-19-scaling-law/) | 中文最佳单篇讲解 |
| 5 | **MinChilla** | [GitHub](https://github.com/BenAgro314/Minchilla) | 2×A5000 / 12 小时复现出 $C^{0.48}$。**直接对照它的实验设计** |
| 5 | shehper/scaling\_laws | [GitHub](https://github.com/shehper/scaling_laws) | 基于 nanoGPT 复现 Kaplan，W&B 曲线全公开 |
| 5 | FineWeb-Edu sample-10BT | [HuggingFace](https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu) | 28.5 GB，约 100 亿 token，ODC-By 许可 |

### 明确不推荐（会浪费 100+ 小时）

| 不推荐 | 理由 |
| --- | --- |
| **LLM101n** | 仓库**已归档，课程从未发布**。作者原话："this course does not yet exist"。不要等它 |
| self-llm / llm-cookbook | 优秀但方向不对——它们是"用别人的模型"（部署/微调/API 应用），你要的是**训练侧** |
| llm.c | C/CUDA 实现，解决的是"不依赖 PyTorch"，与"理解神经网络"正交 |
| modded-nanogpt 跑通 | 需 8×H100 + Triton kernel。**改为阶段 3 后花 8 小时只读它的 record 演进日志**——那是观察"训练循环如何被逐步榨干"的最佳材料 |
| 《深度学习入门》（鱼书） | 与 d2l 第 2-5 章严重重叠，纯 NumPy 手写会延迟你上手 PyTorch |
| so-large-lm / 浙大《大模型基础》 | 前者纯理论综述无代码；后者重心在 Prompt/PEFT/RAG，恰好避开预训练与 scaling |
| CS336 Assignment 3 | ⚠️ **依赖斯坦福内网 API**（`hyperturing.stanford.edu:8000`，需学号），校外做不了。但[讲座视频](https://www.youtube.com/watch?v=Q15rhEWZPQ4)和作业 PDF 值得看 |
| B 站培训机构合集 | "748集""七天从小白到大神"这类。B 站只看两个来源：**李沐**和**李宏毅** |
| d2l 第 13、15 章（CV、NLP 应用） | 与目标无关 |

## 算力与预算

### 你需要什么显卡

| 参数量 | 模型+梯度+Adam 状态 | 激活（seq=1024） | 合计 |
| --- | --- | --- | --- |
| 1–20M | < 0.4 GB | < 1 GB | **< 2 GB** |
| 50M | 0.8 GB | ~2 GB | ~3 GB |
| 124M (GPT-2 small) | 2.0 GB | ~3 GB | ~5-6 GB |
| 200M | 3.2 GB | ~4 GB | ~8 GB |

-   **8 GB**（3060/4060 8G）：能跑完全部 1M–200M，代价是要用梯度累积
-   **12–16 GB**：舒适下限，无需 gradient checkpointing
-   **24 GB**（3090/4090/A5000）：**推荐配置**，能开大 batch，MFU 高
-   **Apple M 系列**：能跑，但吞吐比 4090 低一个数量级，**不建议做主实验**

### 租还是买

本项目全程用不到 500 卡时。一张 4090 整机新购的钱约等于 5000–7000 卡时租金。**租更划算**，除非你要长期做深度学习。

### 价格参考（2026-08 核实）

| 平台 | RTX 4090 | A100 40G | 备注 |
| --- | --- | --- | --- |
| **AutoDL**（大陆） | 约 ¥2.2/h | 约 ¥3.5/h | ⚠️ 价格页为 JS 渲染无法直接核实，数字来自第三方博客。**以官网算力市场实时价为准**。优点：直连、支付方便、有学术加速、按秒计费、无卡模式保留数据盘 |
| 恒源云（大陆） | ¥1.8–2.8/h | — | 同上，未官网核实 |
| RunPod（海外） | **0.69 美元/h** | 1.39 美元/h（80G） | ✅ 官网核实。H100 Community **1.99 美元/h**，每 FLOP 成本优于 4090 |
| Vast.ai（竞价） | 0.24–2.75 美元/h | 0.27–1.32 美元/h | 最便宜但方差极大，大陆有支付和网络问题 |

### 免费选项

| 平台 | GPU | 配额 | 适用性 |
| --- | --- | --- | --- |
| **百度 AI Studio** | V100 16G / 32G / A100 | 每日 8 算力点 ≈ **16 小时 V100-16G** | 免费选项里最实用。⚠️ 原生是 PaddlePaddle，装 PyTorch 需自己折腾，**2026 年是否开箱支持未核实** |
| 阿里云 PAI-DSW | A10 / V100 | 250 CU/月 × 3 个月 ≈ A10 约 36 h/月 | ✅ 官方核实。适合阶段 1-3 |
| Kaggle | P100 / T4×2 | 约 30 h/周 | 需代理。**T4 没有 bf16**，会遇到 fp16 稳定性问题 |
| Colab 免费版 | T4 | 无硬配额，动态限流，**最长 12 h** | 需代理 + 断连风险 + 无 bf16。**不建议做主实验** |

### 本方案的推荐组合

1.  **第 0–8 周：零成本。** 本地 CPU 或任意 GPU，或百度 AI Studio。这个阶段**不要花钱**。
2.  **第 9 周：零成本。** 拟合练习只需要 CPU。
3.  **第 10 周：约 ¥15。** AutoDL 4090 按量，3 小时。
4.  **第 11–12 周：约 ¥350–500。** AutoDL 4090，约 73–110 小时（留 1.5 倍缓冲）。若能用海外平台，RunPod H100 @ 1.99 美元/h 每 FLOP 成本更低。

> [!WARNING]
> **不要为本任务租多卡**
> 1M–200M 单卡 24G 完全装得下。DDP/FSDP 只会引入通信 bug 和不可复现性。**唯一合理的多卡用法是"同时跑多个独立的单卡实验"**——这是 embarrassingly parallel，不需要任何分布式代码。

## 中国大陆环境配置

#### HuggingFace（2026-08 核实 hf-mirror 正常）

```
export HF_ENDPOINT=https://hf-mirror.com
pip install -U "huggingface_hub[hf_transfer]" hf_transfer
export HF_TRANSFER=1

# 注意：CLI 命令已从 huggingface-cli 改名为 hf
hf download HuggingFaceFW/fineweb-edu --repo-type dataset \
    --include "sample/10BT/*" --local-dir ./data/fineweb-edu-10BT
```

限制：**hf-mirror 不支持登录**，gated repo（如 Llama 系列）需要去官网申请 token。**对本方案无影响**——FineWeb-Edu、TinyStories 都不是 gated。

替代：**ModelScope（魔搭）**国内直连最稳，若数据集在魔搭有镜像优先用它。

#### pip / conda

```
pip config set global.index-url https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple
```

**建议用 miniforge + conda-forge，或直接 uv/venv + pip**，规避 Anaconda 商业授权的不确定性。

#### GitHub

```
# URL 前缀代理（准备 2-3 个备用，域名经常挂）
git clone https://gh-proxy.com/https://github.com/karpathy/nanoGPT.git
git clone https://ghfast.top/https://github.com/karpathy/nanoGPT.git
git clone https://hub.gitmirror.com/https://github.com/karpathy/nanoGPT.git
```

实际影响很小——nanoGPT 这些仓库只有几 MB，真正的大流量是数据集和 PyTorch 轮子。

#### 云平台学术加速

AutoDL 等平台提供临时代理开关（`source /etc/network_turbo` 一类，**具体命令随版本变化**），开了之后 HF/GitHub 直连可用。租卡时先看平台文档的"学术资源加速"页。

## 踩坑速查

### loss 不降

| 症状 | 原因 | 排查 |
| --- | --- | --- |
| loss 卡在 $\ln(V)$ 附近（GPT-2 词表 ≈ 10.8） | LR 太小、优化器没接上参数、label 错位、梯度没回传 | **先做 overfit 单 batch 测试**：拿 1 个 batch 反复训 200 步，loss 应降到接近 0。**降不下去 = 100% 是代码 bug，不是超参问题** |
| loss 降但明显高于同规模公开结果 | label shift 错误、mask 不是因果的、tokenizer 不匹配 | 打印一条样本的 `decode(x)` 和 `decode(y)`，肉眼确认 y 是 x 右移一位 |
| 前期正常，中后期停滞 | LR 调度错了、weight decay 过大 | **把 LR 曲线也 log 出来**。这是最容易被忽略、也最容易出错的一条线 |
| MFU < 10% | dataloader 瓶颈、batch 太小、没开 AMP | 把 dataloader 换成常量 tensor 对比吞吐 |

### NaN / loss 爆炸

1.  **首选 bf16 而非 fp16**——最有效的一招
2.  梯度裁剪（先测 grad norm 分布再定阈值）
3.  训练循环里加 `torch.isfinite(loss)` 检测，一旦触发就 dump batch 索引、grad norm、各层参数范数。事后回放那个 batch 常能定位到脏数据（全空白文档、超长重复字符）
4.  反复爆炸可考虑加 QK-norm（2024-2026 主流的结构性稳定方案）
5.  降 LR / 拉长 warmup 是**最后手段**——会破坏跨尺度可比性

### 显存问题

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| 训练几百步后才 OOM | log 里累加了带梯度的 tensor（`total_loss += loss`） | 所有 log 量一律 `.item()` 或 `.detach()` |
| eval 时显存增长 | 忘了 `torch.no_grad()` / `model.eval()` | 加上 |
| 碎片化 OOM（显示有空闲但分配失败） | 变长 seq 触发分配器碎片 | `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |

### 数据问题

-   **验证集切分要在文档级、去重之后做。** 先切分后去重会让重复文档同时出现在 train 和 val，val loss 假性偏低
-   **整套 scaling 实验必须锁死同一个数据源、同一次预处理产物。** 相同 token 数不等于相同数据
-   数据盘规划：4B token 的 uint16 `.bin` 约 8 GB，FineWeb-Edu sample-10BT tokenize 后约 20 GB。**别放系统盘**

## 常见疑问

#### 12 周太长了，能压缩吗？

能，但要牺牲东西。最激进的压缩：跳过阶段 1 的 d2l（直接从 micrograd + Raschka 开始），阶段 5 只做第 10 周的小规模实验。这样约 **7 周**，代价是你对优化器和正则化的理解会比较薄，遇到 loss 不降时排查会慢很多。

不建议压缩的两处：**micrograd 那 7 小时**和**阶段 4 的拟合练习**。它们的时间收益率最高。

#### 我可以不训练，只用公开数据做拟合吗？

可以，而且那就是阶段 4——**一周时间、零成本，你就能拟合出真实的 scaling law**。如果你的目标只是"理解并会用 scaling law"，做完阶段 4 其实已经够了。

阶段 5 的额外价值在于：**你会亲身遇到那些论文里一笔带过的问题**——大模型不收敛、LR 没调好导致曲线歪掉、warmup 设错让指数偏移。这些经历会让你在读任何 scaling 论文时都多一层怀疑。

#### 笔记 §6（Test-time 与 RL scaling）怎么学？

不在本方案范围内，因为它需要额外的 RL 基础。建议路径：先完成本方案 → 读 [DeepSeek-R1 论文](https://arxiv.org/abs/2501.12948)（写得很清楚）→ 学 GRPO/PPO 的基本原理 → 再读笔记 §6。大约额外 4-6 周。

如果只是想读懂而不动手，学完本方案的阶段 3 之后直接读 §6 也能懂七八成。

#### 我该不该用 nanochat 而不是 nanoGPT？

阶段 3 用 nanoGPT（理由见 §3 开头）。但如果你完成了全部 12 周还有余力，**租 8×H100 打一次 nanochat 的完整 speedrun 很值得**——官方数据是 **48 美元（约 2 小时）达到 GPT-2 水平**，spot 实例可压到约 15 美元。它覆盖 tokenizer → 预训练 → SFT → RL → 推理 → WebUI 全链路，最后能和自己训的模型对话。

**但一定放在最后做**：在此之前做它，你只是在跑别人的 shell 脚本；在此之后做它，8,304 行里每一行你都看得懂。

#### 如果中途卡住了怎么办？

-   **概念卡住**：d2l 论坛（至今活跃）、李宏毅教程对应章节、happy-llm 的 issue
-   **代码卡住**：nanoGPT 有 10k fork，搜 issue 再搜 fork，大概率有人修过
-   **实验卡住**：对照 MinChilla 和 shehper/scaling\_laws 的公开配置与 W&B 曲线
-   **进度落后**：优先保证阶段 1、3、4 的质量，阶段 2 和 5 可以缩水。**地基和方法论比产出更重要**

**关于这份方案的可信度**：所有链接、star 数、价格都在 2026 年 8 月核实过。少数未能直接核实的（AutoDL 实时价格、百度 AI Studio 对 PyTorch 的当前支持、部分仓库的最后提交日期）已在正文标注。**GPU 吞吐估算（50 TFLOP/s）是估计值而非实测**——小模型 MFU 可能只有 15-25%，建议在第 11 周先跑一个中等规模的 run 实测，再确定总预算。

三个可能与你在别处看到的说法不同的地方：**nanoGPT 已被作者标记废弃**（但对本任务仍是最优选）；**LLM101n 已归档且从未发布**（不要等）；**CS336 的 scaling 作业依赖斯坦福内网 API**（校外做不了，本方案用自建实验替代）。