---
title: "Step 18: RL 训练与批处理"
layout: documentation
project_id: hermes-agent-source
permalink: /docs/hermes-agent/18-rl-and-batch/
---

# RL 训练与批处理深度分析

## 1. 概述

Hermes 的 RL（强化学习）训练和批处理系统构建在 Atropos 框架之上，为 Agent 模型的工具调用能力提供强化学习训练环境，同时批处理系统支持大规模轨迹生成和工具使用统计。RL 环境使用双阶段架构（Phase 1: OpenAI 兼容服务器，Phase 2: VLLM 本地推理），批处理系统使用多进程并行 + 检查点恢复模式。

**关键文件清单：**

| 文件 | 行数 | 职责 |
|------|------|------|
| `environments/agent_loop.py` | ~800 | Agent 循环：异步推理 + 工具调用分发 |
| `environments/hermes_base_env.py` | ~600 | 基础环境：Atropos BaseEnv 子类 |
| `environments/hermes_swe_env/hermes_swe_env.py` | ~500 | SWE-bench 环境：Modal 沙箱 |
| `environments/web_research_env.py` | ~400 | Web 研究环境：FRAMES 基准 |
| `environments/patches.py` | ~200 | 工具调用响应解析补丁 |
| `environments/tool_context.py` | ~500 | 工具上下文：Per-rollout 工具访问 |
| `environments/tool_call_parsers/__init__.py` | ~50 | 解析器注册表 |
| `environments/tool_call_parsers/*.py` | 各 80-200 | 11 个 Provider 解析器 |
| `environments/benchmarks/` | — | 基准测试框架 |
| `rl_cli.py` | ~400 | RL 训练 CLI 入口 |
| `batch_runner.py` | ~1290 | 批处理运行器 |

---

## 2. RL 训练环境

### 2.1 双阶段架构

HermesAgentBaseEnv 支持两种运行模式：

**Phase 1：OpenAI 兼容服务器**
- 使用远程 API（OpenAI、Anthropic 等）进行推理
- 原生 `tool_calls` 格式，无需解析
- 适用于数据收集和初步调试

```python
class HermesAgentBaseEnv(BaseEnv):
    def __init__(self, config):
        super().__init__(config)
        if config.get("server", {}).get("type") == "openai":
            self.phase = 1
            self.server = OpenAIServer(config)
        else:
            self.phase = 2
            self.server = VLLMManagedServer(config)
```

**Phase 2：VLLM 本地推理**
- 本地模型推理，客户端解析工具调用
- 支持 Reasoning/Thinking token
- 适用于实际 RL 训练

### 2.2 Agent 循环（HermesAgentLoop）

核心循环是异步的，处理推理、工具调用和 Reasoning 提取：

```python
class HermesAgentLoop:
    async def run(self, prompt, task_id):
        messages = [{"role": "user", "content": prompt}]
        
        for iteration in range(self.max_iterations):
            # 1. 获取模型响应
            response = await self.server.chat_completion(
                messages=messages,
                tools=self.tool_schemas
            )
            
            # 2. 提取 Reasoning（如果存在）
            reasoning = self._extract_reasoning(response)
            
            # 3. 解析工具调用
            content, tool_calls = self._parse_tool_calls(response)
            
            # 4. 如果有工具调用，执行并收集结果
            if tool_calls:
                results = await self._execute_tool_calls(tool_calls, task_id)
                messages.append(assistant_msg)
                messages.extend(results)
            else:
                # 无工具调用 = 最终响应
                return content, reasoning

        return content, reasoning  # 超过最大迭代次数
```

工具调用在 `ThreadPoolExecutor` 中执行（默认 128 workers），因为 `handle_function_call()` 是同步的：

```python
async def _execute_tool_calls(self, tool_calls, task_id):
    loop = asyncio.get_event_loop()
    tasks = []
    for call in tool_calls:
        future = loop.run_in_executor(
            self._tool_executor,
            handle_function_call,
            call.name, call.args, task_id
        )
        tasks.append(future)
    results = await asyncio.gather(*tasks)
    return results
```

### 2.3 工具调用解析器

11 个 Provider 特定的工具调用解析器，每个处理不同模型输出格式：

| 解析器 | 模型 | 格式特征 |
|--------|------|----------|
| `hermes` | Hermes 系列 | 标准 JSON tool_calls |
| `deepseek_v3` | DeepSeek V3 | `<tool_call>` XML 标签 |
| `deepseek_v3_1` | DeepSeek V3.1 | 改进的 XML 标签格式 |
| `glm45` | GLM-4.5 | ````json` 代码块中的工具调用 |
| `glm47` | GLM-4.7 | 改进的 JSON 格式 |
| `kimi_k2` | Kimi K2 | 特殊标记的工具调用 |
| `llama` | Llama 3 | `[TOOL_CALL]` 标记格式 |
| `longcat` | LongCat | 自定义函数调用格式 |
| `mistral` | Mistral | 原生 tool_calls 格式 |
| `qwen` | Qwen 2.5 | `✿FUNCTION✿` 标记格式 |
| `qwen3_coder` | Qwen3 Coder | 改进的函数调用格式 |

解析器注册表：
```python
PARSER_REGISTRY: Dict[str, Type[ToolCallParser]] = {}

