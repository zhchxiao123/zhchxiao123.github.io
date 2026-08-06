---
layout: post
title: "大模型 Scaling Law 学习笔记"
date: 2026-08-06 12:00:00 +0800
categories: [AI, 深度学习, Scaling Law]
tags: [Scaling Law, LLM, 学习笔记, 工程实践]
description: 工程实践导向 · 含公式推导、拟合系数、方法学陷阱与决策清单 · 素材截至 2026 年 8 月
math: true
---

> 这是一份工程实践导向的 Scaling Law 学习笔记，覆盖经典训练律、数据受限与推理侧、MoE/架构/超参/多模态、Test-time 与 RL Scaling，以及工程决策手册。配套 12 周学习方案见 [从零到能跑 Scaling Law 实验](/posts/scaling-law-12-week-learning-plan/)。

## 0 · 怎么读这份笔记

这份笔记的组织方式是：**先把 Chinchilla 那套"默认世界观"讲透，再逐个拆掉它的假设**。Chinchilla 隐含四个前提——数据无限、只算训练算力、稠密模型 BF16、模型训完就不动了。现代的每一个 scaling law 分支，本质上都是在破其中一条：

| 被破掉的假设 | 新出现的分支 | 本笔记章节 |
| --- | --- | --- |
| 数据无限 | 数据受限 scaling、重复训练、数据配比律 | §4.1–4.3 |
| 只算训练算力 | 推理成本感知、过训练、蒸馏 | §4.4–4.5 |
| 稠密 + 全精度 | MoE、稀疏、量化 scaling law | §4.6–4.7, §5.1–5.2 |
| 训完就不动 | RL scaling、test-time compute | §6 |

三条阅读路径，按你的目的选：

-   **只想快速建立框架**：§1 → §2.2–2.3 → §2.4 → §7 决策手册。约 30 分钟。
-   **要动手拟一条自己的 scaling law**：§1 → §2.3 → **§3 全章**（这是本笔记最实操的部分）→ §5.4 超参外推。
-   **要做训练/推理的资源决策**：§2.3 → §4 全章 → §5.2 → §6.9 → §7。

> [!WARNING]
> **关于数值可信度**
> 本笔记中的拟合系数均标注了出处论文。凡我在核查中发现**与流行转述不符**的地方（有三处：Kaplan/Chinchilla 差异的归因、Tay 关于架构的结论、Chinchilla Approach 3 的可靠性），都在正文用醒目框单独标出。少数未能逐字核到原文的数值已标 ⚠️。跨论文的绝对数值**不可直接比较**——它们依赖各自的 tokenizer、数据集、损失定义；能比较的只有结构和指数。

## 1 · 地基：记号、C=6ND、以及幂律从哪来

### 1.1 三个变量与算力公式

| 符号 | 含义 | 踩坑提示 |
| --- | --- | --- |
| $N$ | 模型参数量 | **含不含 embedding 是历史上最大的口径分歧**，见 §2.4 |
| $D$ | 训练 token 数 | 唯一 token 还是含重复？§4.1 会区分 $D$ 与 $U\_D$ |
| $C$ | 训练算力 (FLOPs) | Kaplan 用 PF-days，$1\text{ PF-day}\approx 8.64\times10^{19}$ FLOPs |
| $L$ | 交叉熵损失 (nats/token) | 换底：$\text{bits} = L/\ln 2$；困惑度 $\mathrm{PP}=e^{L}$ |
| $B, S$ | batch size (tokens)、优化步数 | $D = B\cdot S$ |

核心的算力恒等式：

$$C \approx 6ND$$

推导很简单：一个参数在前向传播中参与一次乘加（2 FLOPs），反向传播需要算激活梯度和权重梯度两次（4 FLOPs），合计每参数每 token 6 FLOPs。**推理只有前向**，所以推理是 $2N$ per token——这个 6:2 的比例是 §4.4 全部推理感知优化的出发点。

> [!WARNING]
> **$C=6ND$ 什么时候会骗你**
> 它忽略了注意力的 $O(L\_{\text{ctx}}\cdot d)$ 项。上下文短时可忽略，但长上下文（32K+）或小模型大上下文时误差显著。DeepSeek 的做法是直接用**每 token 的非嵌入 FLOPs $M$** 替代 $6N$，令 $C = M\cdot D$——如果你要在长上下文设定下拟合 scaling law，这是必须做的替换。

### 1.2 幂律从哪来：一个够用的直觉

不需要完整理论也能建立正确直觉。最简洁的一个模型（Hutter 2021 / Levi 2024 一系）是：**假设知识/技能的出现频率服从 Zipf 分布**，第 $i$ 个知识点的频率 $\theta\_i \propto i^{-(1+\alpha)}$。模型容量或数据量增加 $k$ 倍，你多覆盖的是频率更低的长尾；由于长尾按幂律衰减，覆盖增益也按幂律衰减 → loss 呈幂律下降。

这个视角能解释三个实际现象：

-   **为什么有不可约项 $E$**：自然语言本身有熵，再多的参数也压不到 0。Chinchilla 拟合出 $E\approx1.69$（Besiroglu 修正为 $\approx1.82$）。
-   **为什么指数这么小**（$\alpha\approx0.3$）：长尾极长。算力翻 10 倍，loss 只降几个百分点——这是 scaling 昂贵的根本原因。
-   **为什么会有"涌现"的错觉**：如果某能力需要连对 $L$ 个 token，准确率 $\approx p^L$，底层 $p$ 平滑上升会在 accuracy 上表现为陡峭跃升。见 §2.6。

> **Hestness 2017 的元结论，至今没被推翻**：架构与优化器的改进主要**平移截距**，很少改变**幂律指数**。这就是为什么"算力是长期主线"——一个改进如果只降常数，收益是一次性的；如果能改指数，那才是范式级的。§5.3 会给出这条规律的边界与反例。

## 2 · 经典训练 Scaling Law

### 2.1 前史：可加分离形式是怎么来的（2017–2019）

