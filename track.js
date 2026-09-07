#!/usr/bin/env node
// ===== Star 趋势追踪 CLI 入口 =====
// 用法：node track.js <daily|weekly|monthly>
//   daily   = 每天 9 点：采样 A 级（热门）并调级
//   weekly  = 每周六 9 点：采样 B 级（温和）并调级
//   monthly = 每月 28 日 9 点：采样 C 级（冷淡）并调级
const { runTrack } = require("./tracker");

const period = process.argv[2];

if (!["daily", "weekly", "monthly"].includes(period)) {
    console.error("用法: node track.js <daily|weekly|monthly>");
    process.exit(1);
}

console.log(`[track] 开始 ${period} 采样`);
runTrack(period)
    .then(() => {
        console.log(`[track] ${period} 采样完成，进程正常退出`);
        process.exit(0);
    })
    .catch((e) => {
        console.error("[track] 失败:", e.message);
        process.exit(1);
    });
