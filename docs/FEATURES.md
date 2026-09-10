# 功能文档

> 本文档按**功能模块**整理本项目的全部能力：每个功能"做什么、怎么触发、核心逻辑、数据写入、依赖配置"。
> 代码是权威实现，本文档帮助理解全貌与定位功能入口。
>
> 配套文档：
> - [README.md](../README.md) —— 项目总览 / 快速开始 / 环境变量
> - [ALGORITHM.md](ALGORITHM.md) —— 核心算法细节（榜单解析、热度分级）
> - [SCHEDULED_TASKS.md](SCHEDULED_TASKS.md) —— 定时任务配置备份与迁移
> - [TOKEN_USAGE.md](TOKEN_USAGE.md) —— LLM token 消耗说明

---

## 一、功能总览

| # | 功能 | 入口 | 触发方式 | 数据表 |
|---|---|---|---|---|
| 1 | 榜单爬取 | `src/crawler.js` / `src/crawl.js` | CLI / 定时任务 / HTTP 兜底 | `trending_snapshots` |
| 2 | README 抓取与纯文本化 | `src/crawler.js` | 榜单爬取时自动 | `trending_snapshots.readme` |
| 3 | 豆包 LLM 分析（总结 + 解决什么问题） | `src/crawler.js` | 榜单爬取时自动 | `trending_snapshots.summary/solves` |
| 4 | 飞书推送 | `src/crawler.js` / `src/follow.js` | 爬取 / 关注扫描成功时 | 无（外部 webhook） |
| 5 | Star 趋势追踪（动态分级采样） | `src/tracker.js` / `src/track.js` | CLI / 定时任务 | `star_history`、`project_track_level` |
| 6 | 关注用户动态监控 | `src/follow.js` | CLI / 定时任务 | `followed_updates` |
| 7 | HTTP 查询接口 | `src/index.js` | 常驻服务 | 读取各表 |
| 8 | 历史补录脚本 | `src/backfill_solves.js` / `src/backfill_followed.js` | 手动一次性 | 更新各表 |
| 9 | Star 项目对比辅助脚本 | `tools/` 多个一次性脚本 | 手动 | 输出文件 |

---

## 二、功能明细

### 1. 榜单爬取

- **做什么**：抓取 GitHub Trending 的 daily / weekly / monthly 三个时间维度榜单（可指定语言主题），按"新增 star 数"降序排序后入库。
- **入口**：
  - `node src/crawl.js <daily|weekly|monthly> [language]`（CLI / 定时任务）
  - `GET /list/:time(/:language)` 在缓存过期时自动触发爬取（兜底）
- **核心逻辑**（[src/crawler.js](../src/crawler.js) 的 `getData` / `runCrawl`）：
  1. `getData`：请求 `https://github.com/trending[/语言]?since=时间`，用 cheerio 解析 `.Box-row` 提取 title / links / description / language / stars / forks / info（今日新增）/ avatar
  2. 按 `info`（新增 star）解析为数字后降序排序（保留原作者排序逻辑，非 GitHub 页面默认顺序）
  3. `runCrawl`：抓列表 → 并发 4 补齐 README/总结 → 入库 → 综合榜推送飞书
- **数据写入**：`trending_snapshots`（每条快照含维度、语言、项目字段、README、summary、solves、抓取时间）
- **依赖配置**：GitHub 网站需走系统代理（`HTTPS_PROXY` 环境变量）
- **注意**：带语言主题的数据只入库不推送；综合榜才推送飞书

### 2. README 抓取与纯文本化

- **做什么**：为每个项目抓取 README，转成纯文本（去掉样式代码、HTML 标签、脚本），保留段落结构。
- **入口**：榜单爬取时由 `fillReadmeSummary` 自动调用；`src/follow.js` / 补录脚本也会复用。
- **核心逻辑**（[src/crawler.js](../src/crawler.js) 的 `fetchReadme` / `markdownToText`）：
  1. 依次尝试多个 README 文件名（覆盖大小写变体）：`README.md / readme.md / Readme.md / README.MD / Readme.MD / README.markdown / README.rst / README.txt`
  2. 用 `marked` 转 HTML，cheerio 删除 script/style/img/svg/iframe，block 元素补换行保留段落
  3. 截断为前 5 万字符，避免存储与喂 LLM 过大
- **缓存复用**：库中已有非空 README 的项目直接复用，不重复抓取
- **数据写入**：`trending_snapshots.readme`
- **依赖配置**：raw.githubusercontent.com 走系统代理

