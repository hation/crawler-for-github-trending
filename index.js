const express = require("express");
const { runCrawl, pool } = require("./crawler");

const app = express();

// ===== 基础配置 =====
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_SEC) || 600) * 1000; // 默认缓存 10 分钟

// ===== 列表接口逻辑：查缓存 -> 过期则爬取并存库 =====
async function handleList(req, res) {
    const time = req.params.time;
    const language = req.params.language || "";
    const date = req.query.date;

    if (!["daily", "weekly", "monthly"].includes(time)) {
        return res.status(400).json({ error: "time 参数必须是 daily/weekly/monthly" });
    }

    // 指定历史日期：返回该日期最新一批的全部快照
    if (date) {
        const r = await pool.query(
            `SELECT s.* FROM trending_snapshots s
             JOIN (SELECT max(fetched_at) AS t FROM trending_snapshots
                   WHERE dimension = $1 AND language = $2 AND fetched_at::date = $3::date) m
               ON s.fetched_at = m.t
             WHERE s.dimension = $1 AND s.language = $2
             ORDER BY s.id`,
            [time, language, date]
        );
        if (!r.rows.length) return res.status(404).json({ error: "该日期没有快照数据" });
        return res.json(r.rows);
    }

    // 取最新一批的时间
    const latest = await pool.query(
        `SELECT max(fetched_at) AS t FROM trending_snapshots WHERE dimension = $1 AND language = $2`,
        [time, language]
    );
    const lastTime = latest.rows[0].t;
    const needRefresh = !lastTime || Date.now() - new Date(lastTime).getTime() > CACHE_TTL_MS;

    if (needRefresh) {
        try {
            await runCrawl(time, language);
            // 统一返回入库后的快照，字段结构与缓存命中一致（language = 筛选维度，repo_language = 项目语言）
            const r = await pool.query(
                `SELECT * FROM trending_snapshots WHERE dimension = $1 AND language = $2
                 AND fetched_at = (SELECT max(fetched_at) FROM trending_snapshots WHERE dimension = $1 AND language = $2)
                 ORDER BY id`,
                [time, language]
            );
            return res.json(r.rows);
        } catch (e) {
            console.error("[crawl] failed:", e.message);
            if (lastTime) {
                // 爬取失败但有历史缓存，返回旧数据兜底
                const r = await pool.query(
                    `SELECT * FROM trending_snapshots WHERE dimension = $1 AND language = $2 AND fetched_at = $3 ORDER BY id`,
                    [time, language, lastTime]
                );
                return res.json(r.rows);
            }
            return res.status(502).json({ error: "爬取 GitHub 失败，且无缓存数据", message: e.message });
        }
    }

    const r = await pool.query(
        `SELECT * FROM trending_snapshots WHERE dimension = $1 AND language = $2 AND fetched_at = $3 ORDER BY id`,
        [time, language, lastTime]
    );
    return res.json(r.rows);
}

app.get("/list/:time/:language", handleList);
app.get("/list/:time", handleList);
app.get("/", (req, res) => handleList({ params: { time: "daily" }, query: req.query }, res));

// ===== 单个项目详情（含 README + 一句话总结的历史快照）=====
app.get("/repo/:owner/:repo", async (req, res) => {
    const title = `${req.params.owner}/${req.params.repo}`;
    const r = await pool.query(
        `SELECT * FROM trending_snapshots WHERE title = $1 ORDER BY fetched_at DESC LIMIT 20`,
        [title]
    );
    if (!r.rows.length) return res.status(404).json({ error: "数据库中暂无该项目数据" });
    res.json(r.rows);
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}!`));