**Hestness et al. 2017**, *Deep Learning Scaling is Predictable, Empirically* · Baidu SVAIL · [arXiv:1712.00409](https://arxiv.org/abs/1712.00409)

横跨机器翻译、语言建模、图像分类、语音识别四个域，验证 $\varepsilon(m)\propto \alpha m^{\beta\_g}$，实测 $\beta\_g\in[-0.35, -0.07]$——**显著比理论预言的 $-0.5\sim-1.0$ 平缓**，至今没有令人满意的理论解释。它确立了学习曲线的三段论：小数据随机区 → 幂律区 → 不可约误差平台。

**Rosenfeld et al. 2019**, *A Constructive Prediction of the Generalization Error Across Scales* · [arXiv:1909.12673](https://arxiv.org/abs/1909.12673) (ICLR 2020)

这篇给出了 Chinchilla 三年后所用形式的**原型**：

$$\tilde\varepsilon(m,n) = a\,n^{-\alpha} + b\,m^{-\beta} + c\_\infty$$

即"模型规模项 + 数据规模项 + 不可约项"的**可加分离**结构。其外推能力已经相当好：从 1/16 模型规模 + 1/8 数据量外推，WikiText-103 上误差约 0.5%。

### 2.2 Kaplan et al. 2020：三条律与"大模型优先"路线

必读**Kaplan, McCandlish, Henighan, Brown, Chess, Child, Gray, Radford, Wu, Amodei 2020**, *Scaling Laws for Neural Language Models* · OpenAI · [arXiv:2001.08361](https://arxiv.org/abs/2001.08361)

实验设置：WebText2，context 1024，**非嵌入参数 768 → 1.5B**，数据 22M → 23B tokens，3000 步线性 warmup + cosine decay。

> [!IMPORTANT]
> **$N$ 的定义（后来引发全部争议的一行）**
> 原文：*"$N$ – the number of model parameters, **excluding all vocabulary and positional embeddings**"*，即 $N\approx 12\,n\_{\text{layer}}\,d\_{\text{model}}^2$。算力也按同一口径算 $C\approx 6NBS$，**没有计入解码层（unembedding）的 FLOPs**。

#### 三条主律

$$L(N)=\left(\frac{N\_c}{N}\right)^{\alpha\_N},\quad \alpha\_N\approx 0.076,\\ N\_c\approx 8.8\times10^{13}$$ $$L(D)=\left(\frac{D\_c}{D}\right)^{\alpha\_D},\quad \alpha\_D\approx 0.095,\\ D\_c\approx 5.4\times10^{13}\\ \text{tokens}$$ $$L(C\_{\min})=\left(\frac{C\_c^{\min}}{C\_{\min}}\right)^{\alpha\_C^{\min}},\quad \alpha\_C^{\min}\approx 0.050$$
> [!WARNING]
> **$L(C)$ 和 $L(C_{\min})$ 是两条不同的律**
> $L(C)$（指数 0.057）是"实际跑出来的、batch 未调优"的曲线；$L(C\_{\min})$（指数 0.050）是"把 batch 调到临界值后的理想串行算力"。引用 Kaplan 的算力指数时先确认是哪一条。

#### 联合形式与临界 batch size

$$L(N,D)=\left[\left(\frac{N\_c}{N}\right)^{\alpha\_N/\alpha\_D}+\frac{D\_c}{D}\right]^{\alpha\_D}$$

注意这是**乘性耦合、且没有不可约项 $E$** 的形式——与 Chinchilla 的可加形式在数学上本质不同，这是两篇论文外推行为分道扬镳的一个独立根源（除了 §2.4 讲的实验设计问题之外）。

$$B\_{\text{crit}}(L)=\frac{B\_\*}{L^{1/\alpha\_B}},\quad B\_\*\approx 2\times10^8\\ \text{tokens},\\ \alpha\_B\approx 0.21$$

$B\_{\text{crit}}$ 只是 loss 的函数，不直接依赖 $N$ 或 $D$。低于它增大 batch 近似线性省时间；高于它只省步数不省算力。源头是 McCandlish et al. 2018 的梯度噪声尺度（见 §5.4.3）。

#### 计算最优配置：一切争议的焦点

$$N\propto C\_{\min}^{0.73},\quad B\propto C\_{\min}^{0.24},\quad S\propto C\_{\min}^{0.03},\quad D\propto C^{0.27}$$

工程含义：**算力 ×10 → 模型 ×5.5，数据仅 ×1.8，步数几乎不变**。$S\propto C^{0.03}$ 是最反直觉的一条——它说"训练步数基本恒定，增量全部投给模型和 batch"。这直接催生了 2020–2022 年的"堆参数"路线：GPT-3 175B/300B tokens、Gopher 280B/300B tokens、MT-NLG 530B/270B tokens，全部卡在 300B token 附近。

### 2.3 Chinchilla 2022：等比例扩展与 20 tokens/param

必读**Hoffmann, Borgeaud, Mensch, ..., Sifre 2022**, *Training Compute-Optimal Large Language Models* · DeepMind · [arXiv:2203.15556](https://arxiv.org/abs/2203.15556) (NeurIPS 2022) · **400+ 模型**，70M→16B+ 参数，5B→500B tokens

#### 三种独立估计方法

1.  **Approach 1 · 训练曲线包络**：固定模型族，每个模型用 4 种不同的训练 token 数（跨度 16×），**每条曲线的 LR schedule 都与该次运行的 token 数匹配**（10× 衰减到底）。对 loss-vs-FLOPs 曲线取下包络。
2.  **Approach 2 · IsoFLOP 剖面**：固定 9 个算力预算（$6\times10^{18}\to3\times10^{21}$ FLOPs），每个预算下变模型规模，对每条 IsoFLOP 曲线在 log 空间拟合抛物线，取顶点。
3.  **Approach 3 · 参数化拟合**：直接拟合损失曲面。

$$\boxed{\;\hat L(N,D) = E + \frac{A}{N^\alpha} + \frac{B}{D^\beta}\;}$$

物理解释：$E$ = 自然语言熵；$A/N^\alpha$ = 有限容量的近似误差；$B/D^\beta$ = 有限数据 + 单 epoch 未收敛的优化误差。

#### 拟合系数（Approach 3）

| $E$ | $A$ | $B$ | $\alpha$ | $\beta$ |
| --- | --- | --- | --- | --- |
| 1.69 (1.6934) | 406.4 | 410.7 | 0.34 (0.3392) | 0.28 (0.2849) |

#### 闭式最优解

在约束 $C\approx 6ND$ 下最小化 $\hat L$：

$$N\_{\text{opt}}(C)=G\left(\frac{C}{6}\right)^{a},\quad D\_{\text{opt}}(C)=G^{-1}\left(\frac{C}{6}\right)^{b},\quad G=\left(\frac{\alpha A}{\beta B}\right)^{\frac{1}{\alpha+\beta}}$$ $$a=\frac{\beta}{\alpha+\beta},\qquad b=\frac{\alpha}{\alpha+\beta}$$

这个推导值得自己做一遍（拉格朗日乘子，或直接代入 $D=C/6N$ 对 $N$ 求导），它是整套理论的数学核心：**$a$ 和 $b$ 完全由两个指数 $\alpha,\beta$ 的相对大小决定，与 $A,B,E$ 无关**。

> [!WARNING]
> **$\alpha\neq\beta$ 就意味着 20:1 不是常数**
> $$\frac{D\_{\text{opt}}}{N\_{\text{opt}}}\propto C^{\frac{\alpha-\beta}{\alpha+\beta}} = C^{0.097}\quad(\text{用 }\alpha=0.34,\beta=0.28)$$ 也就是说，Approach 3 的参数**自相矛盾地**暗示 tokens/param 随算力上升，而论文自己主张的是固定 20:1、等比例扩展。这个内部矛盾正是 §2.5 争议的靶心。

#### 三种方法给出的指数

| 方法 | $a$（$N\_{\text{opt}}\propto C^a$） | $b$（$D\_{\text{opt}}\propto C^b$） |
| --- | --- | --- |
| 1\. 训练曲线包络 | 0.50 (0.488, 0.502) | 0.50 (0.501, 0.512) |
| 2\. IsoFLOP 剖面 | 0.49 (0.462, 0.534) | 0.51 (0.483, 0.529) |
| 3\. 参数化拟合 | 0.46 (0.454, 0.455) | 0.54 (0.542, 0.543) |
| *对照：Kaplan 2020* | *0.73* | *0.27* |

两处当时就该被追问的异常：Approach 3 的置信区间窄到宽度 0.001；Approach 1 的 $b$ 点估计 0.50 竟落在自己 CI (0.501, 0.512) **之外**。

#### 结论与验证

| 参数量 | FLOPs | 最优 tokens | $D/N$ |
| --- | --- | --- | --- |
| 400M | 1.92e19 | 8.0B | 20.0 |
| 1B | 1.21e20 | 20.2B | 20.2 |
| 10B | 1.23e22 | 205.1B | 20.5 |
| **67B** | **5.76e23**（= Gopher 算力） | **1.5T** | 22.4 |
| 175B | 3.85e24 | 3.7T | 21.1 |
| 280B | 9.90e24 | 5.9T | 21.1 |

原文表述：*"for every doubling of model size the number of training tokens should also be doubled"*。Gopher 推论：同算力下最优模型应该**小 4 倍、数据多 4 倍**（280B/300B → 67B/1.4T）。

**验证**：Chinchilla 70B / 1.4T tokens，与 Gopher 280B 同算力，MMLU 达 67.5%（比 Gopher 高 7+ 点），并全面超过 GPT-3 (175B)、Jurassic-1 (178B)、MT-NLG (530B)。这是 scaling law 历史上最漂亮的一次预注册式验证。

⚠️ 一个少被提及的细节：Approach 1/2 给出的 Gopher-最优规模是 **67B**，而 Approach 3 给的是 **40B**。这个 67 vs 40 的分歧本身就是 Approach 3 有问题的早期信号。

### 2.4 0.73 vs 0.50 之谜：真正的原因是什么

> [!WARNING]
> **需要更正一个流行说法**
> 网上最常见的解释是"Kaplan 用了固定 horizon 的 cosine schedule，导致短 run 的 loss 被高估，所以偏向大模型"。这个机制**真实存在**，但 2024 年的两项专门研究都表明它**不是主因**。Porian et al. 明确写道：LR decay 匹配 token 数 *"is not essential for the Hoffmann et al. scaling law to emerge"*。

**Pearce & Song 2024**, *Reconciling Kaplan and Chinchilla Scaling Laws* · [arXiv:2406.12907](https://arxiv.org/abs/2406.12907)

归因：**Kaplan 数的是非嵌入参数而非总参数，加上实验只在小尺度进行**。在小模型上 embedding 可占参数量的一半以上，随规模增大占比才下降——用非嵌入口径拟合会系统性**高估** $N$ 的指数。他们把 Chinchilla 的实验在 Kaplan 的条件下重跑，复现出了接近 0.73 的偏差系数。

**Porian, Wortsman, Jitsev, Schmidt, Carmon 2024**, *Resolving Discrepancies in Compute-Optimal Scaling of Language Models* · [arXiv:2406.19146](https://arxiv.org/abs/2406.19146) (NeurIPS 2024)

识别出三个因素，**逐个修正后指数从 0.73 单调走到 0.50**：

1.  **未计入解码层（unembedding）的 FLOPs**——Hoffmann 计入，Kaplan 未计入。修正后 token/param 比值趋于常数。
2.  **warmup 固定 3000 步**——对小模型而言过长，人为压低小模型表现，让曲线偏向"大模型更划算"。让 warmup 随规模缩放后指数进一步下移。
3.  **优化器超参未按规模逐点调优**——对每个规模单独调 LR、batch size、AdamW $\beta\_2$ 后，最终落到 $\approx 0.50$。

> [!TIP]
> **这件事的真正教训**
> scaling law 的指数**极度敏感于实验设计**。三个看起来"只是细节"的选择（参数怎么数、FLOPs 怎么算、warmup 怎么设）加起来把指数从 0.50 推到了 0.73——而 0.73 让整个行业花了两年时间训练严重欠训练的模型。所以 §3 的坑清单不是学术洁癖，是真金白银。

### 2.5 Chinchilla 的复现争议：Approach 3 到底错在哪

**Besiroglu, Erdil, Barnett, You 2024**, *Chinchilla Scaling: A replication attempt* · Epoch AI · [arXiv:2404.10102](https://arxiv.org/abs/2404.10102)

做法：从 Hoffmann 论文 Figure 4 中**数字化提取**约 400 个 run 的 $(N,D,L)$ 点，重跑 Approach 3。

| 参数 | Besiroglu 再拟合 (SE) | Hoffmann 原报告 |
| --- | --- | --- |
| $E$ | **1.8172** (0.03) | 1.6934 |
| $A$ | 482.01 (124.58) | 406.4 |
| $B$ | 2085.43 (1293.23) | 410.7 |
| $\alpha$ | 0.3478 (0.02) | 0.3392 |
| $\beta$ | **0.3658** (0.02) | 0.2849 |

$\chi^2$ 检验 p-value $<10^{-51}$。推得 $a = \beta/(\alpha+\beta) = \mathbf{0.5126}$ (SE 0.02)，$b=0.4874$ ——**等比例扩展，与 Approach 1/2 完全一致**。

#### 三条技术指控

1.  **Huber loss 取平均而非求和**：目标函数尺度缩小约 400 倍，与 $\delta=10^{-3}$ 组合后 **L-BFGS 在收敛前就触发了终止判据**。这是最实用的一条教训——鲁棒损失的阈值必须与目标函数的量级匹配。
2.  **系数舍入偏差**：$\beta$ 真值 0.2849 报告成 0.28，引入约 13% 的正偏差。
3.  **置信区间不可信**：*"obtaining such tight intervals would require over 600,000 experiments, while they likely only ran fewer than 500."*

> [!IMPORTANT]
> **结论的方向可能与你预期相反**
> 这项工作**不是推翻 Chinchilla，而是加固了它**。修正后 $\alpha\approx\beta$（0.3478 vs 0.3658），于是 $D/N$ 变得**与尺度无关**，Approach 3 与 Approach 1/2 及 Chinchilla 的实际训练配方三者终于自洽。20 tokens/param 因此更可信了（其 CI 大致覆盖 4 到 40）。  
> 但有一个实质性修正：**不可约损失 $E$ 从 1.69 上修到 1.82**。这对"loss 还能降到多少"的长期外推有直接影响——你能榨取的空间比 Chinchilla 原文暗示的要少。

### 2.6 涌现能力与下游任务：loss 之外的世界

#### 三方论战

**Wei et al. 2022**, *Emergent Abilities of Large Language Models* · [arXiv:2206.07682](https://arxiv.org/abs/2206.07682) (TMLR)

定义："某能力在小模型上不存在、在大模型上存在，因而无法通过外推小模型来预测。" 给出阈值表：3 位数加减法在 2.3e22 FLOPs (13B) 出现，MMLU 在 3.1e23 (175B)，TruthfulQA 在 5.0e23 (280B)，WiC 在 2.5e24 (540B)，CoT 数学在 1.3e23 (68B)。

**Schaeffer, Miranda, Koyejo 2023**, *Are Emergent Abilities of LLMs a Mirage?* · [arXiv:2304.15004](https://arxiv.org/abs/2304.15004) (NeurIPS 2023 Outstanding Paper)

核心论证：设 per-token 交叉熵平滑改善 $\mathcal{L}\_{\text{CE}}(N)=(N/c)^{\alpha}$，单 token 正确概率 $p=\exp(-\mathcal{L}\_{\text{CE}})$。对需要连续输出 $L$ 个 token 才算对的任务：

$$\text{Accuracy}(N)\approx p^{\,L}=\exp\!\left(-L\left(\tfrac{N}{c}\right)^{\alpha}\right) \qquad\text{vs}\qquad \text{TokenEditDist}(N)\approx L\left(1-e^{-(N/c)^{\alpha}}\right)$$

Accuracy 对底层平滑量做了 $L$ 次幂 → 几何式压缩 → log 轴上表现为"突变"；Token Edit Distance 近似线性 → 平滑。第二个机制是**统计分辨率不足**：评测样本太少时小模型的真实非零准确率被测成 0。他们还在视觉模型上人为构造出了涌现现象。

推荐**Du, Zeng, Dong, Tang 2024**, *Understanding Emergent Abilities of Language Models from the Loss Perspective* · [arXiv:2403.15796](https://arxiv.org/abs/2403.15796)

这篇很好地调和了前两者。不看规模、改看**预训练 loss**：

> "Transformer models with the same pre-training loss, but different model and data sizes, generate the same performance on various downstream tasks."  
> "a model exhibits emergent abilities on certain tasks — **regardless of the continuity of metrics** — when its pre-training loss falls below a specific threshold."

具体数值：MMLU / C-Eval / GSM8K 上，300M–32B 的全部模型在 pre-training loss 降到 **约 2.2** 之前都停留在随机水平，之后才开始爬升。

> [!IMPORTANT]
> **三方论战的收敛判断**
> 涌现阈值**确实存在，但定义在 loss 上而非规模上**。这既解释了 Wei 观察到的现象（真实的），也解释了为什么"规模阈值"在不同模型间不稳定（不同模型达到同一 loss 所需规模不同）；同时 Du 的结论在连续度量下也成立，构成对 Schaeffer 的直接反驳。  
> Schaeffer 的贡献仍然成立且重要：**度量的选择会制造或消除锐利性**。但反方也有理——用户关心的*就是* exact-match 这类离散度量，所以"度量的产物"在产品意义上仍是真实的相变。

#### 下游任务怎么预测：目前最实用的两条路径

**Ruan, Maddison, Hashimoto 2024**, *Observational Scaling Laws* · [arXiv:2405.10938](https://arxiv.org/abs/2405.10938)

**不训练任何模型**，从约 100 个公开模型的 benchmark 分数出发：对 metric 矩阵做 PCA 抽出低维"能力空间"（约 3 维即可），假设不同模型家族只在"把算力转换为能力的效率系数"上有差异。结果：**多个涌现现象变成对能力维度的平滑 sigmoid，可从小模型预测**；GPT-4 级模型的 agent 性能可由非 agentic benchmark 精确预测；CoT、Self-Consistency 等 post-training 干预的收益也可预测。

**Gadre et al. 2024**, *Language models scale reliably with over-training and on downstream tasks* · [arXiv:2403.08540](https://arxiv.org/abs/2403.08540)

$$\mathrm{Err}(L)=\epsilon - k\,e^{-\gamma L}\qquad\Longleftrightarrow\qquad \mathrm{Err}(\mathrm{PP})=\epsilon-k\,\mathrm{PP}^{-\gamma}$$

用指数形式把 loss 映射到平均 top-1 错误率。104 个模型的 testbed 上，用 **20× 更少算力**预测出 6.9B 模型在 17 个下游任务上的平均错误率。

> [!TIP]
> **实践建议**
> 不要直接拟合 "算力 → 下游准确率"。正确的两段式是：**(1) 算力/规模 → loss（干净的幂律）；(2) loss → 下游 metric（sigmoid 或指数形式）**。前者稳定，后者任务相关。把两段分开拟合，比端到端拟合稳健得多。

### 2.7 更复杂的函数形式：什么时候幂律不够用

**Caballero, Gupta, Rish, Krueger 2022**, *Broken Neural Scaling Laws* · [arXiv:2210.14891](https://arxiv.org/abs/2210.14891) (ICLR 2023)

$$y = a + \left(b\,x^{-c\_0}\right)\prod\_{i=1}^{n}\left(1+\left(\frac{x}{d\_i}\right)^{1/f\_i}\right)^{-c\_i f\_i}$$

| 参数 | 含义 |
| --- | --- |
| $n$ | log-log 图上"平滑转折"的个数（$n+1$ 段近似线性区） |
| $a$ | 不可约项：$x\to\infty$ 时 $y$ 的极限 |
| $c\_0$ | 第一段的斜率 |
| $c\_i$ | 第 $i$ 段与第 $i{+}1$ 段的**斜率差** |
| $d\_i$ | 第 $i$ 个转折在 $x$ 轴的位置 |
| $f\_i$ | 转折的锐利度（越小越尖锐） |

参数量 $3+3n$；$n=0$ 退化为标准幂律 + 常数。能表达其他形式表达不了的三类现象：**double descent、非单调变化、以及"尖锐拐点"（即涌现）**。作者称多数场景 1 个 break 就够。

⚠️ 实践批评：参数多、外推易过拟合，需要跨越 break 两侧的数据才可靠。**用于解释优于用于外推**。

**Alabdulmohsin, Neyshabur, Zhai 2022**, *Revisiting Neural Scaling Laws in Language and Vision* · [arXiv:2209.06640](https://arxiv.org/abs/2209.06640)

这篇的方法学贡献比函数形式更重要：

> "we argue for a more rigorous methodology based on the **extrapolation loss**, instead of reporting the best-fitting (interpolating) parameters"

即：评价一条 scaling law 的标准应该是"用小规模数据拟合、在大规模上的**外推误差**"，而不是拟合优度 $R^2$。这条原则应该内化成习惯——§3 的所有配方都以它为前提。

## 3 · 实操：怎么真正拟合一条 scaling law

这一章是给"要自己跑 scaling 实验"的人写的。如果你只是想读懂论文，可以跳到 §4。

### 3.1 三种方法的取舍

|  | 数据成本 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A1 训练曲线包络** | 中（复用整条曲线） | 假设最少，最直接 | 需要每个 horizon 单独设 LR schedule，否则包络被污染 |
| **A2 IsoFLOP** | 高（每预算跑一排模型） | 直接给出每个 $C$ 的 $N\_{\text{opt}}$；对函数形式无假设 | 抛物线近似有系统偏差；顶点附近曲线平坦，$N\_{\text{opt}}$ 噪声大 |
| **A3 参数化拟合** | 低（复用 A1+A2 全部点） | 得到完整 $L(N,D)$ 曲面，可外推任意点，可估 $E$ | 优化脆弱、易落局部极小；对函数形式敏感；CI 难做对 |

> [!IMPORTANT]
> **最重要的一条方法学建议**
> **三种方法都做，把三者的一致性作为主要的正确性检验。** Chinchilla 事件的教训恰恰是：三种方法给出了不同答案（0.46 / 0.49 / 0.50，Gopher 最优规模 40B vs 67B），但没有被追究。如果你只做一种方法，你就失去了唯一的自查手段。

### 3.2 IsoFLOP 配方（可直接照做）

1.  选 **6–9 个算力预算**，覆盖 **2–3 个数量级**。Chinchilla 用的是 $6\times10^{18}\to3\times10^{21}$。
2.  每个预算下取 **6–10 个模型规模**，围绕预期最优点覆盖 **±(2–4)×**。用 $C=6ND$ 反解 $D$。**每个点单独设 LR schedule**（cosine 衰减到该 horizon 结束，或 constant + cooldown）。
3.  每条 IsoFLOP 曲线在 $(\log N,\\ L)$ 上拟合二次多项式，顶点即 $N\_{\text{opt}}(C)$。
4.  对 $(\log C,\\ \log N\_{\text{opt}})$ 做线性回归得 $a$；同法得 $b$。**检验 $a+b\approx 1$**（这是 $C=6ND$ 的必然推论，不满足说明流程有 bug）。
5.  用 bootstrap 或 jackknife（留一条 IsoFLOP 曲线）给出 CI。
6.  最后做**外推验证**：留出最大的 1–2 个预算不参与拟合，看预测误差。

> [!WARNING]
> **抛物线近似本身有系统偏差**
> 这是一个较新的发现（*Problems with Chinchilla Approach 2: Systematic Biases in IsoFLOP Parabola Fits*, 2026, [arXiv:2603.22339](https://arxiv.org/abs/2603.22339)，⚠️ 预印本，结论请自行验证）：  
> • 即使数据**无噪声**，抛物线拟合真实 loss 曲面也有偏差；当 $\alpha\neq\beta$（曲面不对称）时产生截距误差，外推时放大。  
> • **采样网格宽度是主因**：从 ±2× 加宽到 ±16×，误差从 1.7% 涨到 23%。  
> • 在 Llama-3 规模（3.8e25 FLOP）上相当于浪费约 6.5% 预算。  
> • 提议用 **VPNLS**（Variable Projection + 非负最小二乘）替代：把线性项从非线性搜索中分离，只对指数做非线性搜索。  
> 实用折中：**网格不要太宽**（±2–4× 而非 ±16×），且尽量让网格以真实最优点为中心（可先用一次粗扫定位）。

### 3.3 参数化拟合的工程要点

Chinchilla Appendix D.2 的原始配方（值得逐条照抄，除了那个 bug）：

$$\min\_{A,B,E,\alpha,\beta}\\ \sum\_{\text{runs }i}\\ \mathrm{Huber}\_\delta\!\left(\log \hat L(N\_i,D\_i)-\log L\_i\right),\qquad \delta=10^{-3}$$

-   **在 $\log$ 空间取残差**（$\log\hat L - \log L$，而非 $\hat L - L$）。否则大 loss 的点会主导拟合，而你恰恰最关心小 loss 区。
-   **用 Huber 而非 MSE**：对发散 run、坏 seed 鲁棒。
-   **求和不要平均**——或者平均后相应地缩小 $\delta$ / 收紧终止容差。这正是 Besiroglu 揭示的 bug：平均使目标函数缩小约 400 倍，让 $\delta=10^{-3}$ 落到了错误的区域，L-BFGS 提前终止。
-   **优化器 L-BFGS + 多初值网格**。Chinchilla 的网格：$\alpha,\beta\in\{0,0.5,\dots,2\}$，$e\in\{-1,-0.5,\dots,1\}$，$a,b\in\{0,5,\dots,25\}$，共 4500 组，取最优。**目标函数有多个局部极小，单初值几乎必错。**
-   **对 $A,B,E$ 用 log 参数化**（$A=e^a$ 等）保证正性。
-   **检查收敛**：打印梯度范数，比较不同初值的终点是否聚集。
-   **CI 用 bootstrap（按 run 重采样），并做常识检验**：$n$ 个数据点能支撑多窄的区间？这就是 Besiroglu"600,000 次实验"那条论证的实质。

### 3.4 十个坑（按踩中概率排序）

| # | 坑 | 后果与修法 |
| --- | --- | --- |
| 1 | LR schedule 未随 token 数匹配（固定 cosine horizon 取中间 checkpoint） | 短 run 的 loss 被系统性高估 → 包络扭曲 → 指数偏向"大模型少数据"。**修**：每个 horizon 单设 schedule，或改用 constant LR + cooldown（见下框） |
| 2 | warmup 长度固定不随规模变 | 小模型被系统性拖累。**修**：warmup 随规模缩放 |
| 3 | 参数计数口径（含/不含 embedding、tied/untied） | Kaplan-vs-Chinchilla 的主因之一。**修**：统一用 total params，并在论文里写清楚 |
| 4 | FLOPs 计数（未计解码层；$6ND$ 忽略 attention 项） | 长上下文下不可忽略。**修**：用精确的 FLOPs/token（DeepSeek 的 $M$）替代 $6N$ |
| 5 | LR / batch / AdamW $\beta\_2$ / weight decay 不随规模重调 | 某一侧被系统性拖累。**修**：先拟合超参 scaling law（§5.4），再拟合 loss scaling law |
| 6 | Huber 平均 vs 求和 / 优化器早停 / 系数舍入 | Chinchilla Approach 3 的原罪，三条全中 |
| 7 | 只用最终 checkpoint | (Mis)Fitting 发现纳入中途 checkpoint 使拟合"more stable"且更接近 Hoffmann 的结果 |
| 8 | 拟合区间与外推区间跨度过大 | 误差指数放大。Kaplan 最大只到 1.5B 却外推到 175B+ |
| 9 | 数据分布 / tokenizer / 数据质量在实验间不一致 | DeepSeek 明确指出：**数据质量越高，增量算力应更多分配给模型规模**——即 $a,b$ 本身依赖数据 |
| 10 | 不报告 CI、不做外推验证 | 无法判断稳健性。参照 §2.7 的 extrapolation loss 原则 |

> [!TIP]
> **一个能大幅省钱的技巧：constant LR + cooldown**
> Hägele, Bakouch, Kosson, Ben Allal, Von Werra, Jaggi 2024, *Scaling Laws and Compute-Optimal Training Beyond Fixed Training Durations* · [arXiv:2405.18392](https://arxiv.org/abs/2405.18392)
> cosine 的根本问题是"*prevents training across different lengths for the same model size*"——每个 horizon 都得从头训一遍。改用**常数 LR + 末段 cooldown**后，**同一条 run 可以在多个点分叉出 cooldown 分支**，每个分支都是一个合法的"训练到此为止"的数据点。这能把 scaling 实验成本降低数倍。配合 SWA（沿轨迹做权重平均）还能免费提升性能。

> [!WARNING]
> **现实检查：这件事没有标准答案**
> Li, Kudugunta, Zettlemoyer 2025, *(Mis)Fitting: A Survey of Scaling Laws* · [arXiv:2502.18969](https://arxiv.org/abs/2502.18969) (ICLR 2025)
> 调研 51 篇 scaling law 论文：45/51 用幂律但函数形式各异；**仅 29/51 说明了 checkpoint 选取方式**；**仅 28/51 描述了曲线拟合流程**（即超过一半完全没写）；19/51 提供代码。  
> 他们的消融显示：约束 $\alpha=\beta$、是否 sweep LR、是否剔除最大模型、限制 $D/N$ 范围、初始化方式、损失函数选择——**每一项都能显著改变推荐的最优参数量**。作者的结论很坦率：*"there is no known set of actions which can guarantee a good scaling law fit."*  
> 所以**报告透明度比"正确配方"更重要**。写清楚你怎么数参数、怎么算 FLOPs、用了哪些 checkpoint、怎么拟合的、CI 怎么来的——这比多训几个模型更有价值。  
> 相关开源资源：**Gemstones**（[arXiv:2502.06857](https://arxiv.org/abs/2502.06857)）开放了 4000+ checkpoints，≤2B 参数，含多种 width/depth 形状与 LR/cooldown 消融，专门用来研究"实验设计如何影响 scaling law 结论"。

#### 一个完整的工业级参考流程：DeepSeek LLM

推荐**DeepSeek-AI 2024**, *DeepSeek LLM: Scaling Open-Source Language Models with Longtermism* · [arXiv:2401.02954](https://arxiv.org/abs/2401.02954)

工程上最实用的一篇，因为它把顺序讲清楚了：

1.  用**非嵌入 FLOPs/token $M$ 代替参数量 $N$** 作为"模型规模"，$C = M\cdot D$。作者论证这比 $6N$ 更准确。
2.  **先拟合超参 scaling law**：$\eta\_{\text{opt}}=0.3118\cdot C^{-0.1250}$，batch size 也有对应形式（⚠️ 常被引作 $B\_{\text{opt}}=0.2920\cdot C^{0.3271}$，建议核原文）。
3.  **再拟合** $M\_{\text{opt}}\propto C^{a}$、$D\_{\text{opt}}\propto C^{b}$（常引作 $a=0.5243,\\ b=0.4757$，⚠️ 未核实）。
4.  **明确报告 $a,b$ 随数据集质量的变化**（早期数据 / 当前数据 / OpenWebText2 三组对比）。这是全文最有价值的一条：**scaling law 的指数不是物理常数，是你的数据的函数**。

## 4 · 数据受限与推理侧：Chinchilla 的两个假设被破掉之后

### 4.1 重复数据值多少钱

必读**Muennighoff, Rush, Barak, Le Scao, Piktus, Tazi, Pyysalo, Wolf, Raffel 2023**, *Scaling Data-Constrained Language Models* · [arXiv:2305.16264](https://arxiv.org/abs/2305.16264) (NeurIPS 2023 杰出论文亚军) · 400+ runs，≤9B 参数，≤900B tokens

思路：保持 Chinchilla 的形式不变，把 $N,D$ 换成"**有效**"版本：

$$L(N',D')=\frac{A}{N'^{\alpha}}+\frac{B}{D'^{\beta}}+E$$ $$D'=U\_D+U\_D\,R\_D^{\*}\left(1-e^{-R\_D/R\_D^{\*}}\right),\qquad N'=U\_N+U\_N\,R\_N^{\*}\left(1-e^{-R\_N/R\_N^{\*}}\right)$$

其中 $U\_D=\min\{D\_C, D\}$ 是实际用到的**唯一** token 数，$R\_D=D/U\_D-1$ 是重复次数（= epoch 数 − 1）；$U\_N$ 是对应 $U\_D$ 的 compute-optimal 参数量，$R\_N=N/U\_N-1$ 是"过剩参数"倍数。

| 常数 | 拟合值 | 含义 |
| --- | --- | --- |
| $R\_D^{\*}$ | **15.3878**（论文正文写 ≈15） | 重复 token 价值的衰减时间常数 |
| $R\_N^{\*}$ | **5.3097** | 过剩参数价值的衰减时间常数 |

C4 上重新拟合的 Chinchilla 型常数：$A=521,\\ B=1488,\\ E=1.87,\\ \alpha=\beta=0.35$。⚠️ 注意这与原始 Chinchilla 差别很大（数据集不同、且此处对称化了指数），**跨论文混用系数会出错**。

#### 把公式变成直觉

第 $k$ 个 epoch 的边际"新数据等价值"是 $\partial D'/\partial R\_D = U\_D\,e^{-R\_D/R\_D^{\*}}$——**指数衰减**。代入 $R\_D^\*=15.39$：

| epoch 数 | 边际单 token 价值 | 累计效率 $D'/D$ | 备注 |
| --- | --- | --- | --- |
| 1 | 1.000 | 1.000 |  |
| 2 | 0.937 | 0.984 |  |
| **4** | **0.823** | **0.931** | 原文："up to 4 epochs 的 loss 变化可忽略" |
| 8 | 0.635 | 0.828 |  |
| **16** | **0.377** ($=e^{-1}$) | 0.661 | $R\_D=R\_D^\*$ 的定义点 |
| **40** | 0.079 | 0.379 | 原文 Fig.1："repeating is worthless" |
| $\infty$ | 0 | — | $D'\to 16.39\,U\_D$ **硬天花板** |

> [!IMPORTANT]
> **三个记忆点**
> **≤4 epochs 基本免费**（93% 效率）→ **16 epochs 衰减到 $1/e$** → **40 epochs 归零**。无论重复多少次，有效数据量最多是唯一数据的 **16.4×**，有效参数量最多是 **6.3×**。重复数据换不来无限 scaling。

#### 其他可直接用的结论

-   **算力分配反转**：数据受限时，多余算力应**优先投给更多 epoch 而非更多参数**（与 Chinchilla 的等比例扩展相反）。
-   **掺代码有 2× 有效 token 增益**，且**即使只评测自然语言任务也成立**。代码占比 ≤50% 时下游不退化。
-   数据受限设定下，**perplexity 过滤有效，去重（dedup）无帮助**。
-   **参数过剩会反噬**：仅 100M token 单 epoch 时，>2B 参数模型的验证 loss 显著更高。

#### 2025–2026 的三个重要修正

| 论文 | 修正 |
| --- | --- |
| **Fang et al. 2025**, *Datasets, Documents, and Repetitions*<br>[arXiv:2503.07879](https://arxiv.org/abs/2503.07879) | 只要**调整训练配方（尤其 weight decay）**，重复**强过滤**数据集**最多 10 epochs**，可以**优于**在 10× 大的 superset 上跑 1 epoch。另提出**文档级不等重复**优于均匀 epoch 重复。 |
| **Kim, Kotha, Liang, Hashimoto 2025**, *Pre-training under infinite compute*<br>[arXiv:2509.14786](https://arxiv.org/abs/2509.14786) | 单纯加 epoch / 加参数最终会过拟合。**最优 weight decay 比标准实践大 30×**；正则化后 loss 随参数量呈干净幂律，可外推**渐近 loss**。200M token 预算下比 baseline **省 5.17× 数据**；**集成**能压低渐近线，蒸馏到 8× 小的学生仍保留 **83%** 的集成收益。 |
| **Lovelace et al. 2026**, *Prescriptive Scaling Laws for Data Constrained Training*<br>[arXiv:2605.01640](https://arxiv.org/abs/2605.01640) | 用**加性过拟合罚项**建模重复；强 weight decay（$\lambda=1.0$）把过拟合系数降约 **70%**，解释了为何数据受限时最优 WD 比常规大一个数量级。 |

> [!TIP]
> **从这三篇提炼的一条实操原则**
> "重复几遍会掉点"这件事**强烈依赖正则化设置**。Muennighoff 的 4-epoch 阈值是在标准配方下测的；把 weight decay 调大一个数量级后，可用的 epoch 数明显上移。所以在数据受限场景，**先扫 weight decay，再谈 epoch 上限**。

### 4.2 数据质量与配比：把"数据"变成可优化的变量

#### 质量过滤能换多少算力

**Li, Fang, Smyrnis et al. 2024**, *DataComp-LM: In search of the next generation of training sets for language models* · [arXiv:2406.11794](https://arxiv.org/abs/2406.11794)

240T token 的候选池 + 标准化训练配方 + 53 个下游评测。**DCLM-Baseline 7B / 2.6T tokens → MMLU 5-shot 64%**，与 Llama 3 8B 在 53 个 NLU 任务上可比，但**算力少 6.6×**。核心结论：**基于模型的过滤（fastText 分类器）是最关键的杠杆**，超过启发式规则与去重。

这篇的意义是把"数据质量"直接换算成了**算力等价倍数**——从此数据质量可以和算力放在同一张账单上比较。

#### 配比可以解析建模

**Ye, Liu, Sun, Zhan, Zhou, Qiu 2024**, *Data Mixing Laws* · 复旦 · [arXiv:2403.16952](https://arxiv.org/abs/2403.16952) (ICLR 2025)

$$L\_i(r\_{1\ldots M})=c\_i+k\_i\exp\left(\sum\_{j=1}^{M}t\_{ij}\,r\_j\right),\qquad L=\sum\_{i=1}^{K}s\_i\,L\_i(r\_{1\ldots M})$$

$r\_j$ = 第 $j$ 个训练域的占比，$s\_i$ = 验证集中第 $i$ 域的权重，$t\_{ij}$ 捕捉**域间交互**（$i\neq j$ 时是跨域迁移或干扰）。选指数形式是因为 $r\_j\in[0,1]$ 有界，便于在已见混合比之间插值。

**落地方式很聪明**：把 mixing law 与 training-step scaling law、model-size scaling law **嵌套**，用小模型 + 短步数的实验预测大模型的最终 loss，从而在不训练大模型的情况下搜索最优比例。效果：1B/100B tokens 下，优化后的比例达到默认比例训练 **+48% 时长** 的水平。

**Liu, Zheng, Muennighoff et al. 2024**, *RegMix: Data Mixture as Regression for Language Model Pre-training* · Sea AI Lab · [arXiv:2407.01492](https://arxiv.org/abs/2407.01492) (ICLR 2025)

黑箱路线：训 **512 个 1M 参数 / 1B token 的代理模型**，用 LightGBM 回归拟合 (mixture → loss)，在单纯形上搜最优比例，再放大到 1B/25B 与 7B/100B。成本约为 DoReMi 的 **10%**，效果持平或更好。结论：**自动搜索一致优于人工设定**。

> [!TIP]
> **三者的分工**
> **DCLM 管"留哪些 token"（质量过滤）→ Mixing Laws / RegMix 管"各域按什么比例配"→ §4.1 的数据受限律管"配好的数据重复几遍"。** 这三步是串行的，顺序不能颠倒。

### 4.3 数据枯竭与合成数据

**Villalobos, Ho, Sevilla, Besiroglu, Heim, Hobbhahn**, *Will we run out of data? Limits of LLM scaling based on human-generated data* · Epoch AI · [arXiv:2211.04325](https://arxiv.org/abs/2211.04325) (v1 2022, **重大修订 2024-06**, ICML 2024 Position Paper)

| 项目 | 2024 版估计 |
| --- | --- |
| 有效公共人类文本存量 | **~300T tokens**（90% CI 100T–1000T） |
| 存量完全用尽 | 80% CI **2026–2032** |
| compute-optimal 训练（不过训练） | 数据够撑到 **~2028** |
| **5× 过训练** | **2027** 用尽 |
| **100× 过训练** | **2025** 用尽 |

为什么比 2022 版（曾预测 2024 年枯竭）推迟了？两个原因：(1) 发现**过滤后的网页数据优于人工精选语料** → 高质量数据估计上调 5×；(2) 发现模型能容忍多轮 epoch（即 §4.1 的成果）→ 有效存量再 ×2–5。

> [!WARNING]
> **时效提醒**
> 这些是 **2024 年 vintage 的预测**。今天是 2026 年 8 月，"5× 过训练 → 2027 用尽"已经进入验证窗口。引用时务必标注预测年份，并考虑 Epoch AI 可能已有更新。

#### 模型崩溃：一个被过度传播的结论

**Shumailov, Shumaylov, Zhao, Papernot, Anderson, Gal 2024**, *AI models collapse when trained on recursively generated data* · **Nature 631, 755–759** · [doi:10.1038/s41586-024-07566-y](https://www.nature.com/articles/s41586-024-07566-y)（另有 2025-03 的 Author Correction）

-   **Early collapse**：分布尾部信息先丢失；**Late collapse**：收敛到方差大幅塌缩、与原分布几乎无关的分布。
-   OPT-125m 在**完全不保留原始数据**的设定下，约 **5 代**内出现明显退化。
-   但论文自己的 Fig.1c 显示：**保留 10% 原始数据**跑十轮，退化很轻微。

必读配套**Gerstgrasser, Schaeffer, Dey, Rafailov et al. 2024**, *Is Model Collapse Inevitable? Breaking the Curse of Recursion by Accumulating Real and Synthetic Data* · [arXiv:2404.01413](https://arxiv.org/abs/2404.01413)

> [!IMPORTANT]
> **关键区分：替换 vs 累积**
> Shumailov 的设定是**每一代用合成数据替换掉上一代数据**。而现实中互联网数据是**累积**的——旧的真实数据不会消失。  
> Gerstgrasser 在线性模型下证明：**数据累积时，测试误差存在一个与迭代次数无关的有限上界，因此不发生模型崩溃**；而替换设定下误差随代数无界增长。实证覆盖语言模型、分子扩散模型、图像 VAE。  
> **正确的定调**：模型崩溃是真实但**设定敏感**的现象。它成立需要 (a) 完全用合成数据替换真实数据、且 (b) 无质量筛选。现实 pipeline 中真实数据累积 + 合成数据经验证器筛选，实证上不出现崩溃。"合成数据会毁掉互联网"这一叙事被大幅弱化，但**无筛选自举仍然危险**。

### 4.4 推理成本感知：为什么大家都在疯狂过训练

必读**Sardana, Portes, Doubov, Frankle 2024**, *Beyond Chinchilla-Optimal: Accounting for Inference in Language Model Scaling Laws* · MosaicML/Databricks · [arXiv:2401.00448](https://arxiv.org/abs/2401.00448) (ICML 2024) · 47 个模型

Chinchilla 最小化的是训练算力。但模型训完是要**用**的。改成最小化总算力：

$$N^{\*},\,D^{\*}\_{\text{tr}} \;=\; \arg\min\_{N,\,D\_{\text{tr}}\\ \mid\\ L(N,D\_{\text{tr}})=\ell}\\ \underbrace{6ND\_{\text{tr}}}\_{\text{训练}}+\underbrace{2ND\_{\text{inf}}}\_{\text{推理}}$$

注意约束是**固定目标 loss $\ell$ 的等值线**——在这条线上滑动，找总成本最低点。因为推理成本正比于 $N$ 而与 $D\_{\text{tr}}$ 无关，最优点必然向"**更小、训得更久**"移动。

| 场景 | Chinchilla 配置 | 推理感知最优 | FLOPs 节省 |
| --- | --- | --- | --- |
| 30B 质量，$D\_{\text{inf}}=$ 5T tokens | 30B / 1.56T | **16.4B / 3.27T** | ~16% |
| 70B 质量，$D\_{\text{inf}}=$ 10T tokens | 70B / 4.26T | **41.6B / 7.92T** | ~12% |

按真实硬件成本（含训练/推理不同利用率与价格）算，30B 质量模型 + 17.5B 次推理请求：总成本 **1080 万美元 → 452 万美元，省 58%**。经验阈值：**预期推理量到 $10^9$ 级**就该显著偏离 20:1。

> [!WARNING]
> **论文自己给的一条重要警告**
> 他们把 tokens/param 推到 **10,000** 量级重新拟合，发现：**用常规 token/param 比拟合出的 scaling law 会高估极端比例下额外 token 的价值**。也就是说，**直接把 Chinchilla 公式外推到 1000+ tokens/param 是不可靠的**——你需要在目标区间内重新拟合。

#### 工业界的实际比例

| 模型 | 参数 | 训练 tokens | tokens/param | 相对 20:1 |
| --- | --- | --- | --- | --- |
| Chinchilla 70B | 70B | 1.4T | 20 | 1× |
| **Llama 3 8B** | 8B | **15T** | **1,875** | ~94× |
| Llama 3 70B | 70B | 15T | 214 | ~10.7× |
| Llama 3.1 405B | 405B | ~15.6T | ~38.5 | ~1.9× ⚠️ |
| DCLM-Baseline 7B | 7B | 2.6T | 371 | ~18.6× |
| Qwen2.5 | — | 18T | — | — |
| **Qwen3 0.6B** | 0.6B | **~36T** | **~60,000** | ~3000× |

Meta 官方原话（Llama 3 blog）：

> "while the Chinchilla-optimal amount of training compute for an 8B parameter model corresponds to ~200B tokens, we found that model performance continues to improve even after the model is trained on **two orders of magnitude more data**. Both our 8B and 70B parameter models continued to improve **log-linearly** after we trained them on up to 15T tokens."

> [!IMPORTANT]
> **最容易被误读的一句话**
> **Chinchilla 的 20:1 是"给定训练算力预算的最优点"，不是"训练更久无益"。** 这两件事经常被混为一谈。Sardana 的 47 个模型显示，把 tokens/param 推到 10,000:1 时质量**仍在提升**——只是每单位训练算力的收益低于"把算力花在更大模型上"。一旦把推理账单加进来，天平就翻转了。

#### 过训练区间的可靠外推工具

Gadre et al.（见 §2.6）给出了在过训练区间做外推的重参数化。令 token 乘子 $M\equiv D/N$：

$$L(C,M)=E+\left(a M^{\eta}+b M^{-\eta}\right)C^{-\eta}$$

（可由 $L=E+AN^{-\alpha}+BD^{-\beta}$ 在 $\alpha=\beta$ 时代入 $C=6ND,\\ D=MN$ 导出，$\eta=\alpha/2$。）关键性质：**$\eta$ 在不同过训练程度下保持不变**，所以可以只在小 $M$ 上拟合、外推到大 $M$。实测：用 **300× 更少算力**预测出 1.4B / 900B tokens（32× 过训练）的验证 loss。

### 4.5 蒸馏 scaling law：什么时候该蒸馏

**Busbridge, Shidani, Weers, Ramapuram, Littwin, Webb 2025**, *Distillation Scaling Laws* · Apple · [arXiv:2502.08606](https://arxiv.org/abs/2502.08606) (ICML 2025, 69 页)

$$L\_S(N\_S,D\_S,L\_T)=L\_T+\frac{1}{L\_T^{\,c\_0}}\left(1+\left(\frac{L\_T}{\tilde L\_S\,d\_1}\right)^{1/f\_1}\right)^{-c\_1 f\_1}\left(\frac{A}{N\_S^{\alpha'}}+\frac{B}{D\_S^{\beta'}}\right)^{\gamma'}$$

⚠️ 括号层级从 PDF 抽取时渲染有损，写入正式材料前建议对照原文 §4.3。$L\_T$ = 教师交叉熵，$N\_S,D\_S$ = 学生参数量与蒸馏 token 数，$\tilde L\_S$ = 学生在**监督预训练**下本可达到的交叉熵。

#### 四条结构性结论（比公式更有用）

1.  **教师只通过 $L\_T$ 影响学生**。教师规模 $N\_T$ 和教师训练 token 数 $D\_T$ 的影响**完全由其导致的 $L\_T$ 中介**。实践含义：**挑教师只需要看它的 loss，不需要看它多大**。
2.  **容量鸿沟是"学习能力差距"而非"参数量差距"**。当 $L\_T/\tilde L\_S = d\_1$ 时发生转折：**更强的教师反而产生更差的学生**。作者把它刻画为两个幂律区之间的转换（学生是比教师更强的学习者 / 更弱的学习者）。
3.  **蒸馏优于监督预训练需要同时满足两个条件**：(a) 分配给学生的总算力或 token 数**不超过一个随学生规模可预测增长的阈值**；(b) 教师**已经存在**，或将被复用于多个学生。
4.  **反向结论**：如果只蒸馏一个学生、且教师需要专门训练，那么**监督预训练通常更优**（把训教师的算力直接给学生）。

与前文的接口：蒸馏本质上是"用教师的软标签**提高每 token 的信息密度**"，因此它是数据受限场景的一条正交解法。§4.1 提到的 *Pre-training under infinite compute* 给出了互补证据：集成 → 蒸馏到 8× 小的学生仍保留 83% 收益。

### 4.6 精度与量化：过训练的账要在部署端还

**Kumar, Ankner, Spector, Bordelon, Muennighoff, Paul, Pehlevan, Ré, Raghunathan 2024**, *Scaling Laws for Precision* · [arXiv:2411.04330](https://arxiv.org/abs/2411.04330) (ICLR 2025) · 465+ 预训练 run

#### 低精度训练 = 直接砍参数

$$N\_{\text{eff}}(P\_w,P\_a,P\_{kv})=N\left(1-e^{-P\_w/\gamma\_w}\right)\left(1-e^{-P\_a/\gamma\_a}\right)\left(1-e^{-P\_{kv}/\gamma\_{kv}}\right)$$

拟合：$\gamma\_w=2.6745,\\ \gamma\_a=2.2102,\\ \gamma\_{kv}=0.9578$。只看权重项的"参数保留率"：

| $P\_w$ (bits) | 16 (BF16) | 8 (INT8) | 6 | 4 (INT4) | 3 | 2 |
| --- | --- | --- | --- | --- | --- | --- |
| 保留率 | 0.998 | 0.950 | 0.894 | 0.776 | 0.674 | 0.527 |
| 等效参数损失 | 0.25% | **5.0%** | 10.6% | **22.4%** | 32.6% | 47.3% |

INT4 训练一个 $N$ 参数的模型 ≈ 训练一个 $0.78N$ 的 BF16 模型。$\gamma\_{kv}=0.958$ 最小，说明 **KV cache 对精度最不敏感**——与工程实践中 KV cache 常压到 4-bit 甚至更低完全相符。

#### 训练后量化（PTQ）的退化

$$\delta\_{\text{PTQ}}=C\_T\,e^{-P\_{\text{post}}/\gamma\_{\text{post}}}\\ \frac{D^{\gamma\_D}}{N\_{\text{eff}}^{\gamma\_N}}\\ \prod\_{x\in\{w,a,kv\}}\left[1-e^{-C\_x(P\_x-P\_{\text{post}})}\right]$$

拟合：$C\_T=0.0598,\\ \gamma\_D=0.5068,\\ \gamma\_N=0.3439,\\ \gamma\_{\text{post}}=0.5907$。统一形式：$L = A N\_{\text{eff}}^{-\alpha}+BD^{-\beta}+E+\delta\_{\text{PTQ}}$。

> [!WARNING]
> **最反直觉的一条：$\delta_{\text{PTQ}}\propto D^{0.51}$**
> **训练数据越多，PTQ 后掉点越严重。** 极端情况下，如果你确定要量化部署，继续预训练可能是**净负收益**。这与 §4.4"大家都在疯狂过训练"形成直接张力。  
> 另一方面 $N\_{\text{eff}}^{-\gamma\_N}$ 说明**更大的模型对 PTQ 更鲁棒**——这是"小模型难量化"的定量解释。

**最优精度**：联合优化 $N,D,P$ 时，**7–8 bits 是 compute-optimal**，且与算力预算基本无关。若 $N$ 被固定（显存约束），最优精度随算力近似对数增长。

#### 争议：这个结论有多可信

-   **规模有限**：最大仅 1.7B / 26B tokens，距前沿几个数量级。
-   **QAT 是另一条路**。*Scaling Law for Quantization-Aware Training*（[arXiv:2505.14302](https://arxiv.org/abs/2505.14302), 2025, 268 组实验）给出：量化误差**随模型增大而下降、随 token 增多而上升、随量化粒度变粗而上升**；W4A4 的主要瓶颈是 **FC2 层激活的 outlier**，可用混合精度定点解决。Kumar 的悲观结论**不能直接外推到 QAT**。
-   *Scaling Laws for Floating Point Quantization Training*（[arXiv:2501.02423](https://arxiv.org/abs/2501.02423), 2025）独立确认了"临界数据量"现象：低精度训练下超过某阈值后**更多数据反而使性能下降**；并发现**指数位的贡献略大于尾数位**，推荐 4–8 bits。
-   **实践反例**：DeepSeek-V3 用 FP8 混合精度在 14.8T tokens 上成功训练 671B MoE，与悲观外推张力明显。

### 4.7 稀疏化：过训练时代最划算的技术

**Frantar, Riquelme, Houlsby, Alistarh, Evci 2023**, *Scaling Laws for Sparsely-Connected Foundation Models* · [arXiv:2309.08520](https://arxiv.org/abs/2309.08520) (ICLR 2024)

$$L(S,N,D)=\underbrace{\left(a\_S(1-S)^{b\_S}+c\_S\right)}\_{\text{受稀疏度调制的容量系数}}\cdot\left(\frac{1}{N}\right)^{b\_N}+\left(\frac{a\_D}{D}\right)^{b\_D}+c$$

$S$ = 稀疏度，**$N$ = 非零参数量**（关键：不是总参数量）。结构上：**稀疏度只影响容量项的系数，不改变 $N,D$ 的指数**。

|  | $a\_S$ | $b\_S$ | $c\_S$ | $b\_N$ | $a\_D$ | $b\_D$ | $c$ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ViT / JFT-4B | 2.94e2 | 0.821 | 4.68e2 | 0.392 | 2.37e8 | 0.890 | 4.517 |
| T5 / C4 | 1.68e1 | 0.722 | 4.50e1 | 0.245 | 6.90e8 | 0.203 | 0.651 |

换算成"等效稠密参数量"（T5/C4）：**75% 稀疏 ≈ 稠密模型大 2.16×**；$S\to1$ 的理论上界约 3.5×。视觉与语言域的这个数值几乎相同，是个不错的稳健性信号。

> [!IMPORTANT]
> **核心洞见：$S_{\text{opt}}$ 随训练时长单调增加**
> $$S\_{\text{opt}}(N,C)=\max\left\{1-\exp\left[\frac{\log\!\left(\frac{b\_N a\_D b\_D}{a\_S b\_S}\right)+b\_N\log N}{b\_D+b\_S}\right]\cdot\left(\frac{C}{6N}\right)^{-\frac{b\_D}{b\_D+b\_S}},\\ 0\right\}$$ 超过 Chinchilla 最优点训练越久，越应该更稀疏。等价说法：**稀疏化是"用更多训练换更小推理"的工具**——这与 §4.4 的过训练趋势完全同向。  
> ⚠️ 工程落差：非结构化稀疏在通用硬件上**难以兑现实际加速**（需要 2:4 结构化稀疏或专用核）。MoE 才是"训练和推理都真省 FLOPs"的那种稀疏，见 §5.1。

> [!TIP]
> **§4 的收尾张力（值得记住）**
> **§4.4 让你多训 token；§4.6 告诉你多训的 token 会让量化更痛；§4.7 告诉你多训的 token 让稀疏更值。**  
> 这三条不矛盾——它们共同说明**"训练-部署联合优化"才是正确的目标函数**。目前还没有一个统一的 $L(N, D, P, S, D\_{\text{inf}})$ 五维 scaling law，这是一个明确的开放问题。

## 5 · MoE、架构、超参与多模态

### 5.1 MoE scaling law：三代演进

#### 第一代：Clark et al. 2022 —— 交互项与饱和

**Clark, de las Casas, Guy, Mensch, Paganini, Hoffmann et al. 2022**, *Unified Scaling Laws for Routed Language Models* · DeepMind · [arXiv:2202.01169](https://arxiv.org/abs/2202.01169) (ICML 2022) · 168 个模型

$$\log L(N,E)=a\log N+b\log\hat E+c\,\log N\log\hat E+d$$

$N$ = 每 token 实际前向的稠密参数量（≈ active params），$E$ = 专家数。关键是**交互项** $c\log N\log\hat E$：有效指数 $\alpha(E)=a+c\log E$，$c>0$ 抵消 $b<0$，所以**专家越多，$N$ 的 scaling 指数越弱**。

| 路由方法 | $a$ | $b$ | $c$ | $d$ | $E\_{\text{start}}$ | $E\_{\max}$ |
| --- | --- | --- | --- | --- | --- | --- |
| S-BASE | −0.082 | −0.108 | 0.009 | 1.104 | 1.847 | 314.5 |
| RL-R | −0.083 | −0.126 | 0.012 | 1.111 | 1.880 | 470.0 |
| HASH | −0.087 | −0.136 | 0.012 | 1.157 | 4.175 | 477.7 |

三点结论：① 三种路由拟合形状一致，**路由算法只改常数不改结构**；② $E\_{\max}\approx 300\text{–}500$，专家数收益在此饱和；③ 路由收益随 $N$ 增大而递减。

#### 第二代：Krajewski/Ludziejewski et al. 2024 —— 粒度，以及对 Clark 的反驳

推荐**Krajewski, Ludziejewski et al. 2024**, *Scaling Laws for Fine-Grained Mixture of Experts* · [arXiv:2402.07871](https://arxiv.org/abs/2402.07871) (ICML 2024)

引入**粒度** $G=d\_{\text{ff}}/d\_{\text{expert}}$，即把标准 FFN 切成 $G$ 份来做专家。$G=1$ 就是传统的"专家 = 一个完整 FFN"。

$$\boxed{\;L(N,D,G)=c+\left(\frac{g}{G^{\gamma}}+a\right)\frac{1}{N^{\alpha}}+\frac{b}{D^{\beta}}\;}$$

| $a$ | $\alpha$ | $b$ | $\beta$ | $g$ | $\gamma$ | $c$ |
| --- | --- | --- | --- | --- | --- | --- |
| 18.1 | 0.115 | 30.8 | 0.147 | 2.1 | 0.58 | 0.47 |

结构解读：**粒度只进入参数项的系数**（$g/G^\gamma$），不改变 $N,D$ 的指数；$G\to\infty$ 时系数趋于 $a=18.1$，收益饱和。

但粒度不是免费的——算力约束里有路由开销项：

$$F=\left(12\,d\_{\text{model}}^2\,c\_f+d\_{\text{model}}\,E\,G\,c\_r\right)\cdot D\cdot n\_{\text{blocks}}$$

$c\_r$ 是 gather-scatter / 路由开销系数，$G$ 越大开销越大。无闭式解，原文用 Brent 方法数值求。

**数值结论**：$G\_{\text{opt}}$ 从 $10^{18}$ FLOPs 时的 $G\approx 8$ 增长到 $10^{25}$ FLOPs 时的 $G\approx 64$。也就是说，**"专家大小 = FFN 大小"这个常规做法在几乎任何预算下都不是最优的**。

> [!IMPORTANT]
> **与 Clark 的关键分歧**
> Krajewski 认为 Clark 的"MoE 收益随规模衰减"是**没有联合建模 $D$ 造成的伪影**。在联合 $(N,D,G)$ 下，**MoE 相对 dense 的效率差距随规模增大而扩大**——结论正好相反。这是一个很好的教学案例：**遗漏变量会让 scaling law 的定性结论翻转。**

#### 第三代：Ludziejewski et al. 2025 —— MoE 也能省显存

**Ludziejewski, Pióro, Krajewski et al. 2025**, *Joint MoE Scaling Laws: Mixture of Experts Can Be Memory Efficient* · [arXiv:2502.05172](https://arxiv.org/abs/2502.05172) (ICML 2025)

$$\mathcal{L}(N\_{\text{act}},D,\hat E)=a\,\hat E^{\delta}\,N\_{\text{act}}^{-(\alpha+\gamma\ln\hat E)}+b\,\hat E^{\omega}\,D^{-(\beta+\zeta\ln\hat E)}+c$$

比 Clark 的双线性更强的耦合：**指数本身依赖 $\ln\hat E$**。拟合：$a=35.91,\\ \alpha=0.1889,\\ \delta=0.2285,\\ \gamma=-0.0098,\\ b=35.98,\\ \beta=0.1775,\\ \omega=-0.5529,\\ \zeta=0.0259,\\ c=1.3637$，$E\_{\text{start}}=2.07,\\ E\_{\max}=290.45$。（⚠️ 正负号请以原文 PDF 为准。）

**核心结论**：*"MoE can also be memory optimal."* 在**总参数量匹配**（而非仅 FLOPs 匹配）的条件下，MoE 仍能在同等计算预算下打败 dense——这推翻了"MoE 只是用显存换 FLOPs"的直觉。实证：1.1B 参数模型，$E\in\{2,4\}$，loss 低于 dense 且推理 FLOPs/token 少 **36–61%**。

#### 2025–2026：更全面的联合律

**Zhao et al. 2025**, *Towards a Comprehensive Scaling Law of Mixture-of-Experts* · Tencent Hunyuan · [arXiv:2509.23678](https://arxiv.org/abs/2509.23678)

五因子（含**共享专家比例 $S$**）：

$$L(N,D,N\_a,G,S)=\left(eG+\frac{f}{G}+mS^2+nS\right)\left(\frac{1}{N^{\alpha}}+\frac{k}{N\_a^{\alpha}}+\frac{hN\_a}{N}\right)+\frac{a}{N^{\alpha}}+\frac{b}{D^{\beta}}+\frac{c}{N\_a^{\alpha}}+\epsilon$$

拟合：$e=0.1577,\\ f=7.2446,\\ m=5.1395,\\ n=-3.2363,\\ k=0.0013,\\ h=0.0450,\\ a=38.051,\\ \alpha=0.2383,\\ b=27129.05,\\ \beta=0.4694,\\ c=31.096,\\ \epsilon=1.8182$。

-   **$G\_{\text{opt}}\approx 7$，且与 $N,N\_a,D$ 无关**——与 DeepSeek-V3 / Qwen3 / Kimi-K2 实际使用的 $G=8\text{–}9$ 高度吻合。
-   **共享专家占比 $S\_{\text{opt}}\approx 0.31$**，13%–31% 区间性能损失可忽略。
-   **激活比 $(N\_a/N)\_{\text{opt}}$ 随 $N$ 增大而下降**：30B 总参时约 40%，671B 总参时约 22%；但考虑推理效率后推荐实操区间 **5%–9%**。

**Wan, Han, Zhang, Jin 2026**, *Holistic Scaling Laws for Optimal MoE Architecture Optimization* · [arXiv:2603.21862](https://arxiv.org/abs/2603.21862) ⚠️ 极新，仅单次核实

主张 **"FLOPs/token 单独作为公平性指标是不充分的"**，应使用 (FLOPs/token, active params, total params) 三元约束。给出 $D^{\text{opt}}(C)=22.89\,C^{0.4563}$、$M^{\text{opt}}(C)=0.0437\,C^{0.5437}$（$C$ in EFLOPs）；参数扩张比 $N/N\_a\approx 18\text{–}25$ 在各尺度大致平坦；并观察到"**近最优配置带随规模变宽**"——大模型对架构偏差更宽容。

### 5.2 最优稀疏度：三条独立路线的同一个答案

**Abnar, Shah, Busbridge, Ali, Susskind, Thilak 2025**, *Parameters vs FLOPs / Understanding Compute-Parameter Trade-offs in Sparse MoE* · Apple · [arXiv:2501.12370](https://arxiv.org/abs/2501.12370) (ICML 2025)

稀疏度定义 $S=(E-K)/E$（$E$ 总专家，$K$ 激活专家）。⚠️ 本文不给闭式律，用多项式拟合 $(N,N\_a,S)\to$ loss 的 IsoFLOP 曲面。结论：

-   **$S^\*$ 随模型规模 $N$ 单调递增，$N\to\infty$ 时 $S^\*\to 1$**。
-   核心论断：**预训练阶段，增加参数比增加每样本 FLOPs 更划算**（capacity > compute）。
-   计算最优配置随预算增大：**总参数量上升，而激活参数量（FLOPs/token）下降**。
-   ⚠️ 最实用的警告：**预训练 loss 与下游 few-shot 表现的最优稀疏度并不一致**。

**Yun, Zhuang, Fu, Xing, Zhang 2024**, *Toward Inference-optimal MoE* · [arXiv:2404.02852](https://arxiv.org/abs/2404.02852)

把 KV-cache / 显存约束下的 serving 吞吐纳入目标：**4–8 专家**的 serving 效率最优，但达到同等 loss 需 2.5–3.5× 训练算力；折中方案是 **16–32 专家 + 过训练**（模型取 loss-optimal 尺寸的 70–85%）→ 推理成本降约 50%，训练预算省最多 68.4%。

> [!IMPORTANT]
> **三条独立路线的一致结论**
> Frantar 的"$S\_{\text{opt}}$ 随训练时长升高"（§4.7）、Abnar 的"$S^\*\to 1$ 随 $N$ 增大"、Zhao 的"$(N\_a/N)\_{\text{opt}}$ 随 $N$ 下降"——三条来自不同团队、不同方法的路线指向同一方向：  
> **规模越大、训练越久，最优激活比越低。**  
> 当代前沿模型的 3–6% 激活比（DeepSeek-V3 37B/671B ≈ 5.5%）与"效率感知"推荐区间 5–9% 吻合得相当好。

### 5.3 架构改常数还是改指数

> [!WARNING]
> **需要更正第二个流行说法**
> 常见转述"Tay et al. 2022 证明架构只改常数不改指数"——**这不是 Tay 的结论，恰恰相反**。

**Tay, Dehghani, Abnar, Chung, Fedus, Rao, Narang, Tran, Yogatama, Metzler 2022**, *Scaling Laws vs Model Architectures* · [arXiv:2207.10551](https://arxiv.org/abs/2207.10551)

| 架构 | $\alpha\_{F,U}$（FLOPs→上游 PPL） | $\alpha\_{F,D}$（FLOPs→下游 acc） | $\alpha\_{P,U}$ |
| --- | --- | --- | --- |
| **Transformer** | **0.54** | **0.28** | 0.47 |
| GLU-Transformer | 0.49 | 0.24 | 0.42 |
| Evolved Transformer | 0.44 | 0.22 | 0.42 |
| MLP-Mixer | 0.32 | −0.03 | 0.26 |
| Performer | 0.25 | 0.05 | 0.24 |
| Switch Transformer | 0.23 | 0.14 | 0.13 |
| ALBERT | 0.08 | −0.12 | 0.13 |

Tay 的实际结论是：**不同架构的 scaling 斜率差异巨大，且小尺度的排名不能外推到大尺度**。ALBERT 甚至出现负斜率（越大越差）；Performer 的 $\alpha\_{F,U}$ 只有 Transformer 的一半。

⚠️ 但要注意 Switch 的 $\alpha$ 很低——这与后来 MoE 文献的正面结论冲突。原因很可能是：**用参数量/FLOPs 作 x 轴去衡量 MoE 是不公平的**（正是 §5.1 中 Wan 2026 批评的"单一 FLOPs 指标不充分"），且未联合建模 $D$。这本身是一个很好的"指标选择决定结论"的案例。

#### 那么"改常数不改指数"什么时候成立？

**Shen, Li, Leng, Qin, Sun, Zhong 2024**, *Scaling Laws for Linear Complexity Language Models* · [arXiv:2406.16690](https://arxiv.org/abs/2406.16690) (EMNLP 2024)

| 架构 | $L(C)$ | $N\_{\text{opt}}(C)$ |
| --- | --- | --- |
| LLaMA (softmax attn) | $3.7087\,C^{-0.0798}$ | $1.82\times10^8\,C^{0.7118}$ |
| TNL | $3.5391\,C^{-0.0768}$ | $2.74\times10^8\,C^{0.6470}$ |
| HGRN2 | $3.4788\,C^{-0.0753}$ | $2.66\times10^8\,C^{0.6427}$ |
| cosFormer2 | $3.5877\,C^{-0.0756}$ | $2.65\times10^8\,C^{0.6516}$ |

**这才是"架构主要改常数"的直接证据**：指数 −0.0798 vs −0.0753 差异 <6%，而常数项 3.71 vs 3.48 差异明显。同样支持这一点的还有 **Griffin**（[arXiv:2402.19427](https://arxiv.org/abs/2402.19427)）：Hawk / Griffin / MQA Transformer 在 100M–14B 上的 loss-vs-FLOPs 曲线**斜率相近、截距不同**，Griffin 在所有预算下截距最低。

> [!WARNING]
> **但有一个致命的补充：loss scaling 相同 ≠ 能力 scaling 相同**
> 同一篇 Shen et al. 报告：Needle-in-Haystack 检索任务上，**线性模型只有 10–30%，LLaMA 约 50–60%**，且预训练上下文扩到 16K 时差距更明显。  
> 也就是说：线性注意力在 **语言建模 loss** 这条曲线上与 softmax 注意力几乎无差别，但在**需要精确长程回忆的能力**上有结构性上界。**如果你只用 loss 做架构选型，会得出错误结论。**（Abnar 关于"预训练 loss 与 few-shot 的最优稀疏度不一致"是同一现象的另一个体现。）

#### 综合判断

| 情形 | 是否改变指数 |
| --- | --- |
| 表达力充分的架构变体（线性注意力、SSM、混合架构、MoE 路由算法） | ❌ 主要改常数 |
| 表达力有本质缺陷的架构（ALBERT 参数共享、Performer 低秩近似） | ✅ 改指数（变差） |
| **预训练数据分布** | ✅ **改指数**（见 §5.5 的 CLIP 证据） |
| 下游能力（长程检索、精确回忆） | ⚠️ 不服从 loss 的 scaling，需单独评测 |

### 5.4 超参外推：拟合 loss 之前必须先做的事

#### 5.4.1 muP（Tensor Programs V）

必读**Yang, Hu, Babuschkin, Sidor, Liu, Farhi, Ryder, Pachocki, Chen, Gao 2022**, *Tensor Programs V: Tuning Large Neural Networks via Zero-Shot Hyperparameter Transfer* · [arXiv:2203.03466](https://arxiv.org/abs/2203.03466)

|  | 输入层 & bias | 隐层 | 输出层 (readout) |
| --- | --- | --- | --- |
| 初始化方差 | $\Theta(1)$ | $1/\text{fan\\_in}$ | $1/\text{fan\\_in}^2$ |
| SGD 学习率 | $\eta\cdot\text{fan\\_out}$ | $\eta$ | $\eta/\text{fan\\_in}$ |
| **Adam 学习率** | $\eta$ | $\boldsymbol{\eta/\text{fan\\_in}}$ | $\eta/\text{fan\\_in}$ |

**实操记忆点**：Adam 下隐层与输出层学习率随宽度 $\propto 1/d$ 衰减，嵌入/输入层学习率不变；输出层初始化方差额外多一个 $1/\text{fan\\_in}$ 因子。

-   ✅ **可迁移**：学习率、动量、初始化尺度、各类 multiplier、正则化系数、LR schedule 形状、dropout、weight decay
-   ❌ **不迁移**：width（定义域本身）、depth\*、batch size\*、训练时长\*、seq length\*（\* = 经验上部分可行但无理论保证）

**实证**：GPT-3 6.7B 从 40M 代理模型迁移超参，**调参成本仅为总预训练的 7%**。

#### 5.4.2 Step Law：直接给出 $\eta,B$ 的经验公式

推荐**StepFun et al. 2025**, *Predictable Scale: Part I, Step Law* · [arXiv:2503.04715](https://arxiv.org/abs/2503.04715) · **3,700 个 LLM 从头训练，约 100 万 H800 GPU-hours**

$$\boxed{\;\eta\_{\text{opt}}(N,D)=1.79\,N^{-0.713}\,D^{0.307}\;}\qquad\boxed{\;B\_{\text{opt}}(D)=0.58\,D^{0.571}\;}$$

（$N$ = 非嵌入参数量，$D$ = 训练 tokens。）

-   **最优 batch size 只依赖 $D$，与 $N$ 无关**——这是与 Kaplan 的 $B\_{\text{crit}}(L)$ 视角不同的一个重要发现。
-   固定 $(N,D)$ 时，loss 关于 $(\eta,B)$ 呈**凸**形，最优点附近有**平台区**——这解释了工程上"差不多就行"为什么真的行。
-   预测点与穷举最优的相对 loss 差距**仅 0.09%**。
-   **三重不变性**：拓扑（不同深宽比、注意力结构）、稀疏（MoE 各稀疏度下相对误差 <0.5%）、数据分布（双语 / code-heavy / code-dominant，相对误差 <0.25%）。

#### 5.4.3 临界 batch size 的理论来源

**McCandlish, Kaplan, Amodei, OpenAI Dota Team 2018**, *An Empirical Model of Large-Batch Training* · [arXiv:1812.06162](https://arxiv.org/abs/1812.06162)

$$\mathcal{B}\_{\text{simple}}=\frac{\operatorname{tr}\Sigma}{|G|^2},\qquad \mathcal{B}\_{\text{noise}}=\frac{\operatorname{tr}(H\Sigma)}{G^\top H G}$$

$\Sigma$ = 逐样本梯度协方差，$H$ = Hessian。$\mathcal{B}\_{\text{simple}}$ 是可廉价估计的代理量。Pareto 前沿：

$$\left(\frac{S}{S\_{\min}}-1\right)\left(\frac{E}{E\_{\min}}-1\right)=1,\qquad B\_{\text{crit}}=\frac{E\_{\min}}{S\_{\min}}$$

在 $B=B\_{\text{crit}}$ 处，步数与样本数各为最小值的 2×——即"训练速度降至最大可能值的 50%"的拐点。$B\_{\text{crit}}$ 在训练过程中**随时间增长**（噪声尺度随 loss 下降而上升）。

#### 5.4.4 weight decay 也有律

**Bergsma, Dey, Gosal, Gray, Soboleva, Hestness 2025**, *Power Lines: Scaling Laws for Weight Decay and Batch Size in LLM Pre-training* · Cerebras · [arXiv:2505.13738](https://arxiv.org/abs/2505.13738)

定义 AdamW 的 EMA 时间尺度（以数据集为单位）$\tau = \dfrac{B}{\eta\lambda D}$，则：

$$\tau\_{\text{opt}}(\text{TPP})=1.084\cdot \text{TPP}^{-0.527},\qquad \text{TPP}=D/N$$

反解得 $\lambda\_{\text{opt}}=\dfrac{B\cdot\text{TPP}^{0.527}}{1.084\,\eta\,D}$。含义：**1 TPP 时 $\tau\_{\text{opt}}\approx 1.0$，1000 TPP 时降到 ≈0.03**——这正是 §4.1 中"过训练时最优 weight decay 大一个数量级"的定量版本。

批量方面：$B\_{\text{crit}}\propto D^{0.47}$，$B\_{\text{opt}}$ 指数区间 (0.367, 0.391)。**与 Step Law 独立互证"$B\_{\text{opt}}$ 由 $D$ 决定、与 $N$ 无关"**，但指数值 0.37 vs 0.57 尚有分歧。2026 年 Schaipp 的 *How to Allocate Your Tokens?*（[arXiv:2607.01487](https://arxiv.org/abs/2607.01487)）给出 $M^\*=0.667\,D^{0.566}$，与 Step Law 高度吻合，并指出**5% 算力浪费容忍下，$\varepsilon$-次优 batch size 区间宽约 4 倍**。

### 5.5 多模态：竞争壁垒与数据配比

**Aghajanyan, Yu, Conneau, Hsu, Hambardzumyan, Zhang, Roller, Goyal, Levy, Zettlemoyer 2023**, *Scaling Laws for Generative Mixed-Modal Language Models* · [arXiv:2301.03728](https://arxiv.org/abs/2301.03728) (ICML 2023)

| 模态 | $A$ | $B$ | $E$ | $\alpha$ | $\beta$ |
| --- | --- | --- | --- | --- | --- |
| Text | 492.51 | 1987.40 | 2.42 | 0.18 | 0.22 |
| Code | 611.91 | 4484.08 | 0.16 | **0.37** | 0.32 |
| Image | 340.96 | 875.30 | 2.84 | **0.13** | 0.13 |
| Speech | 154.45 | 205.10 | 3.02 | 0.31 | 0.24 |
| Image-Text | 320.51 | 658.31 | 2.47 | 0.12 | 0.11 |
| Molecules | 158.19 | 189.36 | 2.39 | 0.37 | 0.26 |

值得注意：**图像/图文的指数最小（$\alpha\approx0.12\text{–}0.13$），代码/分子最大（$\approx0.37$）**。这直接解释了为什么视觉模态"堆规模"的回报明显低于代码。

#### 竞争壁垒

$$\mathcal{L}(N,D\_i,D\_j)=\frac{\mathcal{L}(N,D\_i)+\mathcal{L}(N,D\_j)}{2}-C\_{i,j}+\frac{A\_{i,j}}{N^{\alpha\_{i,j}}}+\frac{B\_{i,j}}{(|D\_i|+|D\_j|)^{\beta\_{i,j}}}$$

即"独立建模的平均值 − 协同常数 + 两个竞争项"。协同的条件：

$$C\_{i,j}\;>\;\frac{A\_{i,j}}{N^{\alpha\_{i,j}}}+\frac{B\_{i,j}}{(|D\_i|+|D\_j|)^{\beta\_{i,j}}}\quad\Longrightarrow\quad \textbf{协同}$$
> [!IMPORTANT]
> **一个漂亮的定性预言**
> 左侧 $C\_{i,j}$ 是**常数**，右侧随 $N,D$ 增大而**衰减**。因此**足够大的规模必然从"模态竞争"翻转为"模态协同"**。实证：Speech|Text 配对在 **$N\approx 30$B、$D\approx 45$B tokens** 处越过壁垒。  
> 这解释了为什么早期多模态模型总是"加了图像，文本变差"，而现在的大模型不再有这个问题——不是技术变了，是规模越过了壁垒。

#### 数据分布可以改变 scaling 指数

**Cherti, Beaumont, Wightman, Wortsman, Ilharco, Gordon, Schuhmann, Schmidt, Jitsev 2023**, *Reproducible scaling laws for contrastive language-image learning* · [arXiv:2212.07143](https://arxiv.org/abs/2212.07143) (CVPR 2023)

| 任务（$E=\beta C^{\alpha}$ 的 $\alpha$） | OpenCLIP (LAION) | OpenAI CLIP (WIT-400M) |
| --- | --- | --- |
| ImageNet 零样本 top-1 误差 | −0.11 | **−0.16** |
| ImageNet 鲁棒性数据集 | −0.13 | −0.24 |
| MS-COCO 零样本检索 | **−0.08** | −0.05 |
| Flickr30K 零样本检索 | **−0.19** | −0.10 |

**同样的 CLIP 架构，不同的预训练数据集 → 不同的 scaling 指数，且方向随任务翻转**：WIT-400M 在分类上更陡，LAION 在检索上更陡。这是"**数据可以改指数**"最干净的证据，也是对 §5.3 的重要补充。

#### 多模态数据配比：MM1 的消融

**McKinzie, Gan, Fauconnier et al. 2024**, *MM1: Methods, Analysis & Insights from Multimodal LLM Pre-training* · Apple · [arXiv:2403.09611](https://arxiv.org/abs/2403.09611) (ECCV 2024)

-   **组件重要性排序**：图像编码器 + 分辨率 + image token 数 ≫ 视觉-语言 connector 设计（后者"几乎可忽略"）。分辨率 224→336 约 +3%；编码器 ViT-L→ViT-H <+1%。
-   **数据配比：caption : interleaved : text-only = 45 : 45 : 10**
    -   **零样本**主要靠 caption（占比提升带来 25.8% → 39.3%）
    -   **少样本（4/8-shot）**主要靠 interleaved：interleaved 低于 50% 时 8-shot 从 61%+ **崩到 43.7%**
    -   text-only 用于维持语言能力
-   MLLM 学习率律：$\eta = \exp(-0.4214\ln N - 0.5535)$，即 $\eta\propto N^{-0.4214}$。⚠️ 与 Step Law 的 $N^{-0.713}$ 差异大，因为 $D$ 的处理方式不同，**不可直接比较**。

#### 原生多模态：early vs late fusion

**Shukor, Fini, da Costa, Cord, Susskind, El-Nouby 2025**, *Scaling Laws for Native Multimodal Models* · Apple · [arXiv:2504.07951](https://arxiv.org/abs/2504.07951) (ICCV 2025 Oral)

|  | $\alpha$ | $\beta$ | $a$ | $b$ |
| --- | --- | --- | --- | --- |
| Early-fusion（原生多模态） | 0.301 | 0.335 | **0.526** | 0.473 |
| Late-fusion（接视觉编码器） | 0.290 | 0.338 | 0.636 | 0.462 |

同预算下两者 loss 相当，但 **early-fusion 所需参数更少**（$a$ 更小 = 更偏向堆数据），训练更省、部署更简单。另外：**image-caption 占比越高，$a$ 越小、$b$ 越大**——图像 token 占比高时，"训练更久"比"做更大"更划算。稀疏 early-fusion（MoE）下 $\beta=0.372$ 远大于稠密情形，意味着 **MoE 下 token 数比 active 参数更重要**；模态无关路由优于模态感知路由（模型会自发学出模态特化的权重）。

### 5.6 上下文长度与迁移

#### 上下文长度

**Xiong et al. 2023**, *Effective Long-Context Scaling of Foundation Models* · Meta (Llama 2 Long) · [arXiv:2309.16039](https://arxiv.org/abs/2309.16039)

$$L(c)=\left(\frac{\alpha}{c}\right)^{\beta}+\gamma$$

| 模型 | $\alpha$ | $\beta$ | $\gamma$ |
| --- | --- | --- | --- |
| 7B | 25.4 | 0.45 | 1.56 |
| 13B | 19.5 | 0.48 | 1.45 |
| 34B | 17.7 | 0.50 | 1.41 |
| 70B | 17.9 | 0.51 | 1.35 |

$\beta$ 随模型增大缓慢上升（0.45 → 0.51）——**大模型更会用长上下文**；$\gamma$ 随规模下降。这是目前唯一被广泛引用的、形式干净的上下文长度幂律。

⚠️ 但它不是无条件的。**Shi et al. 2025**（[arXiv:2502.01481](https://arxiv.org/abs/2502.01481)）把交叉熵分解为 $H(P,Q\_l)=R\_{\text{Bayes}}+L\_{\text{Approximate}}$，论证**存在有限的最优上下文长度，且由训练数据量决定**：越过临界点后近似误差项主导，验证 loss 反而上升。总体判断：**上下文长度维度尚无被广泛复现的系统性规律**。

#### 迁移与微调

**Hernandez, Kaplan, Henighan, McCandlish 2021**, *Scaling Laws for Transfer* · OpenAI · [arXiv:2102.01293](https://arxiv.org/abs/2102.01293)

$$\boxed{\;D\_T=k\,(D\_F)^{\alpha}\,N^{\beta}\;}$$

$D\_T$ = 有效迁移数据（预训练"值多少"微调数据），$D\_F$ = 微调数据集大小，$N$ = 非嵌入参数量。

| 预训练分布 | $k$ | $\alpha$ | $\beta$ |
| --- | --- | --- | --- |
| Text → Python | $1.9\times10^4$ | 0.18 | **0.38** |
| 50% Text + 50% 非 Python 代码 → Python | $2.1\times10^5$ | 0.096 | **0.38** |

1.  **$\beta=0.38$ 在两种预训练分布下完全一致**——迁移收益对模型规模的依赖是**预训练数据无关**的常数指数。模型越大，预训练的"数据倍率"越高。
2.  $\alpha<1$ 意味着**微调数据越多，迁移的边际价值越低**。分布越接近，$\alpha$ 越小（0.096 vs 0.18），倍率衰减越慢。
3.  **骨化（ossification）**：当 $D\_F/D(N)>0.10$（微调数据超过该尺寸模型"应有"数据量的 10%）时，**小模型的微调结果劣于从头训练**——权重饱和，无法再吸收新信息。所有拟合仅在低数据区间验证。

## 6 · Test-time 与 RL Scaling

### 6.1 三条正交的轴

| 轴 | 变量 | 典型曲线形状 | 代表工作 |
| --- | --- | --- | --- |
| 预训练 | $N$、$D$ | **幂律** $L=E+A/N^\alpha+B/D^\beta$ | Chinchilla |
| 训练期 RL | RL compute $C\_{RL}$ | **S 型饱和**，有渐近上限 $A$ | ScaleRL (2510.13786) |
| 测试期 | 样本数 $k$、思考 token 数 $T$ | **覆盖率对 $\log k$ 近线性；最终准确率饱和甚至反转** | Snell'24, Brown'24 |

> [!IMPORTANT]
> **2025 → 2026 的核心叙事变化**
> **从"test-time compute 是免费午餐" → "受 verifier 与 base model support 双重封顶"；  
> 从"RL 是新的幂律" → "RL 是 sigmoid，算法主要买效率而不是上限"。**

### 6.2 Test-time scaling 的基础工作

#### Snell et al. 2024：compute-optimal 的测试期分配

必读**Snell, Lee, Xu, Kumar 2024**, *Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters* · UC Berkeley / Google DeepMind · [arXiv:2408.03314](https://arxiv.org/abs/2408.03314)

两类机制：**(1) 搜索 / verifier 引导**（对 PRM 做 best-of-N、beam search、lookahead search）；**(2) 修改提议分布**（让模型顺序修订自己的答案）。

$$\theta^{\*}\_{q}(N)=\arg\max\_{\theta}\\ \mathbb{E}\_{y\sim\text{Target}(\theta,N,q)}\left[\mathbb{1}\_{y=y^{\*}(q)}\right]$$

即对每个 prompt $q$ 与预算 $N$ 选最优的测试期超参 $\theta$。实践中用**难度分箱**近似：按 base LLM 的 pass@1 把题目分成 5 个 quantile bin，每个 bin 用各自最优策略——难度 bin 是近似最优策略的"充分统计量"。

-   Compute-optimal 分配相比 naive best-of-N 有 **\>4×** 的测试期算力效率提升。
-   **FLOPs-matched 对比**：小模型 + test-time compute 可以胜过 **14× 大**的模型——但**仅限于小模型已有 non-trivial 成功率的题目**。
-   **兑换率**：令 $R = D\_{\text{inference}}/D\_{\text{pretrain}}$。$R\ll 1$（低流量、自我改进流水线）→ test-time compute 更划算；$R\gg 1$（大规模线上服务）→ 加预训练参数更划算。**难题上 test-time compute 无法替代预训练。**

#### Brown et al. 2024：覆盖率的对数线性 scaling

必读**Brown, Juravsky, Ehrlich, Clark, Le, Ré, Mirhoseini 2024**, *Large Language Monkeys: Scaling Inference Compute with Repeated Sampling* · [arXiv:2407.21787](https://arxiv.org/abs/2407.21787)

$$\text{pass@}k=\frac{1}{|\mathcal{P}|}\sum\_{i\in\mathcal{P}}\left(1-\frac{\binom{N-C\_i}{k}}{\binom{N}{k}}\right),\qquad c(k)\approx\exp\left(a\,k^{-b}\right)$$

覆盖率（pass@k）对 $\log k$ 近似线性，跨 **4 个数量级**。SWE-bench Lite 上 DeepSeek-Coder-V2-Instruct 从 **15.9%（1 样本）→ 56%（250 样本）**，超过当时单样本 SOTA 43%。

> [!WARNING]
> **但覆盖率不等于准确率——这是全文最重要的负面结论**
> 在没有自动 verifier 的领域，**majority voting 与 reward model 在几百个样本后就停止提升**，无法把 coverage 兑现为 accuracy。  
> 直观分解：$\text{Accuracy}=\text{Coverage}\times\text{Precision of selection}$。Coverage 随 $k$ 单调涨，Precision 随 $k$ 单调跌（更多干扰项），乘积很快封顶。**有可执行 verifier 的领域（代码、形式化数学）和没有的领域（开放问答），test-time scaling 的天花板完全不同。**

另有 **Wu et al. 2024**（[arXiv:2408.00724](https://arxiv.org/abs/2408.00724)）系统对比 greedy / majority voting / BoN / weighted voting / MCTS / REBASE：Llemma-7B + REBASE 在等 FLOPs 下持续优于 Llemma-34B；并指出 **majority voting 在大 budget 下会饱和甚至出现 inverse scaling**。

理论侧的一个简洁解释（**Levi 2024**, [arXiv:2410.16377](https://arxiv.org/abs/2410.16377)）：假设 per-problem 错误率服从 Zipf 幂律，则 $\text{pass@}k\_i=1-p\_i^{k}$ 聚合后得 $\mathcal{L}\_k\propto k^{-\beta}$。这与 §1.2 是同一套长尾直觉。

#### 工程基线（可复现）

HuggingFace 的开源复现（Beeching, Tunstall, Rush, 2024-12）：Llama-3.2-1B-Instruct + PRM，MATH-500 上 **$N=32$ 时 1B ≈ Llama-3.1-8B；$N=256$ 时 3B > Llama-3.1-70B（22×）**。策略选择规律：$N$ 小时 beam search 比 BoN 算力效率高 4×；BoN 擅长易题与大 $N$；DVTS 擅长大 $N$（靠多样性）。

⚠️ 但 **Liu et al. 2025**（[arXiv:2502.06703](https://arxiv.org/abs/2502.06703)）给出重要限定：compute-optimal TTS 策略**同时依赖 policy model、PRM、题目难度**三者，**不存在通用最优**；且 **PRM 不可跨 policy 迁移**，在 OOD policy 上容易被 reward hacking。他们那些"1B > 405B"的标题数字是特定 benchmark + 特定 PRM 下的结果，泛化性受质疑。

### 6.3 o1 / R1：双轴曲线与响应长度的自发增长

#### OpenAI o1（2024-09）

官方给出两张图：**y 轴 = AIME pass@1，x 轴 = compute（log scale）**，分别对应 train-time RL compute 与 test-time compute，措辞是 *"o1 performance smoothly improves with both train-time and test-time compute."*

⚠️ **OpenAI 从未公布任何拟合系数、绝对 FLOPs 或函数形式**。"双对数线性"是社区从图上目测的描述，引用时应标注为"定性图示，非公开的定量 scaling law"。

数字：AIME 2024 单样本 74%，64 样本 consensus 83%，1000 样本 + learned reranker 93%。**GPQA Diamond 单样本 77.3%，64 样本 consensus 78.0%**——多数投票只带来 +0.7pt，这是"投票饱和"最干净的公开证据。

#### o3 on ARC-AGI（2024-12）

半私有集：**低算力 75.7%（约 20 美元/题）；高算力 87.5%（约 172× 算力）**。这是"test-time compute 换准确率"最极端的公开数据点：**172× 算力换约 12pt**——边际收益极低但仍为正。

#### DeepSeek-R1（2025-01）

必读**DeepSeek-AI 2025**, *DeepSeek-R1* · [arXiv:2501.12948](https://arxiv.org/abs/2501.12948)（后发表于 Nature 2025）

-   R1-Zero：**纯 RL（GRPO），无 SFT 冷启动**；奖励 = 规则式 accuracy reward + format reward，**刻意不用 neural RM 以避免 reward hacking**。
-   **响应长度随 RL 步数自发增长**：平均长度从数百 token 单调增长到数千 token。关键在于——**RL 并没有直接优化长度，长度是 accuracy reward 的涌现副产物**。这是训练期 RL 与测试期 compute 的耦合点。
-   AIME 2024 pass@1：**15.6% → 71.0%**；majority voting@64 → 86.7%（≈ o1-0912）。
-   "Aha moment"：中间 checkpoint 自发出现回溯/自我反思措辞。

同期的 **Kimi k1.5**（[arXiv:2501.12599](https://arxiv.org/abs/2501.12599)）明确把 **context length scaling** 作为 RL 的 scaling 轴，并引入 length penalty 与 long2short 蒸馏来控制 token 效率。

### 6.4 verifier 是天花板

#### 多数投票的理论上限

$$\lim\_{N\to\infty}\text{MV@}N=\mathbb{E}\_{q}\left[\mathbb{1}\left(\arg\max\_{a}p\_\pi(a\mid q)=a^{\*}(q)\right)\right]$$

$N\to\infty$ 的极限就是"取采样分布的众数"。收敛速率由大偏差原理给出，是 **$N$ 的指数**——很快就贴近上限，所以实践中 $N\gtrsim 64$ 后基本无收益（对照 o1 GPQA 的 +0.7pt）。**上限只取决于"众数是否正确"，与预算无关。**

#### RM 过优化

**Gao, Schulman, Hilton 2023**, *Scaling Laws for Reward Model Overoptimization* · [arXiv:2210.10760](https://arxiv.org/abs/2210.10760)

以 $d=\sqrt{\mathrm{KL}}$ 为自变量：$R\_{\text{bo}n}(d)=d(\alpha\_{\text{bo}n}-\beta\_{\text{bo}n}d)$，$R\_{\text{RL}}(d)=d(\alpha\_{\text{RL}}-\beta\_{\text{RL}}\log d)$（⚠️ 未从原文逐字确认，请核对 §3）。BoN 的 KL 有闭式 $\mathrm{KL}\_{\text{bo}n}=\log n-\frac{n-1}{n}$——**$n$ 增大 KL 只对数增长，所以 BoN 的过优化相对温和**，但仍有明确峰值后回落。

#### 不完美 verifier 的硬天花板

**Stroebl, Kapoor, Narayanan 2024**, *Inference Scaling fLaws: The Limits of LLM Resampling with Imperfect Verifiers* · Princeton · [arXiv:2411.17501](https://arxiv.org/abs/2411.17501)

若 verifier 的 false-positive rate 为 $\epsilon>0$，重采样**无法**把它降到 0，从而形成硬天花板。实证：HumanEval / MBPP 上模型单样本准确率与 FP rate 强相关 → **弱模型不能靠 resample 追上强模型**。实践含义：现实假设下 **compute-optimal 的样本数可能 <10**。

#### 但也有乐观结果

**Zhao, Awasthi, Gollapudi 2025**, *Sample, Scrutinize and Scale* · Google · [arXiv:2502.01839](https://arxiv.org/abs/2502.01839)

**Implicit scaling**：采样池变大本身会提升 self-verification 的准确率（可以互相比较、定位幻觉位置）。极简的"随机采样 + 自我验证"让 Gemini 1.5 Pro 超过 o1-Preview。两个关键 trick：**(a) 跨候选比较而非孤立打分；(b) 改写成易验证的形式**（CoT 便于推理但不便于验证）。同时指出前沿模型的 out-of-box 验证能力**出奇地弱**。

Microsoft 的大规模评估（[arXiv:2504.00294](https://arxiv.org/abs/2504.00294)，9 模型 × 8 领域）给出综合判断：**inference scaling 的收益随问题复杂度上升而衰减；但所有模型都从 perfect verifier / 强反馈中大幅获益 → verifier 是主要抓手**。

2026 年的新机制解释：**ARBITER**（[arXiv:2605.26172](https://arxiv.org/abs/2605.26172)）形式化了"**wrong-majority**"——正确答案已在采样池中，但输给了更大的错误 basin。多数投票选的是**最稳定**的 basin 而非**最正确**的。

### 6.5 s1：最简洁的 test-time scaling

推荐**Muennighoff, Yang, Shi, Li, Fei-Fei, Hajishirzi, Zettlemoyer, Liang, Candès, Hashimoto 2025**, *s1: Simple test-time scaling* · [arXiv:2501.19393](https://arxiv.org/abs/2501.19393)

1.  **s1K**：1000 条题目 + 推理轨迹，按 difficulty / diversity / quality 三准则从 59K 候选中筛选；Qwen2.5-32B-Instruct 上 SFT 仅需 **26 分钟 / 16×H100**。
2.  **Budget forcing**：上界 = 强制插入 end-of-thinking delimiter + "Final Answer:" 提前截断；下界 = **抑制 end-of-thinking token，追加 "Wait"**，逼模型继续思考。

他们提出的三个评价维度值得当作 TTS 方法的通用 checklist：**Control**（落在指定 token 区间的比例）、**Scaling**（分段线性拟合的平均斜率，须为正）、**Performance**（最高分）。

| 方法（AIME24） | Control | Scaling | Performance |
| --- | --- | --- | --- |
| **Budget forcing** | **100%** | **15** | **56.7%** |
| Token-conditional | 40% | −24 | 40.0% |
| Step-conditional | 60% | 3 | 36.7% |
| Majority voting | n/a | n/a | ~40% |

逐步增加抑制次数：baseline 50.0% → 2× ≈ 53.3% → 4× ≈ 55% → **6× 56.7%（峰值）→ 之后趋平**。

**失效模式很有信息量**：抑制 end-of-thinking 过于频繁会让模型进入**重复循环**而非继续有效推理——这是"顺序 TTS 天然有上限"的直接机制证据。

### 6.6 RL compute 是 S 曲线，不是幂律

必读**Khatri, Madaan, Tiwari, Bansal, Duvvuri, Zaheer, Dhillon, Brandfonbrener, Agarwal 2025**, *The Art of Scaling Reinforcement Learning Compute for LLMs* · Meta 等 · [arXiv:2510.13786](https://arxiv.org/abs/2510.13786) · **\>400,000 GPU-hours (GB200)**

$$\boxed{\;R\_C-R\_0=(A-R\_0)\cdot\frac{1}{1+\left(\dfrac{C\_{\text{mid}}}{C}\right)^{B}}\;}$$

| 参数 | 含义 |
| --- | --- |
| $A\in[0,1]$ | **渐近 pass rate（天花板）** |
| $B>0$ | **算力效率 / 曲线陡度** |
| $C\_{\text{mid}}$ | 拐点算力 |
| $R\_0$ | 初始性能 |

> [!IMPORTANT]
> **最重要的方法论结论：$A$ 与 $B$ 解耦**
> **影响天花板 $A$ 的**：损失函数类型（**CISPO / GSPO > DAPO**）、**LM head 用 FP32 logits**、batch size、zero-variance filtering。  
> **只影响效率 $B$ 的**：异步基础设施（PipelineRL）、数据 curriculum、长度惩罚、prompt filtering、loss aggregation、normalization、off-policy 细节。  
> 推论：**小规模实验里"看起来更好"的 trick，很多只是提前爬坡，并不改变天花板。** 评估一个 RL 算法改进时，正确的问法是"**你改的是 $A$ 还是 $B$？**"——必须用早期曲线外推 $A$ 来判断，不能只看某个算力点的分数。

**ScaleRL 配方**（8 项）：PipelineRL-8 异步；CISPO 损失；LM head FP32；forced interruption 控制长度；batch-level advantage normalization；zero-variance filtering + adaptive prompt filtering；no-positive-resampling；prompt-level loss averaging。

**外推验证**：用 ≤50k GPU-hours 的曲线拟合，成功预测 8B dense 模型在 100k GPU-hours 处的表现；MoE（17B×16）同样成立。ScaleRL 达到 $A=0.61$，优于 DeepSeek-GRPO / Qwen2.5-DAPO / Magistral / MiniMax 的配方。

#### 模型规模与 RL 效率

**Scaling Behaviors of LLM RL Post-Training** · [arXiv:2509.25300](https://arxiv.org/abs/2509.25300) (ACL 2026) · Qwen2.5 0.5B–72B

$$\log L(N,X)=-k(N)\log X+E(N),\qquad k(N)=\frac{K\_{\max}}{1+N\_0/N}$$

$X$ = 资源（算力/数据），$k(N)$ = 学习效率，$R^2>0.99$。结论：

-   大模型学习效率一致更高，但 **$k(N)$ 有饱和上限，>32B 后边际收益明显递减**；固定算力约束下大模型甚至会输给小模型。
-   **RL 阶段数据可复用：重复 25× 仍无显著退化**——"总优化步数"比"样本唯一性"更关键。（与 §4.1 预训练阶段的 4-epoch 阈值形成有趣对比。）
-   **域内泛化强、跨域几乎不迁移**：数学 RL → 数学子领域好，→ code/logic/science 几乎无迁移。

#### 采样算力怎么分配（2026）

**Cheng, Xie, Qu, Setlur, Hao et al. 2026**, *IsoCompute Playbook: Optimally Scaling Sampling Compute for LLM RL* · UCSD / CMU · [arXiv:2603.12151](https://arxiv.org/abs/2603.12151)

$$C = B\_p \cdot n \cdot M$$

$B\_p$ = 每 batch 题目数，$n$ = 每题并行 rollout 数，$M$ = 顺序更新步数。

-   最优 rollout 数 $n^\*(C)$ 在 log-log 空间呈 **sigmoid**：随预算可预测增长，然后饱和。
-   **低预算 → 优先加 $B\_p$（更多题）；高预算 → 转向加 $n$（每题更多 rollout）。** $B\_p$ 主要是稳定性旋钮。
-   **难度分化的机制**：易题的增益来自 **solution sharpening**（worst@k 提升），可容忍大 $n$（饱和于 $n\approx512$）；难题的增益来自 **coverage expansion**（best@k 提升），最优 $n$ 更小（64–128）。

与之互相印证的是 **BroRL**（NVIDIA, [arXiv:2510.01180](https://arxiv.org/abs/2510.01180)）：ProRL 在约 3K 步后 plateau，把 rollout 从 16 提到 **512** 后**复活了饱和的模型**。

另外两条 2026 的重要发现：

-   **Where Should RL Post-Training Compute Go?**（[arXiv:2607.13389](https://arxiv.org/abs/2607.13389)）：分解 $C\_{\text{total}}=C\_{\text{search}}+C\_{\text{learning}}+C\_{\text{reward}}$。**不存在通用最优分配**——规则式奖励偏向高更新比 $\rho\approx0.72$，**PRM（需计入 RM 推理开销）$\rho\approx 0.44$**；且训练 reward / 下游准确率 / 过程质量三个评测目标会给出不同的最优分配。**报告 scaling 结论时必须写明优化目标。**（⚠️ 规模较小，1.5B–7B + LoRA。）
-   **RLVE**（[arXiv:2511.07317](https://arxiv.org/abs/2511.07317)）：**环境数量是新的 scaling 轴**。400 个程序化生成的自适应难度环境，在已饱和的 ProRL-1.5B-v2 上用 ~1,100 H100-hours 拿到 **+3.37%**，而继续原训练用 3,600+ hours 只有 +0.49%。**256 个环境 ≫ 单环境**——多样性比数据量更重要。

> [!WARNING]
> **一个常见的引用错误**
> **"Predictable Scale: Part I (Step Law)"（arXiv:2503.04715）是预训练超参的 scaling law，不是 RL scaling law。** 它经常被错误地放进 RL scaling 的文献列表。它的内容见本笔记 §5.4.2。

### 6.7 过度思考与反向 scaling

**Zhou, Ling, Chen, Wang, Fan, Wang 2026**, *When More Thinking Hurts: Overthinking in LLM Test-Time Compute Scaling* · [arXiv:2604.10739](https://arxiv.org/abs/2604.10739)

目前**关于"准确率 vs thinking tokens"曲线形状最细的公开数据**（R1-32B / AIME）：

| 指标 | 数值 |
| --- | --- |
| 每 500 token 的边际效用（早期） | **+3.2%** |
| 边际效用转负的位置 | **~12,000 token** |
| 负翻转开始占优 | ~7,000 token |
| 16,000 token 处的负:正翻转比 | **7.55 : 1** |
| 曲线形状 | **倒 U**：12,000 token 处峰值 55.8%，16,000 token 降至 54.9% |

-   **难度依赖**：Level 1–2 易题在 **~1,500 token** 就达峰；Level 5 难题受益到 **~8,000 token** → **统一 budget 是次优的**。
-   成本感知效用函数（$\lambda=0.5$）在 6,000 token 处停止 → **算力减半，准确率仅损失约 6%（相对）**。

**Gema et al. 2025**, *Inverse Scaling in Test-Time Compute* · Anthropic · [arXiv:2507.14417](https://arxiv.org/abs/2507.14417)

四类任务上出现明确的**反向 scaling**：带干扰项的简单计数、含伪特征的回归、需约束追踪的演绎、advanced AI risks 评测。**失效模式还是模型族特有的**：Claude 系列越想越容易被无关信息带偏；OpenAI o 系列抗干扰但过拟合问题框架（锁死初始解读）。安全相关的观察：延长推理会放大 Claude Sonnet 4 的自我保存倾向表达。

其他重要的负面/边界结果：

-   **知识密集型任务上 TTS 基本无效**（[arXiv:2509.06861](https://arxiv.org/abs/2509.06861)，NUS）：12 个推理模型 × SimpleQA + FRAMES，推理长度拉长 10× 后准确率**不一致提升**，部分模型**幻觉反而上升**；幻觉下降主要来自"选择弃答"而非事实召回改善。但**开/关 thinking mode 本身仍有效**（FRAMES 上最高 +34%）。
-   **并行与顺序 scaling 收敛到同一上界**（*Scaling over Scaling*, [arXiv:2505.20522](https://arxiv.org/abs/2505.20522)）：提出 TTSPM，把两条路径统一为同一饱和曲线 $F(N)\to F\_{\max}$ 并给出饱和点的解析估计。
-   Apple 的 *The Illusion of Thinking*（[arXiv:2506.06941](https://arxiv.org/abs/2506.06941)）报告复杂度超阈值后准确率崩到 0，且推理 token 数在崩塌前反而下降（"放弃思考"）。⚠️ 该文方法论争议很大（token 上限、含不可解实例），引用时应同时标注 Lawsen 的反驳。

### 6.8 pass@k 之争：RL 到底有没有扩展能力边界

#### 悲观方：RL 只是"锐化"采样分布

必读**Yue et al. 2025**, *Does RL Really Incentivize Reasoning Capacity in LLMs Beyond the Base Model?* · [arXiv:2504.13837](https://arxiv.org/abs/2504.13837) (NeurIPS 2025 Oral)

-   **小 $k$ 时 RLVR 模型胜出，大 $k$ 时 base model 反超** → RLVR 提升的是**采样效率**而非能力边界。
-   Coverage + perplexity 分析显示 RL 产生的正确解**全部落在 base model 的分布内**。
-   六种主流算法（PPO/GRPO/Reinforce++/RLOO/ReMax/DAPO）差异不大，且离"充分挖掘 base model 潜力"很远。
-   **对照组结论最有操作价值：蒸馏确实能引入新的推理模式、扩展边界。**

**Wu, Xuan, Lu et al. 2025**, *The Invisible Leash: Why RLVR May or May Not Escape Its Origin* · [arXiv:2507.14843](https://arxiv.org/abs/2507.14843)

**support 约束**：RLVR 是 support-constrained optimization，无法给 base model 零概率的解分配质量。**entropy–reward tradeoff**：pass@1 单调涨的同时探索面单调收窄。一个反直觉现象：**token-level entropy 可能上升，但 answer-level entropy 下降**（多样中间路径收敛到少数最终答案）。

**Rethinking RL for LLM Reasoning** · [arXiv:2605.06241](https://arxiv.org/abs/2605.06241)（2026-05）—— 机制层面最锋利的证据

-   RL 只改动生成中 **1–3% 的 token 位置**，集中在高熵决策点。
-   被提升的 token 在 base model 分布中**平均排名 ~2**——"几乎从不发明新 token，只是提拔模型本来就在考虑的那个"。
-   **Oracle 干预（因果验证）**：只替换这些分歧点即可精确复现 RL 的全部收益，随机替换则不行。
-   base model 自身的 entropy 就能定位干预点，**无需访问 RL 模型**。
-   一个 **0.27–0.49% 参数的 LoRA**、在 **100 道题**上做 KL 蒸馏，即可捕获 RL 的全部分布变化 → 成本降约 **3 个数量级**。

#### 乐观方：RL 能扩展边界

**Liu et al. 2025**, *ProRL: Prolonged RL Expands Reasoning Boundaries* · NVIDIA · [arXiv:2505.24864](https://arxiv.org/abs/2505.24864) (NeurIPS 2025)

配方：**KL 控制 + reference policy resetting + 多样任务**，训练 2000+ 步。在**大 $k$ 下仍全面超过 base**，包括"base model 无论采多少次都 0 分"的任务。**但成立条件很关键**：边界扩展与 (a) base model 在该任务上初始能力弱、(b) 训练时长足够 强相关。

> [!IMPORTANT]
> **2026 的收敛判断**
> **争论的两方在测量不同的东西。**  
> 悲观派测的是"**在 base model 覆盖良好的数学基准上**，RL 是否把概率质量从错误重排到正确" → 答案是"主要是重排"。  
> 乐观派测的是"**在 base model 覆盖近零的新任务 / 长训练 / 多环境下**" → 答案是"能扩展"。  
> 2026 年的共识倾向是：**$p\_{\text{base}}$ 是决定性的调节变量。RL 在 base 成功率的"能力边缘"处产生真实增益，在两端（太易 / 太难）分别只做锐化或什么都不做。**

#### 2026 的方法论釜底抽薪与机制解释

-   **Beyond Pass@k**（[arXiv:2510.08325](https://arxiv.org/abs/2510.08325), ICLR 2026）：指出**大 $k$ 的 pass@k 在离散答案空间上退化为"蒙对概率"**，提出 `cover@τ` 等 breadth-depth 指标替代。这直接质疑了整场争论所依赖的度量。
-   **When RLVR Shrinks the Reasoning Boundary**（Harvard, [arXiv:2607.20543](https://arxiv.org/abs/2607.20543), 2026-07）—— 目前最清晰的**机制解释**：
    -   Pass@k inversion 集中在 **boundary prompts**：base 成功率 $p<0.10$ 但 256 次采样内可解。
    -   机制 = **有限样本承诺失败**：当 $p\lesssim 1/G$（$G$ = rollout group size）时大部分 batch 全零 → 无局部纠正信号；与此同时**其他 prompt 的熵下降通过共享参数扩散过来**，在稀有正确分支被强化之前模型就已承诺到错误模式。
    -   四分层诊断：SolvedEasy（$p>0.6$，可安全锐化）/ Reachable（$0.10\le p\le0.60$）/ **Boundary（$p<0.10$ 但可恢复，高危）** / OutOfReach。
    -   方案 **PBA**：先用 $G\_0=8$ 次 rollout 估每题 base 成功率，对高危题施加向 base 分布的 KL 锚定 → pass@1 与高预算 coverage **同时提升**。

### 6.9 Agent 场景：均匀 scaling 会失效

**Scaling Test-time Compute for LLM Agents**（2025-06, [arXiv:2506.12928](https://arxiv.org/abs/2506.12928)）—— 首个系统性研究，四条与非 agent 场景**相反**的结论：

1.  **并行采样：BoN 虽最简单却最优**（优于 step-wise BoN、beam search、DVTS）。
2.  **顺序修订："知道何时该反思"比"每步都反思"更重要**——每步反思反而有害。
3.  **验证与合并：list-wise 方法优于 voting 与 pointwise scoring**（agent 轨迹长，孤立打分信息不足）。
4.  多智能体协作采样 > 单智能体多样化 rollout。

**Kim, Yang, Niu et al. 2026**, *Scaling Test-Time Compute for Agentic Coding* · [arXiv:2604.16529](https://arxiv.org/abs/2604.16529)（70 页）

问题：短输出的 TTS 方法在长时程 agent 上**直接失效**——每次尝试产生一整条动作/观察/错误/部分进展的轨迹，无法简单投票。两个方法：

-   **RTV（Recursive Tournament Voting）**：对 rollout 摘要做递归比较排序，而非无限增加尝试次数。
-   **PDR（Parallel-Distill-Refine）**：把前轮失败与成功蒸馏成洞察，作为新一轮尝试的条件。

结果（Claude-4.5-Opus）：**SWE-Bench Verified 70.9% → 77.6%；Terminal-Bench v2.0 46.9% → 59.1%**。核心论点：**agent 的 TTS 本质是 representation / selection / reuse**，把轨迹压缩成保留关键信息、丢弃噪声的结构化摘要。

**Lee, Erdogan, John et al. 2026**, *Agentic Test-Time Scaling for WebAgents (CATTS)* · UC Berkeley · [arXiv:2602.12276](https://arxiv.org/abs/2602.12276)

-   **均匀 scaling 收益极小甚至非单调**：WebArena-Lite 上 $N{=}10\to 20$ token 翻倍，成功率 **43.2% → 43.0%**。
-   提出两个 regime：**redundancy regime**（多数步骤高共识，加采样纯浪费）与 **contention regime**（关键步骤候选发散，加算力有效）。
-   核心原则：*"inference-time compute should be allocated **where it is likely to change the decision**."*
-   LLM 仲裁是双刃剑：低熵任务上仲裁 **−4.4%**，高熵任务 +4~6%；在高共识处强行 override 成功率 35.0% vs 46.9%。
-   CATTS 仅对 **40–60% 的步骤**触发仲裁 → WebArena-Lite **47.9%（+4.7pt），token 少 56%**。

**Pass@(k,T)** · [arXiv:2604.14877](https://arxiv.org/abs/2604.14877)（2026-04）

把静态 pass@k 扩展为二维（$k$ = 独立尝试数，$T$ = 每次尝试的环境交互轮数）。**与静态推理文献结论相反：工具使用 RL 确实扩展了 agent 的能力边界**——在组合式任务上，base 与 RL 模型的 pass 曲线**随 $k$ 增大而发散**（数学推理上则是收敛）。消融显示**同数据的 SFT 产生相反效果** → 因果机制是**探索**而非数据暴露。

### 6.10 三轴合一：2026 的方向

推荐**Roberts, Cho, Gao, Huang, Wu, Orlansky, Trost, Buchanan, Albarghouthi, Sala 2026**, *Test-Time Scaling Makes Overtraining Compute-Optimal (T² Scaling Laws)* · UW-Madison / Stanford · [arXiv:2604.01411](https://arxiv.org/abs/2604.01411)

$$\widehat{L}(N,D,k)=E+\frac{A}{N^\alpha}+\frac{B}{D^\beta}+\frac{G}{k^\gamma} \quad\text{s.t.}\quad 6ND\le C\_{\text{train}},\quad 2Nk\le C\_{\text{inf}}$$

把测试期采样数 $k$ 作为第三个变量加进 Chinchilla 形式，并加上双重算力约束。结论：**一旦把推理成本计入，最优预训练点"radically shift into the overtraining regime"**——这与 §4.4 的 Sardana 同向，但机制不同（Sardana 是推理量大，这里是**推理时要采多个样本**）。

**Shen, Li, Rahman, Sun et al. 2026**, *Understanding Reasoning from Pretraining to Post-Training* · [arXiv:2607.16097](https://arxiv.org/abs/2607.16097)

用国际象棋作可控 testbed，给出预训练↔RL 的联合 scaling law：

-   预训练 loss 可预测 post-RL 下游性能；
-   **局部 RL 斜率 ≈ 随 $\log$(预训练 token 数) 线性增长**；
-   小总预算下 RL 是 **initialization-limited**，总预算增大时应把**更大比例**分给 RL；
-   异质效应：易题上 RL 放大 SFT 已偏好的正确动作；**难题上 RL 能浮现 SFT 下几乎不存在的正确动作**（对 §6.8 是乐观派证据）。

> [!IMPORTANT]
> **2026 年的三个"结论转变"**
> **1\. 从"幂律"到"S 曲线 + 上限"。** ScaleRL 确立的 sigmoid 拟合已成默认范式，配套的 $A/B$ 解耦成了评估 RL 算法改进的标准问法。  
> **2\. 从"单轴 scaling"到"多资源联合分配"。** 2026 的主要工作都在做**约束优化**而非拟合单条曲线。工程上的实际问法从"给我更多 GPU"变成"$B\_p$ / $n$ / $M$ / $\rho$ / 环境数怎么分"。  
> **3\. 从"更多算力"到"算力该花在哪一步"。** CATTS 的 redundancy/contention 二分、agentic coding 的 RTV/PDR、overthinking 的难度自适应 budget、PBA 的 boundary-prompt 保护——都指向同一个更细粒度的原则：**在决策会被改变的地方花算力**。

> [!WARNING]
> **两个明确的"没找到"**
> ① 我**没有**找到 2026 年出现"test-time scaling 或 RL scaling 已终结/失效"的权威共识性论文；主流仍是"在正确的粒度上继续 scaling"。  
> ② 关于 2026 年前沿闭源模型（GPT-5.x / Gemini 3.x / Claude Opus 4.5–5 / Grok 4）的 test-time compute 具体 scaling 数据，**没有可信的一手技术报告级来源**，本笔记不予收录。

## 7 · 工程决策手册

把前面六章压缩成"遇到什么问题查什么"。

### 7.1 我要训一个模型，参数量和数据量怎么定？

| 你的情形 | 推荐做法 | 依据 |
| --- | --- | --- |
| 纯研究、只关心训练算力效率、数据充足 | **$D/N\approx 20$**，等比例扩展 | §2.3 Chinchilla（经 §2.5 修正后更可信） |
| 要部署、预期推理量 $\gtrsim 10^9$ 请求 | **模型取 Chinchilla 尺寸的 50–60%，token 数翻倍以上** | §4.4 Sardana |
| 要部署到边缘 / 显存受限 / 极致低延迟 | 激进过训练，$D/N$ 到 $10^3$ 量级也合理 | §4.4 Llama 3 8B (1875), Qwen3 0.6B (60k) |
| 唯一数据不够 | 先扫 weight decay，**≤4 epochs 基本免费**，强正则下可到 10 epochs | §4.1 Muennighoff / Fang |
| 推理时要采多个样本（reasoning 模型） | 进一步向过训练偏移 | §6.9 T² Scaling Laws |
| 确定要 INT4/INT8 PTQ 部署 | **警惕：过训练会加重量化掉点**（$\delta\_{\text{PTQ}}\propto D^{0.51}$）；考虑 QAT | §4.6 |

### 7.2 稠密还是 MoE？稀疏度怎么定？

-   **规模越大、训练越久 → 最优激活比越低。** 三条独立路线一致（§5.2）。
-   **激活比实操区间 5%–9%**（推理效率感知）；纯 loss 最优会更低但不划算。参照 DeepSeek-V3 的 37B/671B ≈ 5.5%。
-   **粒度 $G=d\_{\text{ff}}/d\_{\text{expert}}$：$G\_{\text{opt}}\approx 7$–8**（Zhao 2025 称与 $N,D$ 无关；Krajewski 称随预算从 8 增到 64——两者在常见预算区间大致重合）。**不要用"专家 = 完整 FFN"的默认设置。**
-   **共享专家占比 ~13%–31%** 都可以，性能差异可忽略。
-   **专家数上限**：$E\_{\max}\approx 300$–500 处饱和（Clark / Ludziejewski 独立给出相近值）。
-   **非结构化稀疏（剪枝）在通用硬件上难以兑现加速**，除非 2:4 结构化。MoE 才是训练+推理都真省的那种稀疏。

### 7.3 超参怎么设？

**顺序很重要：先定超参律，再拟合 loss 律。** 反过来做会得到被超参偏差污染的指数（§2.4 的教训）。

| 量 | 推荐公式 / 做法 | 来源 |
| --- | --- | --- |
| 学习率（跨宽度迁移） | muP：Adam 下隐层 $\eta\propto 1/d$，输出层 $\eta\propto 1/\text{fan\\_in}$、初始化方差 $1/\text{fan\\_in}^2$ | §5.4.1 |
| 学习率（直接给值） | $\eta\_{\text{opt}}=1.79\,N^{-0.713}D^{0.307}$ | §5.4.2 Step Law |
| batch size | $B\_{\text{opt}}=0.58\,D^{0.571}$；**只依赖 $D$，与 $N$ 无关**；容忍区间宽约 4× | §5.4.2 / 5.4.4 |
| weight decay | $\tau=\frac{B}{\eta\lambda D}$，$\tau\_{\text{opt}}=1.084\,\text{TPP}^{-0.527}$。**过训练时 $\lambda$ 要显著加大** | §5.4.4 / §4.1 |
| warmup | **随模型规模缩放，不要固定步数** | §2.4 Porian |
| LR schedule | 做 scaling 实验时用 **constant + cooldown** 而非 cosine（可复用 run） | §3.4 |

### 7.4 数据怎么处理？

1.  **质量过滤优先**：基于模型的过滤（fastText 分类器）是最大杠杆，DCLM 用它换来 6.6× 算力等价（§4.2）。
2.  **配比自动搜索**：用 Mixing Laws（解析）或 RegMix（回归代理模型）。人工设定的比例一致地劣于自动搜索。
3.  **掺代码**：即使只评测自然语言，掺代码也有约 2× 有效 token 增益；占比 ≤50%。
4.  **重复**：≤4 epochs 基本免费；调大 weight decay 后可到 10 epochs；40 epochs 归零。硬天花板 16.4× 唯一数据量。
5.  **数据受限时**：多余算力优先投给更多 epoch 而非更多参数（与 Chinchilla 相反）。
6.  **合成数据**：**累积而非替换**真实数据 + 用验证器筛选，就不会崩溃（§4.3）。

### 7.5 我该做 RL post-training 还是 test-time scaling？

| 问题 | 答案 |
| --- | --- |
| 有可执行 verifier（代码 / 形式化数学）吗？ | **有 → test-time scaling 天花板高，值得投入。没有 → 天花板由 RM 质量决定，几百样本后饱和。**（§6.4） |
| 多数投票该采多少样本？ | **64 基本到顶**。o1 在 GPQA 上 1→64 只涨 0.7pt。 |
| base model 在这个任务上的成功率是多少？ | $p>0.6$：RL 安全锐化；$0.1\le p\le0.6$：RL 收益最大；**$p<0.1$：高危，可能 pass@k 反转**，需 PBA 类保护；$p\approx0$：RL 无从下手，考虑蒸馏。（§6.8） |
| RL 算力怎么分？ | 低预算加题目数 $B\_p$；高预算加每题 rollout $n$。**易题可容忍 $n$ 到 512，难题最优 $n$ 只有 64–128。**（§6.6） |
| 怎么判断一个 RL trick 有没有用？ | 拟合 sigmoid，问"**改的是天花板 $A$ 还是效率 $B$**"。小规模的领先经常只是提前爬坡。（§6.6） |
| thinking token budget 设多少？ | **按难度自适应**。易题 ~1,500，难题 ~8,000，全局峰值 ~12,000 后转负（R1-32B/AIME 数据）。成本感知下 6,000 处停止只损失约 6%。（§6.7） |
| RL 数据能重复吗？ | **能，25× 仍无显著退化**——与预训练的 4-epoch 阈值很不同。（§6.6） |
| RL 训练饱和了怎么办？ | 三条路：加大 rollout（BroRL 16→512）、增加**环境多样性**（RLVE，256 环境 ≫ 1 环境）、换任务域。 |
| agent 场景怎么做 TTS？ | **不要均匀 scaling**。用 BoN + list-wise 选择 + 只在高分歧步骤加算力（CATTS 的 contention regime）。（§6.9） |

### 7.6 我要自己拟一条 scaling law

最短的正确路径：

1.  统一口径：**total params + 精确 FLOPs/token**（长上下文下别用 $6N$）。
2.  先拟合超参律（LR / batch / WD 随 $N,D$）。
3.  用 **constant LR + cooldown** 做 IsoFLOP，6–9 个预算 × 6–10 个规模，网格 ±2–4×。
4.  三种方法（包络 / IsoFLOP / 参数化）都做，**用一致性作为主要检验**；检查 $a+b\approx 1$。
5.  参数化拟合：log 空间残差 + Huber($\delta=10^{-3}$) + **求和不平均** + 4500 组初值 + L-BFGS。
6.  bootstrap 出 CI，并做**外推验证**（留出最大预算不参与拟合）。
7.  报告：怎么数参数、怎么算 FLOPs、用了哪些 checkpoint、拟合流程、CI 来源。

## 8 · 论文精读路线

### 第一级：地基（必读，约 5 篇）

1.  **Kaplan et al. 2020** · [2001.08361](https://arxiv.org/abs/2001.08361) — 建立整个范式。读 §1（结果汇总）、§3（$L(N)$/$L(D)$）、§6（最优分配）。
2.  **Hoffmann et al. 2022 (Chinchilla)** · [2203.15556](https://arxiv.org/abs/2203.15556) — 三种方法、闭式解、Appendix D.2 拟合细节。**自己推一遍 $a=\beta/(\alpha+\beta)$。**
3.  **Besiroglu et al. 2024** · [2404.10102](https://arxiv.org/abs/2404.10102) — 学会怀疑拟合结果。短，一小时能读完。
4.  **Porian et al. 2024** · [2406.19146](https://arxiv.org/abs/2406.19146) — 理解实验设计如何决定指数。
5.  **Muennighoff et al. 2023** · [2305.16264](https://arxiv.org/abs/2305.16264) — 数据受限的标准参考。

### 第二级：按你的方向选（各 2–4 篇）

| 方向 | 论文 |
| --- | --- |
| **训练资源决策** | Sardana [2401.00448](https://arxiv.org/abs/2401.00448) · Gadre [2403.08540](https://arxiv.org/abs/2403.08540) · DeepSeek LLM [2401.02954](https://arxiv.org/abs/2401.02954) · Roberts (T²) [2604.01411](https://arxiv.org/abs/2604.01411) |
| **MoE 架构** | Krajewski [2402.07871](https://arxiv.org/abs/2402.07871) · Ludziejewski [2502.05172](https://arxiv.org/abs/2502.05172) · Abnar [2501.12370](https://arxiv.org/abs/2501.12370) · Zhao [2509.23678](https://arxiv.org/abs/2509.23678) |
| **超参与训练稳定性** | muP [2203.03466](https://arxiv.org/abs/2203.03466) · Step Law [2503.04715](https://arxiv.org/abs/2503.04715) · McCandlish [1812.06162](https://arxiv.org/abs/1812.06162) · Power Lines [2505.13738](https://arxiv.org/abs/2505.13738) |
| **数据工程** | DCLM [2406.11794](https://arxiv.org/abs/2406.11794) · Data Mixing Laws [2403.16952](https://arxiv.org/abs/2403.16952) · RegMix [2407.01492](https://arxiv.org/abs/2407.01492) · Fang [2503.07879](https://arxiv.org/abs/2503.07879) |
| **推理 / RL** | Snell [2408.03314](https://arxiv.org/abs/2408.03314) · Brown [2407.21787](https://arxiv.org/abs/2407.21787) · DeepSeek-R1 [2501.12948](https://arxiv.org/abs/2501.12948) · ScaleRL [2510.13786](https://arxiv.org/abs/2510.13786) · Yue [2504.13837](https://arxiv.org/abs/2504.13837) |
| **多模态** | Aghajanyan [2301.03728](https://arxiv.org/abs/2301.03728) · Cherti [2212.07143](https://arxiv.org/abs/2212.07143) · Shukor [2504.07951](https://arxiv.org/abs/2504.07951) · MM1 [2403.09611](https://arxiv.org/abs/2403.09611) |
| **部署效率** | Kumar (precision) [2411.04330](https://arxiv.org/abs/2411.04330) · Frantar (sparsity) [2309.08520](https://arxiv.org/abs/2309.08520) · Busbridge (distill) [2502.08606](https://arxiv.org/abs/2502.08606) |

### 第三级：方法论与批判（做研究必读）

-   **(Mis)Fitting: A Survey of Scaling Laws** · [2502.18969](https://arxiv.org/abs/2502.18969) — 51 篇论文的方法学调研，会改变你写论文的方式。
-   **Alabdulmohsin et al.** · [2209.06640](https://arxiv.org/abs/2209.06640) — extrapolation loss 原则。
-   **Schaeffer et al.** · [2304.15004](https://arxiv.org/abs/2304.15004) + **Du et al.** · [2403.15796](https://arxiv.org/abs/2403.15796) — 涌现之争的正反两面。
-   **Ruan et al. (Observational)** · [2405.10938](https://arxiv.org/abs/2405.10938) — 不训模型也能做 scaling law。
-   **Gemstones** · [2502.06857](https://arxiv.org/abs/2502.06857) — 4000+ 开源 checkpoints，可以自己做实验设计的消融。

## 9 · 常量速查表

### 训练

| 量 | 值 | 出处 |
| --- | --- | --- |
| $C \approx 6ND$（训练），$2N$/token（推理） | — | §1.1 |
| Kaplan $\alpha\_N,\alpha\_D,\alpha\_C^{\min}$ | 0.076, 0.095, 0.050 | §2.2 |
| Kaplan $B\_{\text{crit}}$：$B\_\*, \alpha\_B$ | $2\times10^8$ tokens, 0.21 | §2.2 |
| Chinchilla $E,A,B,\alpha,\beta$ | 1.69, 406.4, 410.7, 0.34, 0.28 | §2.3 |
| Chinchilla 修正后（Besiroglu） | **1.82**, 482, 2085, 0.348, **0.366** | §2.5 |
| 最优指数 $a=\beta/(\alpha+\beta)$ | Chinchilla 0.46 / 修正后 **0.513** / Kaplan 0.73 | §2.3, 2.5 |
| tokens/param 经验值 | **20**（训练最优），CI 约 4–40 | §2.3 |
| 涌现的 loss 阈值（MMLU/GSM8K） | pre-training loss ≈ **2.2** | §2.6 |

### 数据

| 量 | 值 |
| --- | --- |
| 重复衰减常数 $R\_D^\*, R\_N^\*$ | 15.39, 5.31 |
| epoch 效率 | 4 epochs → 93%；16 epochs → 66%；40 epochs → 归零 |
| 有效数据硬天花板 | $16.4\times U\_D$（有效参数 $6.3\times U\_N$） |
| 掺代码的有效 token 增益 | ~2×（占比 ≤50%） |
| 公共人类文本存量（2024 估计） | ~300T tokens（CI 100T–1000T） |

### 架构 / 稀疏 / 精度

| 量 | 值 |
| --- | --- |
| MoE 粒度 $G\_{\text{opt}}$ | ≈7–8（DeepSeek-V3/Qwen3/Kimi-K2 用 8–9） |
| MoE 专家数饱和 $E\_{\max}$ | ~300–500 |
| MoE 激活比推荐区间 | 5%–9%（DeepSeek-V3 ≈ 5.5%） |
| 共享专家占比 | 13%–31% |
| 75% 非结构化稀疏的等效稠密倍数 | ≈2.16×（视觉与语言域一致） |
| 精度惩罚 $\gamma\_w,\gamma\_a,\gamma\_{kv}$ | 2.675, 2.210, 0.958 |
| INT8 / INT4 训练的等效参数损失 | 5.0% / 22.4% |
| compute-optimal 训练精度 | **7–8 bits** |
| PTQ 退化对数据量的依赖 | $\delta\_{\text{PTQ}}\propto D^{0.507}$（越训越难量化） |
| 迁移律 $D\_T=kD\_F^\alpha N^\beta$ | $\beta=0.38$（与预训练分布无关）；骨化阈值 $D\_F/D(N)>0.10$ |

### 超参

| 量 | 公式 |
| --- | --- |
| 学习率 | $\eta\_{\text{opt}}=1.79\,N^{-0.713}D^{0.307}$ |
| batch size | $B\_{\text{opt}}=0.58\,D^{0.571}$（另有 $D^{0.37\text{–}0.39}$ 的估计，尚未收敛） |
| AdamW 时间尺度 | $\tau=\frac{B}{\eta\lambda D}$，$\tau\_{\text{opt}}=1.084\,\text{TPP}^{-0.527}$ |
| muP（Adam） | 隐层 $\eta\propto 1/d$；输出层 $\eta\propto 1/\text{fan\\_in}$、init var $1/\text{fan\\_in}^2$ |

### 推理 / RL

| 量 | 值 |
| --- | --- |
| RL compute 曲线形状 | **sigmoid**：$R\_C-R\_0=(A-R\_0)/[1+(C\_{\text{mid}}/C)^{B}]$ |
| ScaleRL 达到的 $A$ | 0.61（8B dense） |
| 多数投票饱和点 | $N\approx 64$（o1 GPQA 1→64 仅 +0.7pt） |
| o3 ARC-AGI | 172× 算力换 ~12pt（75.7% → 87.5%） |
| thinking token 峰值（R1-32B / AIME） | ~12,000（易题 ~1,500，难题 ~8,000） |
| RL 数据可重复次数 | 25× 无显著退化 |
| RL 模型规模效率饱和 | \>32B 后边际收益明显递减 |
| pass@k 反转的高危区 | base 成功率 $p<0.10$（boundary prompts） |
| RL 改动的 token 占比 | 1–3%（集中在高熵决策点，被提升 token 在 base 分布中平均排名 ~2） |

## 10 · 开放问题

1.  **统一的多维 scaling law 不存在。** 目前没有 $L(N, D, P, S, k, C\_{RL})$ 这样把参数、数据、精度、稀疏度、测试期采样、RL 算力一起建模的形式。§4.6 与 §4.7 甚至给出方向相反的建议（过训练害了量化、帮了稀疏）。**训练-部署联合优化的正确目标函数仍是开放的。**
2.  **$B\_{\text{opt}}$ 对 $D$ 的指数尚未收敛**：Step Law 给 0.571，Power Lines 给 0.367–0.391，Schaipp 2026 给 0.566。另外视频扩散模型的 $B\_{\text{opt}}$ 却**同时依赖 $N$**（$N^{0.19}$）——语言与视觉的差异原因不明。
3.  **下游能力不服从 loss scaling。** 线性注意力/SSM 在 loss 曲线上与 Transformer 几乎相同，但长程检索能力有结构性缺陷；Abnar 发现预训练 loss 与 few-shot 的最优稀疏度不一致。**我们缺一个"能力维度"的 scaling law**——Observational Scaling Laws 是目前最好的部分答案。
4.  **Scaling law 的指数不是物理常数。** DeepSeek 明确报告 $a,b$ 随数据质量变化；CLIP 的实验显示数据分布能改指数。那么"scaling law"到底刻画的是模型、数据、还是两者的交互？
5.  **RL 是否真的扩展能力边界，取决于怎么测。** pass@k 在大 $k$ 下退化为蒸馏"蒙对概率"（Beyond Pass@k）；agent 场景的结论与静态推理相反。**需要更好的能力边界度量。**
6.  **数据枯竭的时间表正在被验证。** Epoch AI 2024 版预测"5× 过训练 → 2027 用尽"，而工业界已经跑到 1875× 甚至 60,000×。合成数据的实际质量上限、以及"累积 + 筛选"能撑多久，是接下来两年最重要的经验问题。
7.  **低精度的悲观结论与工业实践冲突。** Kumar 的 $\delta\_{\text{PTQ}}\propto D^{0.51}$ 与 DeepSeek-V3 用 FP8 在 14.8T tokens 上成功训练之间的张力尚未解决；QAT / 旋转类方法（QuaRot/SpinQuant）之后的常数很可能已经过时。

**使用建议**：这份笔记的数值全部标注了出处，但学术界在这个领域的复现率不高（(Mis)Fitting 发现超过一半的论文没写拟合流程）。**把任何一条数值用于真实决策前，回到原文核对一遍，尤其是要确认它的实验规模、参数计数口径与数据分布是否与你的场景可比。**

三处与流行转述不符、已在正文更正的地方：Kaplan/Chinchilla 差异的主因不是 LR schedule（§2.4）；Tay et al. 的结论是架构**会**改指数（§5.3）；Chinchilla Approach 3 的拟合有 bug，修正后反而更支持 20:1（§2.5）。