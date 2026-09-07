# GitHub Trending 爬虫 + Star 趋势追踪 —— 定时任务配置备份

> 本文件用于**迁移/恢复**定时任务。算法代码在仓库内（crawler.js / crawl.js / tracker.js / track.js），
> 定时任务只是"到点执行命令"的调度配置。迁移时照此重新创建即可。
>
> 所有时间均为**北京时间（Asia/Shanghai）**，通过 TRAE 定时自动化（Schedule）创建。

---

## 一、榜单爬取任务（node crawl.js）

### 1. GitHub Trending 每日 daily 榜拉取
- **名称**：`GitHub Trending 每日 daily 榜拉取`
- **cron**：`0 9 * * *`（每天 09:00）
- **命令**：`node crawl.js daily`
- **说明**（Schedule message）：
  > 在本机 `/Users/xingan/Documents/software/trending/crawler-for-github-trending` 项目目录下运行 `node crawl.js daily`。该命令会抓取 GitHub Trending daily 榜，为每个项目补 README 纯文本与一句话总结（复用数据库已有缓存，不重复抓取），写入 PostgreSQL 的 github_trending 库 trending_snapshots 表，并把汇总消息推送到飞书群。命令正常结束后进程会自动退出，无需启动 HTTP 服务。运行完成后确认日志输出 "[crawl] daily 榜拉取完成，共 N 个项目，已入库并推送飞书" 即算成功；如失败则查看报错原因并修复后重试。

### 2. GitHub Trending 每周六 weekly 榜拉取
- **名称**：`GitHub Trending 每周六 weekly 榜拉取`
- **cron**：`30 9 * * SAT`（每周六 09:30）
- **命令**：`node crawl.js weekly`
- **说明**（Schedule message）：同 daily，仅命令改为 `node crawl.js weekly`，成功日志为 "[crawl] weekly 榜拉取完成，共 N 个项目，已入库并推送飞书"。

### 3. GitHub Trending 每月 28 日 monthly 榜拉取
- **名称**：`GitHub Trending 每月 28 日 monthly 榜拉取`
- **cron**：`30 9 28 * *`（每月 28 日 09:30）
- **命令**：`node crawl.js monthly`
- **说明**（Schedule message）：同 daily，仅命令改为 `node crawl.js monthly`，成功日志为 "[crawl] monthly 榜拉取完成，共 N 个项目，已入库并推送飞书"。

---

## 二、Star 趋势追踪任务（node track.js）

> 由 `tracker.js` 实现热度分级算法：
> - **A 级（热门）**：近 7 天平均日增 star ≥ 50 → 每天采样
> - **B 级（温和）**：日增 10 ~ 49 → 每周六采样
> - **C 级（冷淡）**：日增 < 10 → 每月 28 日采样
> - **升级即时**：B/C 级项目某次采样日增 ≥ 50 → 立即升 A
> - **降级保守**：需连续 3 次不达标（A→B 连续 3 次日增 < 50；B→C 连续 3 次日增 < 10）
> - 首次运行（无 A 级项目时）自动全量采样建立涨速基线
>
> 采样数据写入 `star_history` 表，级别存于 `project_track_level` 表（本机 PostgreSQL，库 github_trending）。

### 4. star 趋势追踪每日采样（A 级）
- **名称**：`star 趋势追踪每日采样（A 级）`
- **cron**：`5 9 * * *`（每天 09:05，错开榜单爬取）
- **命令**：`node track.js daily`
- **说明**（Schedule message）：
  > 在 /Users/xingan/Documents/software/trending/crawler-for-github-trending 目录下执行 star 趋势追踪的每日任务：运行 `node track.js daily`（若 node 不在 PATH 请用完整路径）。该任务会自动：1) 把 trending_snapshots 中 30 天内活跃的项目纳入追踪（幂等，已存在的跳过）；2) 采样 A 级（热门，近7天日增>=50）项目的当前 star 数写入 star_history 表；3) 按涨速动态调整项目级别（升级即时：日增>=50 升 A；降级需连续3次不达标：A->B 需连续3次日增<50，B->C 需连续3次日增<10）。执行完检查日志确认采样成功，如遇到 GitHub API 限流说明 gh 认证失效需处理。数据库为本机 PostgreSQL 的 github_trending 库。

### 5. star 趋势追踪每周六采样（B 级）
- **名称**：`star 趋势追踪每周六采样（B 级）`
- **cron**：`35 9 * * SAT`（每周六 09:35）
- **命令**：`node track.js weekly`
- **说明**（Schedule message）：
  > 在 /Users/xingan/Documents/software/trending/crawler-for-github-trending 目录下执行 star 趋势追踪的每周任务：运行 `node track.js weekly`。该任务会自动：1) 把 trending_snapshots 中 30 天内活跃的新项目纳入追踪（幂等）；2) 采样 B 级（温和，近7天日增 10~49）项目的当前 star 数写入 star_history 表；3) 调整项目级别：B 级项目若最近一次采样日增>=50 即时升级为 A；B 级连续 3 次日增<10 降级为 C。执行完检查日志确认采样成功，如遇到 GitHub API 限流说明 gh 认证失效需处理。数据库为本机 PostgreSQL 的 github_trending 库。

### 6. star 趋势追踪每月 28 日采样（C 级）
- **名称**：`star 趋势追踪每月 28 日采样（C 级）`
- **cron**：`35 9 28 * *`（每月 28 日 09:35）
- **命令**：`node track.js monthly`
- **说明**（Schedule message）：
  > 在 /Users/xingan/Documents/software/trending/crawler-for-github-trending 目录下执行 star 趋势追踪的每月任务：运行 `node track.js monthly`。该任务会自动：1) 把 trending_snapshots 中 30 天内活跃的新项目纳入追踪（幂等）；2) 采样 C 级（冷淡，近7天日增<10）项目的当前 star 数写入 star_history 表；3) 调整项目级别：C 级项目若最近一次采样日增>=50 即时升级为 A。执行完检查日志确认采样成功，如遇到 GitHub API 限流说明 gh 认证失效需处理。数据库为本机 PostgreSQL 的 github_trending 库。

---

## 三、迁移步骤（换机器时）

1. `git clone git@github.com:hation/crawler-for-github-trending.git` → 代码全部回来
2. `npm install` 安装依赖
3. 恢复数据库：`pg_dump github_trending | psql <新库>`（含 trending_snapshots / star_history / project_track_level 三表）
4. 配置环境变量 `.env`：`FEISHU_WEBHOOK`（飞书机器人）、`ARK_API_KEY`（豆包密钥，也可由 ~/.codex/auth.json 提供）、可选 `DATABASE_URL`
5. 确认 `gh auth login` 已登录（track.js 采样 GitHub API 需要 token，配额 5000/小时）
6. 在本机 TRAE 定时自动化中按本文件第一节、第二节的配置重建 6 个任务
