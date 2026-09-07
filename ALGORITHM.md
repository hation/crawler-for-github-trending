# GitHub Trending 爬虫 + Star 趋势追踪 —— 算法说明

> 本文档描述系统的核心算法与设计决策。代码是权威实现（crawler.js / crawl.js / tracker.js / track.js），
> 本文档帮助理解与迁移。
>
> 配套文件：
> - [SCHEDULED_TASKS.md](SCHEDULED_TASKS.md) —— 定时任务配置备份（迁移时重建）

---

## 一、系统总览

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

两个子系统共用同一个 PostgreSQL 库（github_trending）与项目目录，彼此独立运行。

---

## 二、榜单爬取算法（crawler.js）

### 2.1 流程
```
getData(time, language)
  → 抓 https://github.com/trending[/lang]?since=time
  → cheerio 解析 Box-row，提取 title/description/language/stars/forks/info/avatar
  → 按新增 star（info 字段）降序排序（原作者逻辑，非 GitHub 默认顺序）

fillReadmeSummary(item)       并发 4
  → 查库：该项目是否已有非空 README？
     有 → 复用缓存，不重复抓取
     无 → fetchReadme 抓 raw.githubusercontent.com，marked 转纯文本，限 5 万字符
  → summary/solves 任一缺失才调用豆包 LLM（一次调用生成两项，喂 README 全文，禁用思考链防超时）

saveSnapshot(list, time, lang)  事务批量写入 trending_snapshots

pushToFeishu(list, label)     仅综合榜（无语言参数）推送，聚合为一条 post 消息
```

### 2.2 关键设计
| 设计点 | 说明 |
|---|---|
| 反爬 | 浏览器 UA + 系统代理（HTTPS_PROXY=127.0.0.1:10808），GitHub 需走代理 |
| README 纯文本化 | marked 解析 Markdown → 去样式代码，只留内容本身，限 5 万字符 |
| 缓存复用 | README 只要库里有非空就复用；summary/solves 任一缺失才调 LLM（省 token、省请求） |
| 飞书消息格式 | `post.zh_cn`，每条项目 3 行：📌标题链接 / 💡一句话总结 / ⭐star ⬆新增 · 🗂语言 |
| 等待推送 | `await pushToFeishu`，确保进程退出前消息已发出（fire-and-forget 会丢消息） |

### 2.3 数据表 trending_snapshots
| 字段 | 说明 |
|---|---|
| dimension | daily / weekly / monthly |
| language | 语言主题筛选（空=综合榜） |
| title / links | 仓库名 / GitHub 地址 |
| description / repo_language | GitHub 简介 / 项目主要语言 |
| stars / forks / info | 当前 star / fork / 新增 star 文本（如 "23 stars today"） |
| avatar | 头像 URL |
| readme | README 纯文本（≤5 万字符） |
| summary | 豆包生成的一句话中文总结 |
| solves | 豆包生成的详细"项目解决什么问题"（一段话 50~150 字，面向谁/痛点/方案） |
| fetched_at | 抓取时间（同一项目多次抓取 → 历史快照） |

---

## 三、Star 趋势追踪算法（tracker.js）⭐ 核心

### 3.1 要解决的问题
榜单快照只在项目**在榜当天**有数据，跌出榜单就断档。趋势追踪让项目有**连续**的 star 采样曲线，
同时通过**动态热度分级**控制采样频率：热门项目每天采样，冷门自动降频，避免对全部项目无差别高频查询。

### 3.2 热度分级（三级）
| 级别 | 采样频率 | 判定（近 7 天平均日增 star） |
|---|---|---|
| 🔥 **A 级**（热门） | **每天** | 日增 ≥ 50，或刚入库 < 7 天 |
| 🌤 **B 级**（温和） | **每周六** | 日增 10 ~ 49 |
| 🧊 **C 级**（冷淡） | **每月 28 日** | 日增 < 10 |

### 3.3 涨速计算（calcDailyDelta）
```
日增 = (本次采样 stars - 上次采样 stars) / 两次采样间隔天数
```
- 取该项目 `star_history` 中最近 2 条记录计算
- 不足 2 条 → 返回 null（视为"新项目"，按 3.6 处理）

