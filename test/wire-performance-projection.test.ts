import assert from "node:assert/strict";
import test from "node:test";
import { performanceByNarrative } from "../server/performance-projection.ts";
import { toWireMsg } from "../server/wire.ts";
const raw = { version: 1, narrativeEntryId: "n1", totalMs: 9000, timeToFirstNarrativeMs: 500,
	phases: { writer: { durationMs: 6000, calls: 3, inputTokens: 100, outputTokens: 200, status: "success", prompt: "SECRET" }, prep: { durationMs: 7000, calls: 2 }, "SECRET-PHASE": { durationMs: 1, calls: 1 } }, rawPrompt: "SECRET", providerRetries: "SECRET", callsScope: "SECRET" };
test("关联明确 narrativeEntryId，不按相邻位置/当前最后正文归属", () => {
	const entries = [
		{ type: "message", id: "n1", message: { role: "assistant" } },
		{ type: "message", id: "n2", message: { role: "assistant" } },
		{ type: "custom", customType: "rp-turn-performance", data: raw },
		{ type: "custom", customType: "rp-turn-performance", data: { ...raw, narrativeEntryId: "absent" } },
	];
	const map = performanceByNarrative(entries);
	assert.deepEqual([...map.keys()], ["n1"]);
	assert.equal(map.get("n1")?.totalMs, 9000); // 不求和 6000+7000
	assert.ok(!JSON.stringify(map.get("n1")).includes("SECRET"));
});
test("wire 再次白名单投影：未知 phase/raw prompt/secret/retry 不能透传", () => {
	const msg = toWireMsg({ role: "assistant", content: "正文", details: { rpPerformance: raw, rpPerformanceOwner: "n1" } }, { charName: "角色", userName: "用户" });
	assert.equal(msg?.performance?.timeToFirstNarrativeMs, 500);
	assert.equal(msg?.performance?.callsScope, "harness-attempts");
	assert.equal(msg?.performance?.providerRetries, "unknown");
	assert.equal(msg?.performance?.phases.writer?.calls, 3);
	assert.ok(!JSON.stringify(msg).includes("SECRET"));
});
test("错 owner、非有限/负耗时不显示；不存在/越界首字不伪造", () => {
	const msg = (data: unknown, owner = "n1") => toWireMsg({ role: "assistant", content: "正文", details: { rpPerformance: data, rpPerformanceOwner: owner } }, { charName: "角色", userName: "用户" });
	assert.equal(msg(raw, "n2")?.performance, undefined);
	assert.equal(msg({ ...raw, totalMs: Infinity })?.performance, undefined);
	assert.equal(msg({ ...raw, totalMs: -1 })?.performance, undefined);
	assert.equal(msg({ ...raw, timeToFirstNarrativeMs: 10000 })?.performance?.timeToFirstNarrativeMs, undefined);
});