def register_parser(name: str):
    def decorator(cls):
        PARSER_REGISTRY[name] = cls
        return cls
    return decorator

def get_parser(name: str) -> ToolCallParser:
    if name not in PARSER_REGISTRY:
        raise ValueError(f"Unknown parser: {name}. Available: {list(PARSER_REGISTRY.keys())}")
    return PARSER_REGISTRY[name]()
```

每个解析器实现 `ToolCallParser` ABC：

```python
class ToolCallParser(ABC):
    @abstractmethod
    def parse(self, text: str) -> Tuple[str, List[Dict]]:
        """Parse model output into (content, tool_calls).
        
        Returns:
            content: str — extracted text content
            tool_calls: List[Dict] — list of {name, arguments} dicts
        """
```

### 2.4 ToolContext

`ToolContext` 为每个 rollout 提供受限的工具访问接口，供奖励函数调用：

```python
class ToolContext:
    def __init__(self, task_id, tools_pool):
        self.task_id = task_id
        self._pool = ThreadPoolExecutor(max_workers=4)
    
    # 文件操作
    def read_file(self, path): ...
    def write_file(self, path, content): ...
    
    # 搜索操作
    def search_files(self, pattern, directory): ...
    
    # Web 操作
    def web_search(self, query): ...
    def web_extract(self, url): ...
    def browser(self, url, action): ...
    
    # 终端操作
    def terminal(self, command, cwd=None): ...
    
    # 通用工具调用
    def call_tool(self, tool_name, args): ...
    
    # 文件传输
    def upload_file(self, path): ...
    def download_file(self, url, path): ...
    def download_dir(self, remote_path): ...
```

同步工具通过线程池从异步上下文调用：

```python
async def web_search(self, query):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        self._pool,
        handle_function_call,
        "web_search", {"query": query}, self.task_id
    )
```

### 2.5 环境子类

**HermesSweEnv**（SWE-bench）：
- 使用 Modal 沙箱创建隔离的代码执行环境
- 每个 rollout 创建新的沙箱实例
- 支持 git 操作、测试运行、代码编辑
- 奖励函数：测试通过率 + 代码质量

**WebResearchEnv**（FRAMES 基准）：
- 多信号奖励函数：答案正确性 + 信息质量 + 推理链完整性
- 使用 LLM 作为 Judge 评估答案质量
- 搜索和提取操作有步数限制

### 2.6 Reasoning 提取

`patches.py` 处理不同 Provider 的 Reasoning 格式：

```python
def extract_reasoning(response):
    # 1. 原生 thinking tokens（OpenAI o1, Anthropic extended thinking）
    if hasattr(response, 'reasoning') and response.reasoning:
        return response.reasoning
    
    # 2. <REASONING_SCRATCHPAD> XML 标签
    match = re.search(r'<REASONING_SCRATCHPAD>(.*?)</REASONING_SCRATCHPAD>',
                      response.content, re.DOTALL)
    if match:
        return match.group(1)
    
    # 3. <think> 标签（某些模型）
    match = re.search(r'<think>(.*?)</think>', response.content, re.DOTALL)
    if match:
        return match.group(1)
    
    return None
```

---

## 3. 批处理系统

### 3.1 BatchRunner 架构

`BatchRunner` 支持大规模并行 Agent 轨迹生成：

```python
class BatchRunner:
    def __init__(self, dataset_file, batch_size, run_name, distribution, ...):
        self.dataset = self._load_dataset()
        self.batches = self._create_batches()
        self.output_dir = Path("data") / run_name
        self.checkpoint_file = self.output_dir / "checkpoint.json"
```

核心流程：

1. **加载** JSONL 数据集（每行包含 `prompt` 字段）
2. **分批**：按 `batch_size` 分割为多个批次
3. **并行**：使用 `multiprocessing.Pool` 并行处理批次
4. **检查点**：每完成一个批次，更新 `checkpoint.json`
5. **合并**：所有批次完成后，合并为 `trajectories.jsonl`

### 3.2 Worker 处理

每个 Worker 进程处理一个批次：

```python
def _process_batch_worker(args):
    batch_num, batch_data, output_dir, completed_set, config = args
    
    for prompt_index, prompt_data in prompts_to_process:
        result = _process_single_prompt(prompt_index, prompt_data, batch_num, config)
        
        # 提取工具统计和推理统计
        tool_stats = _extract_tool_stats(result["messages"])
        reasoning_stats = _extract_reasoning_stats(result["messages"])
        
        # 丢弃零推理样本
        if not reasoning_stats.get("has_any_reasoning"):
            discarded += 1
            continue
        
        # 归一化工具统计
        normalized_stats = _normalize_tool_stats(tool_stats)
        
        # 追加到批次文件
        with open(batch_file, 'a') as f:
            f.write(json.dumps(trajectory_entry) + "\n")
