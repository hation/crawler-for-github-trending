#!/usr/bin/env node
// ===== 补录 solves 字段（"项目解决什么问题"详细一段话）=====
// 对 trending_snapshots 中所有去重项目的最新快照，补录 solves。
// - 复用每项目最新快照已有的 README（不重复抓取）
// - 已存在 solves 的跳过（断点续跑）
// - 一次 LLM 调用同时产出 summary+solves，但只写缺失字段
// 用法：HTTPS_PROXY= HTTP_PROXY= node backfill_solves.js
require("dotenv").config();
const { pool, analyzeProject } = require("./crawler");

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
    // 取每个项目最新快照的 README/summary/solves
    const r = await pool.query(
        `SELECT DISTINCT ON (title) title, id, readme, summary, solves
         FROM trending_snapshots
         ORDER BY title, fetched_at DESC`
    );
    const todo = r.rows.filter((row) => !row.solves || !row.solves.trim());
    const done = r.rows.length - todo.length;
    const noReadme = todo.filter((row) => !row.readme || !row.readme.trim()).length;
    console.log(`[backfill] 去重项目共 ${r.rows.length}，已有 solves ${done}，待补录 ${todo.length}（其中无 README ${noReadme}，将跳过）`);

    let ok = 0, fail = 0, skipped = 0;
    const start = Date.now();
    await mapLimit(todo, 6, async (row) => {
        if (!row.readme || !row.readme.trim()) { skipped++; return; } // 无 README 跳过
        try {
            const item = { title: row.title, description: "" };
            const { summary, solves } = await analyzeProject(item, row.readme);
            const fields = [];
            const values = [];
            if (solves) { fields.push("solves = $1"); values.push(solves); }
            if (!row.summary && summary) { fields.push("summary = $2"); values.push(summary); }
            if (fields.length) {
                values.push(row.id);
                await pool.query(
                    `UPDATE trending_snapshots SET ${fields.join(", ")} WHERE id = $${values.length}`,
                    values
                );
                ok++;
                console.log(`  ✓ ${row.title}  solves已补（${(solves || "").length}字）`);
            } else {
                fail++;
                console.log(`  - ${row.title}  LLM未返回solves，跳过`);
            }
        } catch (e) {
            fail++;
            console.error(`  ✗ ${row.title}  失败: ${e.message.slice(0, 80)}`);
        }
    });

    console.log(`[backfill] 完成：成功 ${ok}，失败 ${fail}，无README跳过 ${skipped}，耗时 ${((Date.now() - start) / 1000).toFixed(1)}s`);
    const stat = await pool.query(
        `SELECT count(DISTINCT title) AS total,
                count(DISTINCT title) FILTER (WHERE solves IS NOT NULL AND solves <> '') AS has_solves
         FROM trending_snapshots`
    );
    console.log(`[backfill] 覆盖率：${stat.rows[0].has_solves} / ${stat.rows[0].total}`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error("[backfill] 失败:", e.message); process.exit(1); });
