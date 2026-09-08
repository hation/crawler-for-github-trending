#!/usr/bin/env node
// ===== 关注用户仓库更新监控（发版 / 建仓）=====
// 扫描当前 GitHub 账号关注的用户，收集近 7 天内：
//   1. 新建仓库（repos sort=created，created_at 在 7 天内）
//   2. 发布新版本（events 中的 ReleaseEvent，created_at 在 7 天内）
// 结果写入 followed_updates 表，并聚合推送飞书。
// 用法：node follow.js [--days 7]
require("dotenv").config();
const axios = require("axios");
const { execSync } = require("child_process");
const { pool } = require("./crawler");

const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || "";
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

// ===== 获取关注用户列表 =====
async function getFollowing() {
    const users = [];
    let page = 1;
    while (true) {
        const data = await apiGet(`/user/following?per_page=100&page=${page}`);
        if (!data.length) break;
        users.push(...data.map((u) => u.login));
        page++;
    }
    return users;
}

// ===== 扫描单个用户近 7 天的新建仓库 + 发版 =====
async function scanUser(login, since) {
    const events = [];
    // 1) 新建仓库：按创建时间排序，取最近 100 个，过滤 7 天内
    try {
        const repos = await apiGet(`/users/${login}/repos?sort=created&per_page=100`);
        for (const repo of repos) {
            if (new Date(repo.created_at) >= since) {
                events.push({
                    login, repo: repo.full_name, event_type: "create",
                    event_at: repo.created_at, tag_name: null,
                    description: repo.description || "", language: repo.language || null,
                });
            }
        }
    } catch (e) {
        console.error(`  [ERR] ${login} repos: ${e.message.slice(0, 60)}`);
    }

    // 2) 发布新版本：公开事件里的 ReleaseEvent
    try {
        const evs = await apiGet(`/users/${login}/events/public?per_page=100`);
        for (const ev of evs) {
            if (ev.type === "ReleaseEvent" && new Date(ev.created_at) >= since) {
                events.push({
                    login, repo: ev.repo.name, event_type: "release",
                    event_at: ev.created_at,
                    tag_name: ev.payload?.release?.tag_name || null,
                    description: ev.payload?.release?.name || ev.payload?.release?.tag_name || "",
                    language: null,
                });
            }
        }
    } catch (e) {
        console.error(`  [ERR] ${login} events: ${e.message.slice(0, 60)}`);
    }
    return events;
}

// ===== 飞书推送：按用户分组聚合 =====
async function pushToFeishu(events, days) {
    if (!FEISHU_WEBHOOK || !events.length) return;
    // 按用户分组
    const byLogin = {};
    for (const ev of events) {
        (byLogin[ev.login] = byLogin[ev.login] || []).push(ev);
    }
    const lines = [];
    for (const [login, evs] of Object.entries(byLogin)) {
        lines.push([
            { tag: "text", text: `👤 ${login}` },
            { tag: "a", text: ` (github.com/${login})`, href: `https://github.com/${login}` },
        ]);
        for (const ev of evs) {
            if (ev.event_type === "create") {
                lines.push([{ tag: "text", text: `  🏗 新建仓库  ` }]);
                lines.push([{ tag: "a", text: `    ${ev.repo}`, href: `https://github.com/${ev.repo}` }]);
                if (ev.description) lines.push([{ tag: "text", text: `    💬 ${ev.description.slice(0, 60)}` }]);
            } else {
                lines.push([{ tag: "text", text: `  🚀 发布版本 v${ev.tag_name || ""}` }]);
                lines.push([{ tag: "a", text: `    ${ev.repo}`, href: `https://github.com/${ev.repo}` }]);
            }
        }
        lines.push([{ tag: "text", text: "" }]);
    }
    const payload = {
        msg_type: "post",
        content: {
            post: {
                zh_cn: {
                    title: `🔔 关注的用户动态（近 ${days} 天）`,
                    content: lines,
                },
            },
        },
    };
    try {
        await axios.post(FEISHU_WEBHOOK, payload, { timeout: 30000, proxy: false });
        console.log(`[feishu] push success (${events.length} events, ${Object.keys(byLogin).length} users)`);
    } catch (e) {
        console.error("[feishu] push failed:", e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    }
}

// ===== 主流程 =====
async function main() {
    const days = parseInt(process.argv[2] || "7", 10);
    const since = new Date(Date.now() - days * 86400000);
    console.log(`[follow] 扫描近 ${days} 天关注的用户动态（起始 ${since.toISOString().slice(0, 10)}）`);

    const following = await getFollowing();
    console.log(`[follow] 关注用户 ${following.length} 个`);

    const allEvents = [];
    await mapLimit(following, 5, async (login) => {
        const evs = await scanUser(login, since);
        if (evs.length) {
            console.log(`  ✓ ${login}: ${evs.length} 个动态`);
            allEvents.push(...evs);
        }
    });

    // 按时间排序
    allEvents.sort((a, b) => new Date(b.event_at) - new Date(a.event_at));
    console.log(`[follow] 共发现 ${allEvents.length} 个动态（新建 ${allEvents.filter(e => e.event_type === "create").length} / 发版 ${allEvents.filter(e => e.event_type === "release").length}）`);

    // 入库（唯一约束去重，重复的跳过）
    let inserted = 0;
    for (const ev of allEvents) {
        try {
            await pool.query(
                `INSERT INTO followed_updates (login, repo, event_type, event_at, tag_name, description, language)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (login, repo, event_type, event_at) DO NOTHING`,
                [ev.login, ev.repo, ev.event_type, ev.event_at, ev.tag_name, ev.description || null, ev.language]
            );
            inserted++;
        } catch (e) {
            console.error(`  [DB] ${ev.repo} 入库失败: ${e.message.slice(0, 60)}`);
        }
    }
    console.log(`[follow] 入库 ${inserted} 条`);

    // 飞书推送
    if (allEvents.length) {
        await pushToFeishu(allEvents, days);
    } else {
        console.log("[follow] 近 7 天无动态，不推送");
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error("[follow] 失败:", e.message); process.exit(1); });
