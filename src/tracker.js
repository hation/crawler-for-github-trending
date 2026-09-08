// ===== Star 趋势追踪模块 =====
// 按项目热度级别（A=每日 / B=每周 / C=每月）动态采样 GitHub star 数，写入 star_history 表。
// 热度分级依据「近 7 天平均日增 star」：
//   A 级：日增 >= 50，或刚入库 < 7 天
//   B 级：日增 10 ~ 49
//   C 级：日增 < 10 或长期不变
// 升降级规则（每次采样后计算）：
//   - 降级：A 连续 3 次日增 < 50 -> B；B 连续 3 次日增 < 10 -> C
//   - 升级：B/C 任意一次采样日增 >= 50 -> 升回 A
require("dotenv").config();
const axios = require("axios");
const HttpsProxyAgent = require("https-proxy-agent");
const { pool } = require("./crawler");

// ===== 配置 =====
// 热度分级阈值
const HOT_DAILY_DELTA = 50;   // 日增 >= 50 视为热门（A 级）
const WARM_WEEKLY_DELTA = 10; // 日增 >= 10 视为温和（B 级），低于则 C 级
const DOWNGRADE_STREAK = 3;   // 连续多少次采样不达标则降级
const NEW_PROJECT_DAYS = 7;   // 入库不足 N 天一律按 A 级处理（快速建立基线）

// GitHub API 走系统代理（与爬虫一致）
const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const MAX_API_FAIL_STREAK = 5; // 某项目连续 5 次 API 失败则不再追踪（可能已被删/改名）

// ===== 工具：并发 map =====
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

// ===== 从 gh CLI 获取 GitHub 认证 token（提高 API 配额 5000/小时，避免 403/429）=====
let ghTokenCache = null;
function getGhToken() {
    if (ghTokenCache) return ghTokenCache;
    try {
        const { execSync } = require("child_process");
        ghTokenCache = execSync("gh auth token", { timeout: 10000 }).toString().trim();
        return ghTokenCache;
    } catch (_) {
        return null;
    }
}

// ===== 从 GitHub API 获取某项目当前 star 数 =====
async function fetchStars(title) {
    const url = `https://api.github.com/repos/${title}`;
    const token = getGhToken();
    const resp = await axios.get(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        httpsAgent,
        timeout: 20000,
    });
    return resp.data.stargazers_count;
}

// ===== 初始化追踪项目：把「30 天内活跃」的项目写入 project_track_level =====
// 已存在的项目跳过，新项目初始级别 B，并把 trending_snapshots 里最近一次 star 作为基线快照。
async function initTrackingProjects() {
    const active = await pool.query(
        `SELECT title,
                (SELECT stars FROM trending_snapshots t2
                  WHERE t2.title = t1.title AND t2.stars ~ '^[0-9,]+$'
                  ORDER BY fetched_at DESC LIMIT 1) AS last_stars,
                max(fetched_at) AS last_appeared
         FROM trending_snapshots t1
         GROUP BY t1.title
         HAVING max(fetched_at) >= now() - interval '30 days'`
    );
    console.log(`[track] 30 天内活跃项目：${active.rows.length} 个`);

    let inserted = 0, skipped = 0;
    for (const row of active.rows) {
        // 已在追踪表中则跳过
        const exist = await pool.query(
            `SELECT 1 FROM project_track_level WHERE title = $1`, [row.title]
        );
        if (exist.rows.length) { skipped++; continue; }

        const baseStars = row.last_stars ? parseInt(row.last_stars.replace(/,/g, ""), 10) : null;
        await pool.query(
            `INSERT INTO project_track_level (title, level, base_stars, base_at, last_sampled_at)
             VALUES ($1, 'B', $2, $3, $3)`,
            [row.title, baseStars, row.last_appeared]
        );
        // 基线快照也写入 star_history（若该时间点还没有）
        if (baseStars) {
            const existHist = await pool.query(
                `SELECT 1 FROM star_history WHERE title = $1 AND fetched_at = $2 LIMIT 1`,
                [row.title, row.last_appeared]
            );
            if (!existHist.rows.length) {
                await pool.query(
                    `INSERT INTO star_history (title, stars, fetched_at) VALUES ($1, $2, $3)`,
                    [row.title, baseStars, row.last_appeared]
                );
            }
        }
        inserted++;
    }
    console.log(`[track] 新增追踪项目 ${inserted} 个，已存在跳过 ${skipped} 个`);
    return inserted;
}

