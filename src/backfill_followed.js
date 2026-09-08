#!/usr/bin/env node
// ===== 补录 followed_updates 历史 create 事件的 stars + summary =====
// 一次性脚本：为所有缺失 stars / summary 的 create 事件补上数据。
// 用法：node backfill_followed.js
require("dotenv").config();
const axios = require("axios");
const { execSync } = require("child_process");
const { pool, analyzeProject, fetchReadme } = require("./crawler");

const GITHUB_API = "https://api.github.com";

// gh CLI token（认证后配额 5000/小时）
let ghTokenCache = null;
function getGhToken() {
    if (ghTokenCache) return ghTokenCache;
    try {
        ghTokenCache = execSync("gh auth token", { timeout: 10000 }).toString().trim();
        return ghTokenCache;
    } catch (_) {
        return null;
    }
}

async function apiGet(path) {
    const token = getGhToken();
    const resp = await axios.get(`${GITHUB_API}${path}`, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 20000,
    });
    return resp.data;
}

async function mapLimit(arr, limit, fn) {
    const results = new Array(arr.length);
    let next = 0;
    async function worker() {
        while (next < arr.length) {
            const i = next++;
            results[i] = await fn(arr[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
    return results;
}

async function main() {
    const { rows } = await pool.query(
        `SELECT id, repo, description FROM followed_updates
         WHERE event_type = 'create' AND (stars IS NULL OR summary IS NULL OR summary = '')
         ORDER BY event_at DESC`
    );
    console.log(`[backfill] 待补录 ${rows.length} 条 create 事件`);
    let starsDone = 0, summaryDone = 0;

    await mapLimit(rows, 3, async (row) => {
        let stars = null, summary = null;
        // 1) 当前 star 数（repos 接口）
        try {
            const repo = await apiGet(`/repos/${row.repo}`);
            stars = repo.stargazers_count || 0;
            starsDone++;
        } catch (e) {
            console.error(`  [stars] ${row.repo} 失败: ${e.message.slice(0, 60)}`);
        }
        // 2) 一句话总结（优先喂 README，无 README 仅用描述）
        try {
            const readme = await fetchReadme(row.repo);
            const { summary: s } = await analyzeProject(
                { title: row.repo, description: row.description || "" },
                readme
            );
            summary = s;
            if (summary) summaryDone++;
        } catch (e) {
            console.error(`  [summary] ${row.repo} 失败: ${e.message.slice(0, 60)}`);
        }
        if (stars !== null || summary) {
            await pool.query(
                `UPDATE followed_updates SET
                    stars = COALESCE($1, stars),
                    summary = COALESCE($2, summary)
                 WHERE id = $3`,
                [stars, summary, row.id]
            );
        }
    });

    console.log(`[backfill] 完成：补 stars ${starsDone} 条，补 summary ${summaryDone} 条`);
    process.exit(0);
}

main().catch((e) => { console.error("[backfill] 失败:", e.message); process.exit(1); });