```

关键设计决策：

- **Per-prompt 容器镜像**：数据集行可以包含 `image` / `docker_image` 字段，为每个 prompt 覆盖沙箱镜像
- **零推理丢弃**：自动丢弃没有任何推理步骤的样本，避免低质量数据进入训练集
- **工具统计归一化**：所有工具都有统计条目（未使用的工具为零值），保证 HuggingFace 数据集加载时 schema 一致

### 3.3 检查点与恢复

恢复机制有两层保障：

1. **索引检查点**：`checkpoint.json` 记录已完成的 prompt 索引列表
2. **内容扫描**：`_scan_completed_prompts_by_content()` 扫描已有批次文件，按 prompt 文本匹配确定已完成项

```python
def _scan_completed_prompts_by_content(self):
    """扫描所有批次文件，提取已完成 prompt 的文本"""
    completed = set()
    for batch_file in sorted(self.output_dir.glob("batch_*.jsonl")):
        for line in batch_file:
            entry = json.loads(line)
            for msg in entry.get("conversations", []):
                if msg.get("from") == "human":
                    completed.add(msg.get("value", "").strip())
                    break
    return completed
```

内容匹配比索引更健壮——即使数据集重新排序或增减项，也能正确跳过已处理项。

### 3.4 工具统计提取

`_extract_tool_stats()` 从消息历史中提取每个工具的调用次数和成功/失败率：

```python
# 成功判定逻辑：
# 1. JSON 响应中 error 字段为 None → 成功
# 2. terminal 工具的嵌套 content.error 为 None → 成功
# 3. JSON 响应中 success 字段为 True → 成功
# 4. 空响应或以 "Error:" 开头 → 失败
```

### 3.5 推理统计提取

`_extract_reasoning_stats()` 统计推理覆盖率：

```python
# 检查方式：
# 1. <REASONING_SCRATCHPAD> 标签是否存在
# 2. native reasoning 字段是否非空
# 输出：
# - total_assistant_turns
# - turns_with_reasoning
# - turns_without_reasoning
# - has_any_reasoning（用于零推理样本过滤）
```

### 3.6 轨迹格式

输出轨迹使用 Hermes 标准对话格式：

```json
{
  "prompt_index": 42,
  "conversations": [
    {"from": "human", "value": "..."},
    {"from": "gpt", "value": "..."},
    {"from": "human", "value": "..."},
    ...
  ],
  "metadata": {"batch_num": 3, "timestamp": "...", "model": "..."},
  "completed": true,
  "partial": false,
  "api_calls": 5,
  "toolsets_used": ["terminal", "file_tools", "web_tools"],
  "tool_stats": {"terminal": {"count": 3, "success": 3, "failure": 0}, ...},
  "tool_error_counts": {"terminal": 0, ...}
}
```

### 3.7 损坏过滤

合并轨迹时，自动过滤模型幻觉产生的无效工具名：

```python
# ALL_POSSIBLE_TOOLS 自动从 TOOL_TO_TOOLSET_MAP 派生
# 无需手动维护
VALID_TOOLS = ALL_POSSIBLE_TOOLS

invalid_tools = [k for k in tool_stats if k not in VALID_TOOLS]
if invalid_tools:
    filtered_entries += 1
    continue  # 跳过损坏条目