### 3. 豆包 LLM 分析（一句话总结 + 解决什么问题）

- **做什么**：喂 README 全文给火山豆包 LLM，一次调用同时产出两个字段：
  - `summary`：一句话总结（≤30 字，中文）
  - `solves`：一段话说明"项目给谁用、解决什么痛点、大致怎么做"（50~150 字，中文）
- **入口**：
  - 榜单爬取时对缺失字段的项目自动调用（[src/crawler.js](../src/crawler.js) `analyzeProject` / `fillReadmeSummary`）
  - 关注用户新建仓库总结（[src/follow.js](../src/follow.js) `enrichCreateSummaries`）
  - 补录脚本（`src/backfill_solves.js` / `src/backfill_followed.js`）
- **核心逻辑**：以 `thinking: { type: "disabled" }` 禁用思考链防超时，`proxy: false` 国内直连，返回 JSON `{"summary":"...","solves":"..."}` 并容错解析。
- **提示词位置**：所有 LLM 提示词集中管理在 [src/prompts.js](../src/prompts.js)，修改后重跑对应命令即可对比效果。
- **缓存复用**：summary/solves 任一已有则只补缺失字段，两者都有则完全跳过 LLM（定时任务实际只对首次出现的新项目调用）。
- **数据写入**：`trending_snapshots.summary / solves`；`followed_updates.summary`
- **依赖配置**：`ARK_API_KEY`（缺省时读 `~/.codex/auth.json` 的 `OPENAI_API_KEY`）
- **注意**：这是本项目**唯一**消耗 LLM token 的核心环节（详见 [TOKEN_USAGE.md](TOKEN_USAGE.md)）

### 4. 飞书推送

- **做什么**：把拉取结果 / 关注动态聚合成一条飞书群消息。
- **入口**：
  - 榜单爬取完成（综合榜）→ [src/crawler.js](../src/crawler.js) `pushToFeishu`
  - 关注用户扫描完成 → [src/follow.js](../src/follow.js) `pushToFeishu`
- **推送内容**：
  - 榜单：`📌 项目名（链接）` / `💡 一句话总结` / `⭐ 当前star · 🗂 项目语言`
  - 关注动态：按用户分组，`👤 用户` 下依次列出新建仓库（`📌 / 💡 / ⭐ star · 🗂 语言`）与发版（`🚀 发布版本 v<tag>`）
- **格式**：飞书 `post` 富文本（`content.post.zh_cn`），聚合为一条消息，项目间空行分隔
- **依赖配置**：`FEISHU_WEBHOOK`（群自定义机器人）；`proxy: false` 国内直连

### 5. Star 趋势追踪（动态分级采样）

- **做什么**：对项目按热度分级，用不同频率采样 star 数，形成连续趋势曲线；热度下降自动降频、热度上升即时升级。
- **入口**：`node src/track.js <daily|weekly|monthly>`（CLI / 定时任务）
- **核心逻辑**（[src/tracker.js](../src/tracker.js)）：
  - **热度分级依据**：近 7 天平均日增 star
    - A 级（热门）：日增 ≥ 50 → 每天采样
    - B 级（温和）：日增 10 ~ 49 → 每周六采样
    - C 级（冷淡）：日增 < 10 → 每月 28 日采样
    - 新项目（入库 < 7 天）一律按 A 级快速建立基线
  - **升降级规则**：
    - 升级即时：B/C 级任意一次采样日增 ≥ 50 → 立即升回 A
    - 降级保守：需连续 3 次不达标（A→B 需连续 3 次日增 < 50；B→C 需连续 3 次日增 < 10）
  - **首次运行**（无 A 级项目）自动全量采样建立涨速基线
  - **防抖**：同一项目同一天只采样一次
  - **容错**：连续 5 次 API 失败 / 返回 404 的项目停止追踪（可能被删/改名）
- **数据写入**：
  - `star_history`：连续采样曲线（title + stars + fetched_at）
  - `project_track_level`：项目当前级别（title + level + base_stars + 时间戳）
- **依赖配置**：`gh` CLI 已登录（GitHub API token，配额 5000/小时，避免匿名 403/429）
- **初始化**：`initTrackingProjects` 把 `trending_snapshots` 中 30 天内活跃的项目纳入追踪（幂等）

### 6. 关注用户动态监控

