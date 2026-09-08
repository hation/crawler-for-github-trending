# crawler-for-github-trending

基于 axios + express + cheerio 的 GitHub Trending 爬虫，在原作者 50 行版本基础上扩展为完整的**榜单采集 + Star 趋势追踪**系统。

## 功能特性

- **榜单爬取**：抓取 GitHub Trending daily / weekly / monthly 榜，按新增 star 排序（原作者逻辑）
- **README 存储**：每个项目抓取 README 纯文本（去样式代码，限 5 万字符），相同项目自动复用缓存，不重复抓取
- **一句话总结**：喂 README 全文给火山豆包 LLM，一次生成两个字段——一句话总结（summary）+ 详细"项目解决什么问题"（solves，面向谁/痛点/方案）
- **飞书推送**：每次拉取成功聚合推送到飞书群（项目名 / 地址 / 一句话总结 / 当前 star / 涨了多少 star / 项目语言）
- **Star 趋势追踪**：动态热度分级（A 每天 / B 每周六 / C 每月 28 日），连续采样项目 star 变化曲线，热门高频、冷门自动降频
- **关注用户动态**：每周扫描关注的 GitHub 用户，监控新建仓库 + 发新版本，推送飞书
- **HTTP 接口**：榜单查询（含历史日期）、项目详情、star 趋势、关注用户动态
- **系统级定时任务**：TRAE 定时自动化调度（非应用内 cron），到点启动独立 CLI 进程

## 架构

```
┌─────────────────────────────┐      ┌──────────────────────────────┐
│  榜单爬取（crawler.js）       │      │  Star 趋势追踪（tracker.js）   │
│  每天/周六/28日 抓 Trending   │      │  每天/周六/28日 采样 star      │
│  → 入库 + 飞书推送            │      │  → star_history + 动态分级     │
└─────────────────────────────┘      └──────────────────────────────┘
            │ 写入                                │ 写入
            ▼                                    ▼
   trending_snapshots                   star_history / project_track_level
   （榜单快照，含 README/总结）            （连续采样曲线 + 热度级别）
```

## 快速开始

### 环境要求
- Node.js 18+
- PostgreSQL（本机，库名 `github_trending`）
- `gh` CLI 已登录（趋势追踪采样 GitHub API 需要 token）
- 可选：飞书群自定义机器人 webhook、火山豆包 API Key

### 1. 安装与配置
```bash
git clone https://github.com/hation/crawler-for-github-trending.git
cd crawler-for-github-trending
npm install
cp .env.example .env   # 按需填写，见「环境变量」
```

### 2. 初始化数据库
```bash
psql -c "CREATE DATABASE github_trending;"
psql -d github_trending -c "
CREATE TABLE trending_snapshots (
  id BIGSERIAL PRIMARY KEY,
  dimension VARCHAR(10) NOT NULL,
  language VARCHAR(50) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL,
  links VARCHAR(255) NOT NULL,
  description TEXT,
  repo_language VARCHAR(50),
  stars VARCHAR(50),
  forks VARCHAR(50),
  info VARCHAR(100),
  avatar VARCHAR(500),
  readme TEXT,
  summary TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_snap_dim_lang_time ON trending_snapshots (dimension, language, fetched_at DESC);
"
```
> `star_history` 与 `project_track_level` 表由 `track.js` 首次运行时自动创建。

### 3. 运行 HTTP 服务
```bash
node index.js            # 默认端口 3000；如被占用：PORT=3001 node index.js
```

## 环境变量（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | HTTP 端口，默认 3000 |
| `DATABASE_URL` | 否 | PostgreSQL 连接串，默认 `postgres://当前用户@localhost:5432/github_trending` |
| `FEISHU_WEBHOOK` | 否 | 飞书群机器人 webhook，配置后拉取成功推送 |
| `ARK_API_KEY` | 否 | 火山豆包 API Key，缺省时读 `~/.codex/auth.json` 的 `OPENAI_API_KEY` |
| `CACHE_TTL_SEC` | 否 | 榜单接口缓存秒数，默认 600 |

## 接口

| 接口 | 说明 |
|---|---|
| `GET /list/:time` | 榜单数据，time=daily/weekly/monthly；`?date=YYYY-MM-DD` 查历史某天 |
| `GET /list/:time/:language` | 指定语言主题榜单，如 `/list/daily/python` |
| `GET /repo/:owner/:repo` | 单个项目历史快照（含 README + 总结） |
| `GET /trend/:owner/:repo` | star 趋势采样曲线（`star_history`），含每段涨跌 |
| `GET /followed-updates?days=N` | 关注用户仓库动态（发版/建仓，`followed_updates`），默认近 30 天 |

## CLI 命令（定时任务入口）

```bash
# 榜单爬取（抓取 → 补 README/总结 → 入库 → 飞书推送）
node crawl.js daily      # daily 榜
node crawl.js weekly     # weekly 榜
node crawl.js monthly    # monthly 榜

# Star 趋势追踪（采样对应级别项目 + 动态调整热度级别）
node track.js daily      # 采样 A 级（热门）
node track.js weekly     # 采样 B 级（温和）
node track.js monthly    # 采样 C 级（冷淡）

# 历史补录：为库中全部去重项目补录 solves（"项目解决什么问题"）
node backfill_solves.js

# 关注用户动态扫描（新建仓库 + 发版，[--days N] 默认 7 天）
node follow.js 7

# 历史补录：为关注动态的 create 事件补 stars + 一句话总结
node backfill_followed.js
```

## 定时任务

本项目使用 **TRAE 系统级定时自动化**（方案 B，非应用内 cron）调度，共 6 个任务：

| 任务 | 时间 | 命令 |
|---|---|---|
| 每日 daily 榜拉取 | 每天 09:00 | `node crawl.js daily` |
| 每周六 weekly 榜拉取 | 周六 09:30 | `node crawl.js weekly` |
| 每月 28 日 monthly 榜拉取 | 28 日 09:30 | `node crawl.js monthly` |
| star 趋势每日采样（A 级） | 每天 09:05 | `node track.js daily` |
| star 趋势每周六采样（B 级） | 周六 09:35 | `node track.js weekly` |
| star 趋势每月 28 日采样（C 级） | 28 日 09:35 | `node track.js monthly` |
| 关注用户动态每周扫描 | 每周一 09:45 | `HTTPS_PROXY= HTTP_PROXY= node follow.js 7` |

> 完整配置与迁移步骤见 [SCHEDULED_TASKS.md](SCHEDULED_TASKS.md)

## 文档

- [ALGORITHM.md](ALGORITHM.md) —— 核心算法说明（爬取流程、动态热度分级、升降级规则、可调参数）
- [SCHEDULED_TASKS.md](SCHEDULED_TASKS.md) —— 定时任务配置备份与迁移指南
- [TOKEN_USAGE.md](TOKEN_USAGE.md) —— Token 消耗说明（唯一消耗环节 + 估算 + 优化手段）

## 数据说明

- 同一项目在 `trending_snapshots` 中按抓取时间累积多条快照，支持历史查询
- `star_history` 为趋势追踪的连续采样曲线，按项目+时间索引
- 爬 GitHub Trending 与 GitHub API 需走系统代理（`HTTPS_PROXY` 环境变量），飞书与豆包国内直连