### 3.4 升降级规则
| 方向 | 规则 | 设计意图 |
|---|---|---|
| **升级** | **即时**：B/C 级项目某次采样日增 ≥ 50 → 立即升 A | 恢复热门立刻回到每日采样，不滞后 |
| **降级** | **保守**：需**连续 3 次**采样不达标 | 避免一次波动就降频，曲线抖动不影响级别 |
| A → B | 连续 3 次日增 < 50 | 热门降温 |
| B → C | 连续 3 次日增 < 10 | 温和变冷淡 |

连续计数实现（countBelowStreak）：从 `star_history` 最近记录往前数，逐段算相邻日增，
凡 < 阈值则 streak+1，一旦达标立即中断。streak ≥ DOWNGRADE_STREAK(3) 才触发降级。

### 3.5 采样防抖
同一项目同一天只采样一次（按 `fetched_at::date` 判断），重复运行任务不会产生重复数据。

### 3.6 新项目处理
- `project_track_level` 中入库不足 7 天（NEW_PROJECT_DAYS）的项目，涨速算不出时**强制按 A 级**处理，
  快速建立每日基线；满 7 天后再按真实涨速归级。
- 首次运行（全库无 A 级项目）：自动**全量采样一次**（所有 B 级项目），建立真实涨速基线后统一分级。

### 3.7 追踪范围
`trending_snapshots` 中**最近 30 天出现过**的项目（去重）。幂等：已在追踪表的不重复插入。
API 连续失败 / 项目 404（已删除）→ 停止追踪。

### 3.8 数据来源与容错
- GitHub REST API `GET /repos/{owner}/{repo}` 返回 `stargazers_count`（精确数字）
- 认证：`gh auth token`（配额 5000 次/小时，远够用；未认证 60 次/小时会 403/429）
- 失败：单项目重试（采样失败仅记日志，不中断整体）

### 3.9 数据表
**star_history**（采样曲线）
| 字段 | 说明 |
|---|---|
| title | 项目 owner/repo |
| stars | 该次采样总 star（数字） |
| fetched_at | 采样时间（索引 title+fetched_at） |

**project_track_level**（级别状态）
| 字段 | 说明 |
|---|---|
| title | 项目（主键） |
| level | A / B / C（驱动下次采样频率） |
| created_at | 入库时间（用于新项目 7 天逻辑） |
| last_sampled_at | 上次采样时间 |
| base_stars / base_at | 初始基线 |

---

## 四、趋势接口

`GET /trend/:owner/:repo` → `star_history` 全量升序 + 每段 `delta_stars`（与上次采样差值）：
```json
{
  "title": "Comfy-Org/ComfyUI",
  "total_points": 2,
  "points": [
    { "stars": 129389, "fetched_at": "2026-08-24T01:02:24.621Z", "delta_stars": null },
    { "stars": 131847, "fetched_at": "2026-09-07T07:57:31.445Z", "delta_stars": 2458 }
  ]
}
```

---

## 五、可调参数速查

| 参数 | 位置 | 默认 | 含义 |
|---|---|---|---|
| HOT_DAILY_DELTA | tracker.js:17 | 50 | A 级阈值（日增 ≥ 50 每天采样） |
| WARM_WEEKLY_DELTA | tracker.js:18 | 10 | B 级阈值（日增 ≥ 10 每周采样，低于则 C） |
| DOWNGRADE_STREAK | tracker.js:19 | 3 | 连续几次不达标才降级 |
| NEW_PROJECT_DAYS | tracker.js:20 | 7 | 新项目强制 A 级的天数 |
| CACHE_TTL_MS | crawler.js | 10 分钟 | 榜单接口缓存有效期 |
| 定时时间 | SCHEDULED_TASKS.md | 见文件 | 9:00 / 9:05 / 9:30 / 9:35 各档 |

调整阈值后重新跑对应 `node track.js <period>` 即可生效（级别重算）。