// ===== 计算某项目近 7 天平均日增 star =====
async function calcDailyDelta(title) {
    const r = await pool.query(
        `SELECT stars, fetched_at FROM star_history
         WHERE title = $1 ORDER BY fetched_at DESC LIMIT 2`,
        [title]
    );
    if (r.rows.length < 2) return null; // 只有一条，无法算涨速
    const [cur, prev] = r.rows;
    const days = (new Date(cur.fetched_at) - new Date(prev.fetched_at)) / 86400000;
    if (days <= 0) return null;
    return (cur.stars - prev.stars) / days;
}

// ===== 采样指定级别的一批项目 =====
async function sampleLevel(level) {
    // 取该级别的项目，跳过 base_at 为空的（无法计算涨速的会按新项目 A 级处理）
    const r = await pool.query(`SELECT title, base_stars FROM project_track_level WHERE level = $1`, [level]);
    if (!r.rows.length) {
        console.log(`[track] level=${level} 暂无项目`);
        return { sampled: 0, updated: 0 };
    }
    console.log(`[track] level=${level} 待采样 ${r.rows.length} 个项目`);

    let sampled = 0, updated = 0, fail = 0;
    await mapLimit(r.rows, 4, async (row) => {
        const title = row.title;
        // 防抖：同一级别同一天只采样一次（A 级每天一次，B/C 低频天然符合）
        const today = new Date();
        const sameDay = await pool.query(
            `SELECT 1 FROM star_history WHERE title = $1 AND fetched_at::date = $2::date LIMIT 1`,
            [title, today]
        );
        if (sameDay.rows.length) return; // 今天已采样过

        try {
            const stars = await fetchStars(title);
            await pool.query(
                `INSERT INTO star_history (title, stars, fetched_at) VALUES ($1, $2, now())`,
                [title, stars]
            );
            await pool.query(
                `UPDATE project_track_level SET last_sampled_at = now() WHERE title = $1`,
                [title]
            );
            sampled++;
            console.log(`  ✓ ${title}  -> ${stars} ⭐`);
        } catch (e) {
            fail++;
            console.error(`  ✗ ${title}  采样失败: ${e.message.slice(0, 60)}`);
            // 连续失败 5 次的项目停更（API 404 = 已删除/改名）
            const streak = await pool.query(
                `SELECT count(*) AS n FROM star_history
                 WHERE title = $1 AND fetched_at >= now() - interval '10 days'`,
                [title]
            );
            if (!streak.rows[0].n && e.response?.status === 404) {
                await pool.query(`DELETE FROM project_track_level WHERE title = $1`, [title]);
                console.warn(`  ! ${title} 已不存在(404)，停止追踪`);
            }
        }
    });
    console.log(`[track] level=${level} 完成：采样 ${sampled}，失败 ${fail}`);
    return { sampled, updated, fail };
}

// ===== 计算某项目连续 N 次采样日增是否都低于阈值 =====
// 返回从最新一次往前数，连续日增 < threshold 的采样次数（< DOWNGRADE_STREAK 不降级）
async function countBelowStreak(title, threshold) {
    const r = await pool.query(
        `SELECT stars, fetched_at FROM star_history
         WHERE title = $1 ORDER BY fetched_at DESC LIMIT $2`,
        [title, DOWNGRADE_STREAK + 1]
    );
    const rec = r.rows;
    if (rec.length < 2) return 0;
    let streak = 0;
    for (let i = 0; i < rec.length - 1; i++) {
        const days = (new Date(rec[i].fetched_at) - new Date(rec[i + 1].fetched_at)) / 86400000;
        if (days <= 0) break;
        const delta = (rec[i].stars - rec[i + 1].stars) / days;
        if (delta < threshold) streak++;
        else break; // 一旦有达标就中断
    }
    return streak;
}