```

---

## 4. 代码质量评估

### 4.1 优点

1. **解析器注册表设计**：`ToolCallParser` ABC + `PARSER_REGISTRY` 是经典的开放-封闭原则。添加新 Provider 只需创建新文件和装饰器，无需修改核心代码。

2. **内容匹配恢复**：`_scan_completed_prompts_by_content()` 比索引匹配更健壮，能处理数据集重新排序、增删等场景。

3. **零推理过滤**：自动丢弃没有推理步骤的样本，提高训练数据质量。这对 RL 训练特别重要，低质量样本会降低模型学习效率。

4. **工具统计归一化**：确保所有样本有相同的工具统计 schema，避免 HuggingFace datasets 加载时的 schema 不一致错误。

5. **线程池隔离**：工具调用在独立线程池中执行（128 workers），不阻塞主事件循环。

6. **Per-prompt 容器镜像**：数据集行可以指定不同的 Docker/Modal/Singularity/Daytona 镜像，实现异构沙箱环境。

### 4.2 不足与风险

1. **`batch_runner.py` 单文件过大**：1290 行包含数据集加载、批处理、检查点、统计、格式化、CLI 入口等全部逻辑。应拆分为 `loader.py`、`worker.py`、`checkpoint.py`、`stats.py`、`cli.py`。

2. **Worker 顺序处理**：`_process_batch_worker` 在批次内顺序处理每个 prompt，没有并行性。虽然批次间并行（`Pool.imap_unordered`），但批次内的每个 prompt 仍需要等待前一个完成。对于 API 调用密集型任务，这可能导致大量等待时间。

3. **ToolContext 线程池硬编码**：`ToolContext` 的线程池大小硬编码为 4，与 Agent 循环的 128 workers 不匹配。在并发工具调用场景下可能成为瓶颈。

4. **检查点写入非原子**：`BatchRunner._save_checkpoint()` 直接写入 JSON 文件，虽然使用了 `atomic_json_write`（内部通过 `utils.atomic_json_write()`），但 `_scan_completed_prompts_by_content()` 的匹配依赖 prompt 文本哈希，对超长 prompt 可能有匹配问题。

5. **Reasoning 提取不完整**：只检查两种格式（`<REASONING_SCRATCHPAD>` 和 `native reasoning`）。某些模型（如 Gemini 的 thought summaries）使用不同格式，会遗漏。

6. **MPS 缺乏类型定义**：`tool_context.py` 的返回值都是原始 dict/str，没有类型注解。奖励函数代码需要理解内部结构，容易出错。

7. **环境变量依赖**：Agent 循环和 ToolContext 通过 `os.getenv()` 获取配置（如 `TERMINAL_ENV`、`MAX_ITERATIONS`），缺少显式参数传递。测试困难，且容易因环境变量未设置而使用错误的默认值。

8.**`_process_single_prompt` 全局配置字典**：Worker 进程通过 `_WORKER_CONFIG` 全局字典接收配置，这是 `multiprocessing.Pool` 的常见模式，但不利于测试和类型安全。

---

## 5. 改进建议

### 5.1 高优先级

1. **拆分 `batch_runner.py`**：按职责拆分为：
   - `batch_runner/loader.py` — 数据集加载和分批
   - `batch_runner/worker.py` — 单个 prompt 处理逻辑
   - `batch_runner/checkpoint.py` — 检查点管理和恢复
   - `batch_runner/stats.py` — 工具统计、推理统计、归一化
   - `batch_runner/cli.py` — CLI 入口（fire.F）
   - `batch_runner/runner.py` — BatchRunner 类和并行编排

2. **批次内并行**：在 `_process_batch_worker` 中使用 `ThreadPoolExecutor` 并行处理批次内的 prompt，与批次间并行组合使用。或者采用更细粒度的 `Pool.imap_unordered`（每项一个 prompt 而非每项一个批次）。

3. **ToolContext 类型注解**：为所有返回值添加 dataclass 类型注解，例如：
   ```python
   @dataclass
   class SearchResult:
       title: str
       url: str
       snippet: str
   
   @dataclass
   class FileContent:
       path: str
       content: str
       encoding: str
   ```

### 5.2 中优先级

4. **配置对象替代全局字典**：将 `_WORKER_CONFIG` 字典替换为 dataclass：
   ```python
   @dataclass
   class WorkerConfig:
       distribution: str
       model: str
       max_iterations: int
       base_url: Optional[str] = None
       ...
   ```
   通过 `Pool(initializer=set_config, initargs=(config,))` 传递。

5. **扩展 Reasoning 格式检测**：添加更多格式支持：
   - Gemini thought summaries（`thought` 字段）
   - Qwen thinking blocks（`<think>` 标签）
   - 通用 JSON 格式（`{"thinking": "..."}`）
   
   统一到一个 `extract_thinking()` 函数，由 Provider 特定解析器调用。

6. **ToolContext 线程池配置化**：将 `max_workers` 从硬编码 4 改为 `config.get("rl.tool_context_workers", 4)` 或 `min(tool_count, 16)`。

### 5.3 低优先级

7. **检查点压缩**：大运行（10000+ prompts）的 `checkpoint.json` 可能变得很大（已完成索引列表）。考虑使用位图或布隆过滤器代替列表存储。

8. **流式进度通知**：Worker 处理进度目前通过 `print()` 输出到 stdout。考虑使用 `multiprocessing.Queue` 将进度事件发送到主进程，由 BatchRunner 统一格式化和显示。

9. **动态 Worker 数量**：根据 API 的速率限制动态调整 `num_workers`。如果遇到 429 限流，自动减少并发；如果吞吐量低于阈值，增加并发。