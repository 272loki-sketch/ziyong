import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResearchSearchScheduler, millisecondsUntilLocalTime } from "../src/outline/research-scheduler.ts";

test("研究搜索调度器计算下一次本地时间", () => {
 const now = new Date("2026-09-01T05:30:00");
 assert.equal(millisecondsUntilLocalTime(now, 6, 0), 30 * 60_000);
 assert.equal(millisecondsUntilLocalTime(new Date("2026-09-01T06:00:00"), 6, 0), 24 * 60 * 60_000);
});

test("研究搜索调度器串行运行、同日跳过并持久化状态", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-research-schedule-")); const calls: string[] = [];
 try {
  const scheduler = new ResearchSearchScheduler(cwd, { enabled: true, hour: 6, minute: 0, maxPerRun: 3, topics: [" a ", "a", "b"] }, async (topic) => { calls.push(topic); return {} as never; });
  const now = new Date("2026-09-01T05:00:00");
  const first = await scheduler.runNow(now, true); assert.equal(first.completed, 2); assert.deepEqual(calls, ["a", "b"]); assert.equal(scheduler.status().lastStatus, "completed");
  const second = await scheduler.runNow(new Date("2026-09-01T06:01:00"), true); assert.equal(second.status, "skipped"); assert.equal(calls.length, 2);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("研究搜索调度器保留部分失败并继续其他主题", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-research-schedule-"));
 try {
  const scheduler = new ResearchSearchScheduler(cwd, { enabled: true, hour: 6, minute: 0, maxPerRun: 3, topics: ["ok", "bad", "ok2"] }, async (topic) => { if (topic === "bad") throw new Error("network"); return {} as never; });
  const result = await scheduler.runNow(); assert.equal(result.completed, 2); assert.equal(result.errors[0].message, "network"); assert.equal(scheduler.status().lastStatus, "partial");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});