// ===== 采样后动态调整项目级别 =====
// 升级（即时）：最近一次采样日增 >= HOT_DAILY_DELTA(50) -> A 级
// 降级（需连续 DOWNGRADE_STREAK 次不达标）：
//   A 连续 3 次日增 < 50 -> B；B 连续 3 次日增 < 10 -> C
async function adjustLevels(level) {
    const r = await pool.query(
        `SELECT title, created_at FROM project_track_level WHERE level = $1`,
        [level]
    );
    let upgraded = 0, downgraded = 0, unchanged = 0;
    for (const row of r.rows) {
        const delta = await calcDailyDelta(row.title);
        if (delta === null) {
            // 无足够历史：入库不足 7 天按 A 处理（快速建立基线），否则保持原级
            const ageDays = (Date.now() - new Date(row.created_at)) / 86400000;
            if (ageDays < NEW_PROJECT_DAYS && level !== "A") {
                await pool.query(`UPDATE project_track_level SET level = 'A' WHERE title = $1`, [row.title]);
                upgraded++;
            } else {
                unchanged++;
            }
            continue;
        }

        let newLevel = null;
        if (delta >= HOT_DAILY_DELTA) {
            // 热门 -> 一律升/保持 A
            if (level !== "A") newLevel = "A";
        } else {
            // 非热门：按当前级别判断是否连续不达标 -> 降级
            if (level === "A") {
                const streak = await countBelowStreak(row.title, HOT_DAILY_DELTA);
                if (streak >= DOWNGRADE_STREAK) newLevel = "B";
            } else if (level === "B") {
                const streak = await countBelowStreak(row.title, WARM_WEEKLY_DELTA);
                if (streak >= DOWNGRADE_STREAK) newLevel = "C";
            }
        }

        if (newLevel && newLevel !== row.level) {
            await pool.query(`UPDATE project_track_level SET level = $1 WHERE title = $2`, [newLevel, row.title]);
            console.log(`  [级别] ${row.title}: ${row.level} -> ${newLevel} (日增 ${delta.toFixed(1)})`);
            if (newLevel === "A") upgraded++; else downgraded++;
        } else {
            unchanged++;
        }
    }
    console.log(`[track] 级别调整完成：升级 ${upgraded}，降级 ${downgraded}，不变 ${unchanged}`);
    return { upgraded, downgraded, unchanged };
}

// ===== 主流程：按任务类型采样 + 调级 =====
async function runTrack(period) {
    // period: 'daily' | 'weekly' | 'monthly'
    await initTrackingProjects();

    if (period === "daily") {
        // 首次运行（尚无 A 级项目，初始全为 B）：先全量采样 B 级建立真实涨速基线，再统一分级
        const aCnt = await pool.query(
            `SELECT count(*) AS n FROM project_track_level WHERE level = 'A'`
        );
        if (Number(aCnt.rows[0].n) === 0) {
            console.log("[track] 首次运行：全量采样建立涨速基线");
            await sampleLevel("B");
        } else {
            // 每天：采样 A 级（热门）
            await sampleLevel("A");
        }
        // 分级：A/B/C 各查一遍（升级即时、降级需连续 3 次）
        await adjustLevels("A");
        await adjustLevels("B");
        await adjustLevels("C");
    } else if (period === "weekly") {
        // 每周六：采样 B 级（温和），并计算 B/C 升级机会
        await sampleLevel("B");
        await adjustLevels("B");
        await adjustLevels("C");
    } else if (period === "monthly") {
        // 每月 28 日：采样 C 级（冷淡），并检查回升
        await sampleLevel("C");
        await adjustLevels("C");
    } else {
        throw new Error("period 必须是 daily/weekly/monthly");
    }

    // 汇总当前各级别数量
    const stat = await pool.query(
        `SELECT level, count(*) AS n FROM project_track_level GROUP BY level ORDER BY level`
    );
    console.log(`[track] 当前追踪项目：${stat.rows.map(r => `${r.level}=${r.n}`).join("  ")}`);
    return stat.rows;
}

module.exports = { runTrack, initTrackingProjects, sampleLevel, adjustLevels, fetchStars };