- **做什么**：扫描当前 GitHub 账号关注的用户，监控两类动态：
  1. **新建仓库**（create）
  2. **发布新版本**（release）
  结果入库并按用户聚合推送飞书。
- **入口**：`HTTPS_PROXY= HTTP_PROXY= node src/follow.js [--days N]`（默认 7 天）
- **核心逻辑**（[src/follow.js](../src/follow.js)）：
  - `getFollowing`：拉取全部关注用户（分页）
  - `scanUser` 双通道扫描：
    - 新建仓库：`/users/{login}/repos?sort=created` 过滤 7 天内创建（含 stargazers_count、语言、描述）
    - 发版：`/users/{login}/events/public` 中的 `ReleaseEvent`（含 tag_name）
  - `enrichCreateSummaries`：对新建仓库调豆包生成一句话总结（复用 `fetchReadme` + `analyzeProject`，已有 summary 的跳过）
  - 入库用唯一约束 `(login, repo, event_type, event_at)` 去重
- **数据写入**：`followed_updates`（login / repo / event_type / event_at / tag_name / description / language / stars / summary）
- **依赖配置**：`gh` CLI 已登录；运行时清空代理环境变量让 GitHub API 直连
- **注意**：与榜单不同，这里走 GitHub REST API（免费配额），只对新建仓库总结调用 LLM

### 7. HTTP 查询接口

- **做什么**：常驻 HTTP 服务，提供榜单、详情、趋势、关注动态查询。
- **入口**：`node src/index.js`（默认端口 3000，占用时 `PORT=3001 node src/index.js`；或 `npm start`）
- **接口清单**（[src/index.js](../src/index.js)）：

| 接口 | 说明 |
|---|---|
| `GET /` | 重定向到 `/list/daily` |
| `GET /list/:time` | 榜单数据，time=daily/weekly/monthly；`?date=YYYY-MM-DD` 查历史某天 |
| `GET /list/:time/:language` | 指定语言主题榜单，如 `/list/daily/python` |
| `GET /repo/:owner/:repo` | 单个项目历史快照（含 README + 总结，最多 20 条） |
| `GET /trend/:owner/:repo` | star 趋势采样曲线（`star_history`），含每段涨跌 `delta_stars` |
| `GET /followed-updates?days=N` | 关注用户仓库动态，默认近 30 天 |

- **关键行为**：
  - `list` 接口缓存 10 分钟（`CACHE_TTL_SEC` 可调），过期才重新爬取；爬取失败但有历史缓存时返回旧数据兜底
  - 统一返回入库后的快照：`language` 恒为筛选维度，`repo_language` 为项目真实语言

### 8. 历史补录脚本

| 脚本 | 用途 | 逻辑 |
|---|---|---|
| `src/backfill_solves.js` | 为 `trending_snapshots` 全部去重项目补录 solves | 复用每项目最新快照已有 README（不重复抓取），一次 LLM 调用产出 summary+solves，只写缺失字段，断点续跑 |
| `src/backfill_followed.js` | 为 `followed_updates` 的 create 事件补 stars + summary | 先 `GET /repos/{owner}/{repo}` 取当前 star，再调豆包生成总结，`COALESCE` 只更新缺失字段 |

- **运行**：手动执行 `node src/backfill_solves.js` / `node src/backfill_followed.js`（或 `npm run backfill:solves` / `npm run backfill:followed`）
- **注意**：会消耗较多 LLM token（详见 [TOKEN_USAGE.md](TOKEN_USAGE.md)），仅按需运行

### 9. Star 项目对比辅助脚本（一次性）

> 以下脚本位于 `tools/`，用于"我的 GitHub star 项目 vs 本地 aiengine 目录"的对比报告，非定时任务，仅手动运行。
> 所有输入/缓存/中间产物/Excel 输出统一存于 `tools/data/`（**不写 /tmp 系统临时目录**，迁移后数据可复用）：

**完整流程**：
```
node tools/fetch_star_inputs.js        # ① 一键生成两个输入文件（gh 拉 star + 扫描本地目录）
node tools/translate_to_zh.js          # ②（可选）用豆包翻译描述 → starred_with_zh.json + 缓存
python3 tools/analyze_stars.py         # ③ 对比 + 分类 → starred_vs_local.json
python3 tools/export_excel_zh.py       # ④ 导出全中文多 Sheet Excel 报告
```

**tools/data/ 目录说明**：

