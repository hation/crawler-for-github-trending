# 项目 Token 消耗说明

> 本文档说明本项目在哪些环节会消耗 LLM（火山豆包）token，以及消耗量估算与优化手段。
> 代码是权威实现（crawler.js / tracker.js / translate_to_zh.js）。

## 结论速览

本项目**只有 1 个环节**消耗 LLM token：**榜单爬取时给每个项目生成"一句话总结"**。

其余所有环节（Star 趋势追踪、README 抓取、HTTP 接口查询、飞书推送）均**不消耗 LLM token**。

| 环节 | 是否消耗 LLM token | 消耗对象 |
|---|---|---|
| ① 榜单爬取：一句话总结 | ✅ **是** | 豆包（火山方舟） |
| ② Star 趋势追踪 | ❌ 否 | GitHub REST API（免费配额） |
| ③ README 抓取 | ❌ 否 | raw.githubusercontent.com（静态文件） |
| ④ HTTP 接口查询 | ❌ 否 | 本机 PostgreSQL |
| ⑤ 飞书推送 | ❌ 否 | 飞书 webhook |

---

## ① 唯一消耗环节：一句话总结

位置：[crawler.js](crawler.js) 的 `summarizeWithLLM`（约 L127-162）

### 触发时机
- 每次爬取榜单（`node crawl.js <time>`），对列表中的项目生成中文一句话总结
- **只对"缺少 summary 缓存"的项目调用**，已有总结的不重复调用

### 输入 / 输出
| 项 | 说明 |
|---|---|
| 输入 | 项目名 + description + **README 全文**（纯文本，截断 5 万字符） |
| 输入 token 估算 | ≈ 1.5 万 ~ 2 万 token / 项目（README 是主要开销） |
| 输出 | 一句话中文总结（max_tokens=300，实际几十 token） |
| 模型 | doubao-seed-2.0-code，thinking 禁用（防超时） |

### 缓存保护（降低消耗的关键）
[crawler.js](crawler.js) 的 `fillReadmeSummary`：
1. **README 缓存复用**：库里已有非空 README 则直接复用，不重复抓取、不重复喂给 LLM
2. **summary 缓存复用**：库里已有总结则跳过 LLM 调用

> 效果：定时任务实际**只对首次出现的新项目**调 LLM，重复上榜的老项目 0 消耗。

### 每日消耗估算
- 榜单约 20 个项目/天，其中**首次出现**的通常只有几个
- 极端情况（全部新项目）：20 × ~2 万 token ≈ 40 万输入 token / 天
- 常态（少量新项目）：通常几万 token / 天以内

---

## ② Star 趋势追踪（不消耗 LLM）

位置：[tracker.js](tracker.js)

- 调用 **GitHub REST API**：`GET /api.github.com/repos/{owner}/{repo}`，只取 `stargazers_count` 数字
- 消耗的是 **GitHub API 配额**（gh token，5000 次/小时，免费），**非 LLM token**
- 动态热度分级（A/B/C）控制采样频率，进一步减少请求量

---

## ③ 辅助脚本（一次性，手动运行才消耗）

| 脚本 | 用途 | 消耗 |
|---|---|---|
| [translate_to_zh.js](translate_to_zh.js) | 翻译 GitHub star 项目描述为中文（如 324 个项目） | ≈ 项目数 次 LLM 调用 |
| [fix2.js](fix2.js) | 修复个别翻译不合格项 | ≈ 1~3 次 LLM 调用 |

> 这两个不在定时任务里，平时不会运行；仅在需要"把 star 项目描述翻译成中文"时手动执行。

---

## 优化建议（按效果排序）

| 方案 | 做法 | 效果 |
|---|---|---|
| 调低 README 截断 | `fetchReadme` 中 `text.slice(0, 50000)` → `20000` | 输入 token 省 ~60%，总结质量略降 |
| 只喂 description | `summarizeWithLLM` 不传 README，只传项目描述 | 输入 token 降到几百/项目，总结变粗略 |
| 收紧缓存 TTL | 调整缓存策略，减少重复抓取 | 降低 README 抓取量（非 token） |

> 当前配置已含缓存复用，属于"token 消耗最小化"的默认状态，一般无需额外优化。
