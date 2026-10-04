import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { memoryArchiveCompacted, memoryArcRecallForTurn, memoryListEventDigests, memoryRecallForTurn, memoryUpsertEventDigest, updateMemoryConfig, updateStoreConfig } from "../src/memory/service.ts";
import type { RpEventDigest } from "../src/memory/types.ts";

test("rp-memory 1000-floor simulation: core event remains recallable after normal evidence churn", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-1000-"));
	const scope = { sessionId: "long-session", card: "cards/hero.png" };
	try {
		updateMemoryConfig(cwd, { enabled: true, injectOnTurn: true, embedMode: "local", searchTopK: 5 });
		updateStoreConfig(cwd, "narrative", { maxChunks: 200 });
		const firstMeeting: RpEventDigest = {
			kind: "rp-event-digest",
			id: "source_first_meeting",
			sourceKey: "source_first_meeting",
			status: "active",
			importance: "core",
			title: "男女主初次相遇",
			tags: ["初遇", "递伞", "误会"],
			recallAnchors: ["第一次见面", "那把伞", "当年雨天"],
			summary: "男主在雨中递伞，女主误认其为催债人。",
			evidenceLevel: "source-backed",
			sourceRefs: [{ entryId: "entry-turn-1", entryType: "message", turn: 1 }],
		};
		await memoryUpsertEventDigest(cwd, scope, firstMeeting);
		await memoryArchiveCompacted(cwd, scope, "雨里他把伞递给她。她却误以为他是催债人，转身离开。", {
			sourceRefs: [{ entryId: "entry-turn-1", entryType: "message", turn: 1 }],
		});
		const earlyHits = await memoryRecallForTurn(cwd, scope, "第一次见面 那把伞 催债人", new Set(["entry-turn-1"]));
		assert.ok(earlyHits.some((hit) => hit.meta?.kind === "evidence"), "证据缓存初始可召回");

		for (let turn = 2; turn <= 1000; turn++) {
			await memoryArchiveCompacted(cwd, scope, `第${turn}楼的普通日常：两人讨论课程、天气与晚餐安排。`, {
				sourceRefs: [{ entryId: `entry-turn-${turn}`, entryType: "message", turn }],
			});
		}

		const hits = await memoryRecallForTurn(cwd, scope, "第一次见面 那把伞 催债人", new Set(["entry-turn-1"]));
		assert.ok(hits.some((hit) => hit.meta?.kind === "event"), "1000楼后仍能命中初遇事件卡");
		// evidence 是可淘汰的缓存；真实台上命中事件后由 sourceRefs 回 Session Tree 取回原文。

		const hidden = await memoryRecallForTurn(cwd, scope, "第一次见面 那把伞", new Set(["entry-turn-1000"]));
		assert.equal(hidden.length, 0, "兄弟分支/不可见来源不得召回初遇证据");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory arc evolution: 同一误会线多次提取→去重合并不超过2张卡 + 线召回弧线完整", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-arc-evol-"));
	try {
		updateMemoryConfig(cwd, { enabled: true, injectOnTurn: true, embedMode: "local", searchTopK: 5 });
		const scope_ = { sessionId: "arc-evol", card: "assets/cards/test.png" };
		const makeEvent = (id: string, arc: string, turn: number, title: string, summary: string, importance: RpEventDigest["importance"] = "normal"): RpEventDigest => ({
			kind: "rp-event-digest", id, sourceKey: id, title, status: "active", importance,
			tags: [], recallAnchors: [], summary, evidenceLevel: "source-backed",
			sourceRefs: [{ entryId: `entry-${turn}`, entryType: "message", turn }],
			turnRange: { from: turn, to: turn }, arc,
		});
		await memoryUpsertEventDigest(cwd, scope_, makeEvent("ev01", "初遇误会线", 1, "初遇递伞误会", "男主递伞，女主误认为催债人。", "core"));
		await memoryUpsertEventDigest(cwd, scope_, makeEvent("ev02", "初遇误会线", 23, "关系恶化", "两人冷战数周。"));
		await memoryUpsertEventDigest(cwd, scope_, makeEvent("ev03", "初遇误会线", 87, "误会澄清", "女主得知真相，误会解除。", "major"));
		const events = memoryListEventDigests(cwd, scope_);
		assert.equal(events.length, 3, "三张不同标题的卡各自独立，未越线合并");

		const arcs = memoryArcRecallForTurn(cwd, scope_, new Set(["entry-1", "entry-23", "entry-87"]));
		assert.equal(arcs.length, 1, "三张卡同弧→一个弧线块");
		assert.match(arcs[0].text, /初遇误会线/);
		assert.match(arcs[0].text, /拍1|拍23|拍87/);
	assert.match(arcs[0].text, /误会/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
