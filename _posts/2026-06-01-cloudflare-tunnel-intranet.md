---
title: "用 Cloudflare Tunnel 0成本搞定内网穿透"
date: 2026-06-01 18:05:22 +0800
categories: [教程, 工具]
tags: [Cloudflare, Tunnel, 内网穿透, SSL, 免费]
description: "手把手教你用 Cloudflare Tunnel 实现免费内网穿透，支持自定义域名和自动 SSL 证书。"
pin: false
---


## 概述

假如说你有内网穿透的需求，同时有一个域名，又恰巧还注册了 Cloudflare，那就可以薅羊毛了，直接使用 Cloudflare Tunnel 的隧道能力直接实现内网穿透，并直接配置 SSL。（开通Cloudflare需要输入信用卡信息，但是不扣费）

## 一、注册域名（如已有可跳过）

如果没有域名，可以去 [https://www.spaceship.com/](https://www.spaceship.com/) 注册一个便宜的域名。推荐理由：

- 💰 价格便宜（约 8 块人民币）
- 💳 支持支付宝付款
- 📝 操作简单

## 二、添加域名到 Cloudflare

### 2.1 进入添加站点页面

登录 Cloudflare 控制台，点击「添加站点」按钮，进入添加站点页面。

![添加站点页面](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779699693476_sjl7fpz.png)

页面提供三个选项：


| 选项           | 说明                   |
| ------------ | -------------------- |
| **连接域名（推荐）** | 将已有的域名连接到 Cloudflare |
| 转移域名         | 将域名转移到 Cloudflare 管理 |
| 购买域名         | 直接在 Cloudflare 购买新域名 |


### 2.2 选择服务计划

选择 **Free（免费）** 计划即可满足内网穿透需求。

![选择服务计划](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779699787031_kmv6x8i.png)

Cloudflare 服务计划对比：


| 计划         | 价格     | 核心功能                                                 |
| ---------- | ------ | ---------------------------------------------------- |
| **Free**   | $0/月   | Workers 100K请求/天、D1 5GB、R2 10GB、Universal SSL、全球 CDN |
| Pro        | $20/月  | WAF 防护（OWASP）、图像优化、CDN 缓存分析                          |
| Business   | $200/月 | PCI/SOC2 合规、自定义 SSL、复杂机器人检测                          |
| Enterprise | 定制     | 高级 WAF、DDoS 保护、API Gateway、SSO                       |


### 2.3 更新名称服务器

按照页面提示，前往你的域名注册商处，将名称服务器替换为 Cloudflare 提供的地址。

![更新名称服务器](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779699919744_gi6wyta.png)

需要设置的两个 Cloudflare 名称服务器：

```
darwin.ns.cloudflare.com
mimi.ns.cloudflare.com
```

> ⚠️ **提示**：此操作不太可能导致停机。如果不确定如何操作，可以先点击「DNS 记录」检查现有记录。

## 三、进入 Zero Trust

返回 Cloudflare 控制台，进入 **Zero Trust** 控制台。

![Zero Trust 入口](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779700096162_x1rbij1.png)

进入路径：

```
左侧菜单 → 保护和连接 (Protect and Connect) → Zero Trust
```

然后点击右上角的 **「开始使用」** 按钮。

## 四、创建 Cloudflare Tunnel

### 4.1 进入连接器页面

在 Zero Trust 控制台中，依次进入：

```
网络 (Network) → 连接器 (Connectors) → Cloudflare Tunnels
```

![连接器管理页面](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779700235632_613al4x.png)

> 💡 **说明**：Cloudflare Tunnel 让用户无需公开可路由的 IP 地址即可连接资源。

### 4.2 创建新隧道

点击 **「+ 创建隧道」** 按钮，进入创建流程。

![创建隧道](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779700299344_k8myey6.png)

### 4.3 选择隧道类型

创建隧道分为四个步骤：

```
1. 选择隧道类型（当前）
2. 为隧道命名
3. 安装并运行连接器
4. 路由隧道
```

选择 **Cloudflared（推荐方案）**：


| 类型                  | 说明                      | 适用场景                |
| ------------------- | ----------------------- | ------------------- |
| **Cloudflared（推荐）** | 建立与 Cloudflare 的安全仅出站连接 | 用户到网络的连接，无需开放入站端口   |
| WARP (Beta)         | 支持站点到站点、双向和网状网络连接       | 仅限 Linux 发行版，高级网络架构 |


### 4.4 为隧道命名

使用描述性名称，建议每个网络只创建一个隧道。

![为隧道命名](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779700338140_gifp8iv.png)

> 💡 **命名建议**：基于要连接的网络命名，例如 `home-server`、`dev-machine` 等。

## 五、安装并运行连接器

### 5.1 选择操作系统

根据你的本地设备选择对应的操作系统（Mac/Windows/Linux）。

![安装并运行连接器](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779700465371_5owtvvo.png)

### 5.2 macOS 安装命令

> ⚠️ **安全提醒**：请妥善保管您的令牌，此命令包含敏感令牌，任何能访问此令牌的人都可以运行隧道。

**方式一：未安装 cloudflared**

```bash
brew install cloudflared && sudo cloudflared service install <你的token>
```

**方式二：已安装 cloudflared，安装为自动运行服务**

```bash
sudo cloudflared service install <你的token>
```

**方式三：仅在当前终端手动运行**

```bash
cloudflared tunnel run --token <你的token>
```

## 六、配置域名路由

这是最后一步，将域名绑定到本地服务。

![配置域名路由](https://timelog-1257904505.cos.ap-guangzhou.myqcloud.com/knowledge_images/1779700805501_vzpxeu0.png)

### 6.1 主机名设置


| 字段  | 说明         | 示例                 |
| --- | ---------- | ------------------ |
| 子域名 | 子域名前缀（可选）  | `www`、`blog`、`api` |
| 域   | 选择你注册的域名   | `honorest.online`  |
| 路径  | 正则匹配路径（可选） | `^/blog`、`^/api`   |


### 6.2 路径匹配规则


| 匹配方式       | 输入示例    | 说明                              |
| ---------- | ------- | ------------------------------- |
| 匹配所有路径     | 留空      | 匹配所有访问请求                        |
| 在路径中任何位置匹配 | `blog`  | 匹配 `/blog`、`/archive/blog/post` |
| 匹配路径前缀     | `^/api` | 匹配 `/api` 开头的路径                 |
| 按扩展名匹配     | `(jpg   | png                             |


### 6.3 服务设置（本地服务地址）


| 字段  | 说明         | 示例                                              |
| --- | ---------- | ----------------------------------------------- |
| 类型  | 协议类型（必填）   | HTTP、HTTPS、TCP                                  |
| URL | 本地服务地址（必填） | `https://localhost:8080`、`tcp://localhost:3306` |


> 💡 **格式示例**：
>
> - Web 服务：`https://localhost:8080`
> - SSH 服务：`tcp://localhost:22`
> - 数据库：`tcp://localhost:3306`

## 七、验证与使用

完成以上所有设置后，就可以通过配置的域名访问你的本地服务了！

### 验证步骤

1. **检查隧道状态**：在 Cloudflare Tunnels 页面确认隧道状态为「正常」（绿色）
2. **测试访问**：使用浏览器访问配置的域名
3. **查看日志**：如有异常，点击「查看日志」排查问题

### 隧道管理


| 操作   | 说明           |
| ---- | ------------ |
| 查看状态 | 隧道列表显示正常运行时间 |
| 编辑配置 | 点击 ... 更多操作  |
| 查看日志 | 排查连接问题       |


## 八、常见问题

### Q1: 隧道状态显示异常怎么办？

- 检查本地 cloudflared 是否正常运行
- 确认 token 是否正确
- 查看连接器日志排查问题

### Q2: 如何实现多个服务映射？

- 创建多个隧道
- 或使用路径匹配（如 `/blog`、`/api`）区分不同服务

### Q3: 如何实现 HTTPS 访问？

- 本地使用 HTTP + 端口，Cloudflare 自动配置 SSL
- 或本地配置 HTTPS 证书

## 总结

Cloudflare Tunnel 是一种简单、免费、安全的内网穿透方案，特别适合：

- 🌐 暴露本地开发环境
- 🏠 家庭 NAS 远程访问
- 🧪 临时测试环境分享
- 🚀 无公网服务器的开发者

> 💡 **优势**：完全免费、自动配置 SSL、无需开放防火墙端口、稳定可靠。