| 文件 | 类型 | 作用 | 生产者 |
|---|---|---|---|
| `starred_all.json` | 输入 | 全部 star 项目列表（每行一个 JSON） | fetch_star_inputs.js（gh API） |
| `local_repos.txt` | 输入 | 本地克隆仓库清单（目录\|owner/repo\|remote） | fetch_star_inputs.js（扫描） |
| `zh_summary_cache.json` | 缓存 | 翻译缓存（避免重复调豆包） | translate_to_zh.js / fix2.js |
| `zh_summary.log` | 日志 | 翻译运行日志 | translate_to_zh.js |
| `starred_with_zh.json` | 中间产物 | 带中文一句话说明的 star 列表 | translate_to_zh.js |
| `starred_vs_local.json` | 中间产物 | star vs 本地克隆对比结果 | analyze_stars.py |
| `GitHub_Star_对比报告_中文版.xlsx` | 输出 | 中文版 Excel 报告 | export_excel_zh.py |
| `GitHub_Star_vs_Local_对比报告.xlsx` | 输出 | 英文版 Excel 报告 | export_excel.py |

| 脚本 | 用途 |
|---|---|
| `tools/fetch_star_inputs.js` | 生成输入文件：`gh api user/starred` 拉全部 star 项目 + 扫描本地目录输出仓库清单 |
| `tools/translate_to_zh.js` | 用豆包把 star 项目描述翻译为中文一句话说明（带本地缓存、质量校验、专有名词保留） |
| `tools/fix2.js` | 修复个别翻译不合格项 |
| `tools/analyze_stars.py` | 对比 star 列表与本地克隆目录，做 AI 相关性判断与分类标注 |
| `tools/export_excel.py` / `tools/export_excel_zh.py` | 把对比结果导出为多 Sheet 中/英文 Excel 报告 |

---

## 三、数据表清单

统一存于本机 PostgreSQL，库名 `github_trending`：

| 表 | 用途 | 主要字段 | 写入方 |
|---|---|---|---|
| `trending_snapshots` | 榜单快照（按抓取时间累积，支持历史查询） | dimension / language / title / links / description / repo_language / stars / forks / info / avatar / readme / summary / solves / fetched_at | 榜单爬取 |
| `star_history` | star 连续采样曲线 | title / stars / fetched_at | 趋势追踪 |
| `project_track_level` | 项目热度级别 | title / level(A/B/C) / base_stars / base_at / last_sampled_at / created_at | 趋势追踪 |
| `followed_updates` | 关注用户动态 | login / repo / event_type / event_at / tag_name / description / language / stars / summary / fetched_at | 关注扫描 |

> `star_history` 与 `project_track_level` 由 `src/track.js` 首次运行时自动建表；`followed_updates` 需手动建表（见 README 或迁移记录）。

---

## 四、定时任务一览

共 7 个任务（TRAE 系统级定时自动化，非应用内 cron），详见 [SCHEDULED_TASKS.md](SCHEDULED_TASKS.md)：

| 任务 | 时间 | 命令 |
|---|---|---|
| daily 榜拉取 | 每天 09:00 | `node src/crawl.js daily` |
| weekly 榜拉取 | 每周六 09:30 | `node src/crawl.js weekly` |
| monthly 榜拉取 | 每月 28 日 09:30 | `node src/crawl.js monthly` |
| star 趋势每日采样（A 级） | 每天 09:05 | `node src/track.js daily` |
| star 趋势每周六采样（B 级） | 周六 09:35 | `node src/track.js weekly` |
| star 趋势每月 28 日采样（C 级） | 28 日 09:35 | `node src/track.js monthly` |
| 关注用户动态每周扫描 | 每周一 09:45 | `HTTPS_PROXY= HTTP_PROXY= node src/follow.js 7` |

---

## 五、文件角色对照

| 文件 | 角色 |
|---|---|
| `src/crawler.js` | 核心模块：榜单抓取 / README / 豆包分析 / 飞书推送 / 数据库池（被各模块复用） |
| `src/crawl.js` | 榜单爬取 CLI 入口 |
| `src/tracker.js` | 趋势追踪算法模块 |
| `src/track.js` | 趋势追踪 CLI 入口 |
| `src/follow.js` | 关注用户动态扫描 + 推送 |
| `src/index.js` | HTTP 查询服务 |
| `src/backfill_solves.js` / `src/backfill_followed.js` | 历史补录脚本 |
| `tools/translate_to_zh.js` 等 | 一次性辅助脚本（Star 对比） |
