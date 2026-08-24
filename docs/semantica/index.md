---
title: "Semantica 专题"
layout: documentation
project_id: semantica-cookbook
permalink: /docs/semantica/
description: "Semantica 官方 Cookbook 全 37 篇中文翻译：从数据摄取到知识图谱、向量检索、推理与本体治理的完整学习路径。"
---

> **Semantica** 是面向语义层与知识工程的开源框架，定位为「AI Agent 的开源 Palantir」。
> 本专题将官方 Cookbook 的 37 篇 notebook 忠实翻译为中文，并以富 HTML 页面呈现。
> 每篇页面自带目录与「上一篇 / 下一篇」导航，可顺序阅读，也可从下方目录直接跳转。

## 关于 Semantica

Semantica 是一个 Python 开源框架，用于将杂乱、多源的原始数据，转化为可驱动 GraphRAG、AI 智能体、多智能体系统与分析应用的**语义层**与**知识图谱**。它提供：

- **知识管道**：多源摄取、实体感知分块、NER/关系/事件抽取、冲突检测与语义去重
- **确定性推理**：前向链、Rete 网络、Datalog 与 SPARQL，附带可解释路径
- **溯源与可审计性**：每个事实的 W3C PROV-O 血缘，可导出 JSON/CSV/RDF
- **多存储后端**：RDF 三元组存储 + 属性图存储 + 向量存储
- **本体治理**：SHACL 校验、OWL 生成、SKOS 词汇管理

> 官方仓库：[github.com/semantica-agi/semantica](https://github.com/semantica-agi/semantica)

## 目录

### 入门系列（Introduction）

- [欢迎使用 Semantica](/docs/semantica/01-welcome.html)
- [数据摄取](/docs/semantica/02-data-ingestion.html)
- [文档解析](/docs/semantica/03-document-parsing.html)
- [数据规范化](/docs/semantica/04-data-normalization.html)
- [实体抽取](/docs/semantica/05-entity-extraction.html)
- [关系抽取](/docs/semantica/06-relation-extraction.html)
- [构建知识图谱](/docs/semantica/07-building-knowledge-graphs.html)
- [你的第一个知识图谱](/docs/semantica/08-your-first-knowledge-graph.html)
- [图存储](/docs/semantica/09-graph-store.html)
- [图分析](/docs/semantica/10-graph-analytics.html)
- [分块与切分](/docs/semantica/11-chunking-and-splitting.html)
- [嵌入生成](/docs/semantica/12-embedding-generation.html)
- [向量存储](/docs/semantica/13-vector-store.html)
- [本体](/docs/semantica/14-ontology.html)
- [导出](/docs/semantica/15-export.html)
- [可视化](/docs/semantica/16-visualization.html)
- [冲突检测与消解](/docs/semantica/17-conflict-detection-and-resolution.html)
- [去重](/docs/semantica/18-deduplication.html)
- [上下文模块](/docs/semantica/19-context-module.html)
- [三元组存储](/docs/semantica/20-triplet-store.html)
- [Amazon Neptune 存储](/docs/semantica/21-amazon-neptune-store.html)

### 进阶系列（Advanced）

- [高级抽取](/docs/semantica/01-advanced-extraction.html)
- [高级图分析](/docs/semantica/02-advanced-graph-analytics.html)
- [完整可视化套件](/docs/semantica/03-complete-visualization-suite.html)
- [多格式导出](/docs/semantica/05-multi-format-export.html)
- [多源数据集成](/docs/semantica/06-multi-source-data-integration.html)
- [推理与推断](/docs/semantica/08-reasoning-and-inference.html)
- [语义层构建](/docs/semantica/09-semantic-layer-construction.html)
- [时序知识图谱](/docs/semantica/10-temporal-knowledge-graphs.html)
- [高级上下文工程](/docs/semantica/11-advanced-context-engineering.html)
- [非结构化到本体](/docs/semantica/12-unstructured-to-ontology.html)
- [手动本体-Snowflake 映射](/docs/semantica/13-manual-ontology-snowflake-mapping.html)
- [Datalog 风格推理](/docs/semantica/14-datalog-style-reasoning.html)
- [高级向量存储与检索](/docs/semantica/15-advanced-vector-store-and-search.html)

### 集成系列（Integrations）

- [Agno 决策智能](/docs/semantica/01-agno-decision-intelligence.html)
- [Agno GraphRAG 上下文](/docs/semantica/02-agno-graphrag-context.html)
- [Agno 多智能体共享上下文](/docs/semantica/03-agno-multi-agent-shared-context.html)
