import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRpSummaryInitialPrompt, buildRpSummaryPrompt, buildRpSummaryUpdatePrompt, RP_SUMMARY_SECTIONS } from "../src/scribe.ts";
import {
	memoryArchiveCompacted,
	memoryArcRecallForTurn,
	memoryEvidenceForEvent,
	memoryHasEvent,
	memoryListEventDigests,
	memoryRecallForTurn,
	memoryUpsertEventDigest,
	updateMemoryConfig,
	memoryListDiff,
} from "../src/memory/service.ts";
import { evictByPriority, evictionRank } from "../src/memory/store.ts";
import { parseRpSummaryEnvelope } from "../src/stage/compact.ts";
import { shouldRecallHistory, classifyRecallIntent, sideTextRetryLimit, sideTextTimeoutMs } from "../src/stage/engine.ts";
import type { MemoryChunk, MemoryChunkMeta, MemoryImportance, RpEventDigest } from "../src/memory/types.ts";

const scope = { sessionId: "sess-rp", card: "assets/cards/rpcard.png" };

const sampleEvent: RpEventDigest = {
	kind: "rp-event-digest",
	id: "event_first_meeting_001",
	status: "active",
	importance: "core",
	title: "男女主初次相遇",
	tags: ["初遇", "雨天", "递伞", "误会"],
	recallAnchors: ["第一次见面", "那把伞", "那场雨", "当初"],
	summary: "男主在雨中递伞，女主误认为催债人而离开。",
	evidenceLevel: "source-backed",
	sourceRefs: [{ entryId: "entry-0001", entryType: "message", turn: 1 }],
	branchLeafId: "leaf-1",
};

function enableMemory(cwd: string) {
	updateMemoryConfig(cwd, { enabled: true, injectOnTurn: true, searchTopK: 5, embedMode: "local" });
}

test("rp-memory: 事件卡 upsert + list + has", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-event-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);
		assert.equal(memoryHasEvent(cwd, scope, "event_first_meeting_001"), false, "外部给定 id 不再作为 canonical id");
		const list = memoryListEventDigests(cwd, scope);
		assert.equal(list.length, 1);
		assert.match(list[0]!.id, /^event_[0-9a-f]{16}$/);
		assert.equal(list[0]!.importance, "core");
		assert.deepEqual(list[0]!.recallAnchors, ["第一次见面", "那把伞", "那场雨", "当初"]);

		// 幂等更新：同 id 覆盖不新增
		await memoryUpsertEventDigest(cwd, scope, { ...sampleEvent, summary: "更新后的概括" });
		const again = memoryListEventDigests(cwd, scope);
		assert.equal(again.length, 1);
		assert.equal(again[0]!.summary, "更新后的概括");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 事件卡 → 证据两阶段召回（沿 sourceRefs 找到归档原文）", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-evidence-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);

		const narrative = "细雨里，他撑着伞快步走来。\n「姑娘，雨大。」他把伞递了过去。\n她一愣，盯着他看了两秒，忽然皱眉：「你是……账房派来讨债的？」\n「不是——」\n她没听完，转身就走，伞留在地上。";
		await memoryArchiveCompacted(cwd, scope, narrative, { sourceRefs: [{ entryId: "entry-0001", entryType: "message", turn: 1 }] });

		// 两阶段：先撞事件卡（定位），再取证据（原文）
		const hits = await memoryRecallForTurn(cwd, scope, "第一次见面 递伞 讨债");
		assert.ok(hits.length >= 1, "应命中至少一条记忆");
		const eventHit = hits.find((h) => h.meta?.kind === "event");
		assert.ok(eventHit, "应命中事件卡");
		assert.match(eventHit!.meta!.eventId!, /^event_[0-9a-f]{16}$/);

		const evd = await memoryEvidenceForEvent(cwd, scope, eventHit!.meta!.eventId!);
		assert.ok(evd.length >= 1, "应沿事件取回归档证据");
		assert.match(evd[0]!.text, /讨债|递|伞/, "证据块应含原文细节");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 事件→证据 无事件卡时不产出证据", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-noevent-"));
	try {
		enableMemory(cwd);
		const narrative = "某条没有事件卡的早期剧情，这里只有一段普通日常。";
		await memoryArchiveCompacted(cwd, scope, narrative, { sourceRefs: [{ entryId: "entry-9999" }] });
		const evd = await memoryEvidenceForEvent(cwd, scope, "event_nonexistent");
		assert.equal(evd.length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 分级保活 core/major 不被自动淘汰", () => {
	const mk = (id: string, importance: MemoryImportance, createdAt: string): MemoryChunk => ({
		id,
		text: `chunk-${id}`,
		embedding: [1, 2, 3],
		meta: { kind: "evidence", importance } as MemoryChunkMeta,
		createdAt,
	});
	const chunks: MemoryChunk[] = [
		mk("old-minor", "minor", "1999-01-01"),
		mk("core-first", "core", "1999-01-01"),
		mk("new-major", "major", "2020-05-05"),
		mk("mid-normal", "normal", "2010-01-01"),
		mk("old-major", "major", "2000-01-01"),
		mk("new-minor", "minor", "2025-01-01"),
	];
	const kept = evictByPriority(chunks, 4);
	const ids = new Set(kept.map((c) => c.id));
	// core + 两个 major 一定存活
	assert.ok(ids.has("core-first"), "core 不淘汰");
	assert.ok(ids.has("old-major"), "major 不淘汰");
	assert.ok(ids.has("new-major"), "major 不淘汰");
	// 被淘汰的一定是 normal / minor 里最新的两条
	assert.ok(!ids.has("new-minor"), "最该淘汰的 minor 被弹掉");
	assert.equal(kept.length, 4);
	// 顺序保持原序
	assert.deepEqual(kept.map((c) => c.id), ["core-first", "new-major", "mid-normal", "old-major"]);
	assert.equal(evictionRank(chunks[0]), 1);
	assert.equal(evictionRank(chunks[1]), 3, "证据副本允许淘汰，核心事件卡本身负责保活");
});

test("rp-memory: 摘要提示词初建/增量结构正确 + 回读纪律", () => {
	const initial = buildRpSummaryInitialPrompt({
		conversationText: "第一天，两人在雨中相遇。",
		stateSnapshot: "{\"time\":\"第一天\"}",
		language: "中文",
		userName: "沈舟",
		charName: "云澜",
	});
	assert.match(initial.systemPrompt, /## Story Phase/);
	assert.match(initial.systemPrompt, /## Current Continuity/);
	assert.match(initial.systemPrompt, /## Recall Index/);
	assert.match(initial.systemPrompt, /不续写剧情/);
	assert.ok(initial.userText.includes("<conversation>"));

	const update = buildRpSummaryUpdatePrompt({
		conversationText: "第二天，误会澄清。",
		stateSnapshot: "{\"time\":\"第二天\"}",
		previousSummary: "## Story Phase\n相识\n## Current Continuity\n第一天，雨中。",
		language: "中文",
		userName: "沈舟",
		charName: "云澜",
		newEvents: "event_first_meeting_001：初遇",
	});
	assert.match(update.systemPrompt, /PRESERVE/);
	assert.match(update.systemPrompt, /MOVE/);
	assert.match(update.systemPrompt, /UPDATE/);
	assert.match(update.systemPrompt, /Current Continuity/);
	assert.ok(update.userText.includes("<previous-summary>"));
	assert.ok(update.userText.includes("<new-events>"));

	// 兼容门面：无 previousSummary → 初建；有 → 增量
	const viaInitial = buildRpSummaryPrompt({ conversationText: "x", stateSnapshot: "{}", language: "中文", userName: "u" });
	const viaUpdate = buildRpSummaryPrompt({ conversationText: "x", stateSnapshot: "{}", previousSummary: "old", language: "中文", userName: "u" });
	assert.match(viaInitial.systemPrompt, /## Story Phase/);
	assert.ok(!viaUpdate.userText.includes("<new-events>") || viaUpdate.userText.includes("<previous-summary>"));
	assert.match(viaUpdate.systemPrompt, /PRESERVE/);
});

test("rp-memory: 长期纪要固定结构节齐备", () => {
	for (const section of ["## Story Phase", "## Characters", "## Core Events", "## Promises & Threads", "## Canon Facts", "## Knowledge Boundaries", "## Current Continuity", "## Recall Index"]) {
		assert.ok(RP_SUMMARY_SECTIONS.includes(section), `缺 ${section}`);
	}
});

test("rp-memory: 归档带 sourceRefs 后 meta 携带", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-srcref-"));
	try {
		enableMemory(cwd);
		const narrative = "某段足够长的早期剧情原文，至少超过切块下限。";
		await memoryArchiveCompacted(cwd, scope, narrative, { sourceRefs: [{ entryId: "entry-7777", entryType: "message", turn: 7 }] });
		const { loadChunks } = await import("../src/memory/store.ts");
		const chunks = loadChunks(cwd, scope, "narrative");
		assert.ok(chunks.length >= 1);
		assert.equal(chunks[0]!.meta?.kind, "evidence");
		assert.deepEqual(chunks[0]!.meta?.sourceRefs, [{ entryId: "entry-7777", entryType: "message", turn: 7 }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 分支可见性过滤只返回当前祖先链上的事件与证据", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-branch-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);
		await memoryArchiveCompacted(cwd, scope, "雨中递伞与身份误会的原文证据。", { sourceRefs: [{ entryId: "entry-0001", entryType: "message", turn: 1 }] });
		const hidden = await memoryRecallForTurn(cwd, scope, "第一次见面 递伞", new Set(["branch-b-entry"]));
		assert.equal(hidden.length, 0, "兄弟分支不得看到父分支有锚点的事件");
		const visible = await memoryRecallForTurn(cwd, scope, "第一次见面 递伞", new Set(["entry-0001"]));
		assert.ok(visible.some((hit) => hit.meta?.kind === "event"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 摘要 envelope 可解析；旧 Markdown 仍兼容；历史触发预判不召回普通拍", () => {
	const parsed = parseRpSummaryEnvelope(JSON.stringify({ version: 2, summaryMarkdown: "## Story Phase\n相识", events: [{ id: "source_meeting", title: "初遇", summary: "递伞", tags: [], recallAnchors: [] }] }));
	assert.equal(parsed.summary, "## Story Phase\n相识");
	assert.equal(parsed.events.length, 1);
	assert.equal(parsed.events[0]!.kind, "rp-event-digest");
	assert.equal(parseRpSummaryEnvelope("## Story Phase\n旧格式").summary, "## Story Phase\n旧格式");
	assert.equal(shouldRecallHistory("今天放学后去体育馆。"), false);
	assert.equal(shouldRecallHistory("阿黛尔、妮菲尔等你老婆以前的几个闺蜜。"), false);
	assert.equal(shouldRecallHistory("你还记得以前我们第一次见面的事吗？"), true);
	assert.equal(shouldRecallHistory("你还记得我们第一次见面吗？"), true);
	assert.equal(shouldRecallHistory("这些年我们一路走来经历了什么"), true);
	assert.equal(sideTextTimeoutMs("memoryEvents"), 60_000);
	assert.equal(sideTextTimeoutMs("compaction"), 120_000);
	assert.equal(sideTextRetryLimit("memoryEvents"), 1);
});

test("rp-memory: 语义去重——同事件不同描述→合并一张卡+sourceRefs累积+status演进", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-merge-"));
	try {
		enableMemory(cwd);
	const first = { ...sampleEvent, importance: "major" as const, status: "active" as const,
		sourceRefs: [{ entryId: "entry-0010", entryType: "message", turn: 10 }] };
	await memoryUpsertEventDigest(cwd, scope, first);
	const cards1 = memoryListEventDigests(cwd, scope);
	assert.equal(cards1.length, 1);

	const evolved: RpEventDigest = { ...sampleEvent,
		id: "source_same_event_wording",
		sourceKey: "source_same_event_wording",
		title: "雨中初遇（更新版）",
		status: "resolved",
		importance: "core",
		summary: "男主递伞后女主终于接过，误会解除。",
		sourceRefs: [{ entryId: "entry-0020", entryType: "message", turn: 20 }],
	};
	await memoryUpsertEventDigest(cwd, scope, evolved);
	const cards2 = memoryListEventDigests(cwd, scope);
	assert.equal(cards2.length, 1, "余弦相似文案合并，不应新增卡");
	const merged = cards2[0];
	assert.equal(merged.status, "resolved");
	assert.equal(merged.importance, "core", "合并取高importance");
	assert.equal(merged.title, "男女主初次相遇", "保旧title为召回锚稳定");
	assert.match(merged.summary, /解除/);
	assert.ok(merged.sourceRefs.length >= 2, "sourceRefs 累积不丢");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 长期事件 sourceRefs 保留最新24条而非最旧证据", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-refs-"));
	try {
		enableMemory(cwd);
		for (let turn = 1; turn <= 30; turn++) {
			const prior = memoryListEventDigests(cwd, scope)[0];
			await memoryUpsertEventDigest(cwd, scope, {
				...sampleEvent,
				id: turn === 1 ? sampleEvent.id : `source-evolved-${turn}`,
				sourceKey: turn === 1 ? sampleEvent.sourceKey : `source-evolved-${turn}`,
				sourceRefs: [
					...(prior?.sourceRefs.slice(-1) ?? []),
					{ entryId: `entry-${turn}`, entryType: "message", turn },
				],
			}, turn === 1 ? undefined : { mergeInto: prior!.id, reason: "test-evolution" });
		}
		const refs = memoryListEventDigests(cwd, scope)[0]!.sourceRefs;
		assert.equal(refs.length, 24);
		assert.equal(refs[0]!.entryId, "entry-7");
		assert.equal(refs.at(-1)!.entryId, "entry-30");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 锚词直通——recallAnchors命中不依赖embedding质量", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-anchor-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);
		const hits = await memoryRecallForTurn(cwd, scope, "还记得那把伞吗");
		const eventHit = hits.find((item) => item.meta?.kind === "event");
		assert.ok(eventHit, "锚词直通应命中事件卡（local-hash下embedding可能不中）");
		assert.equal(eventHit.score, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 召回意图——sweep扫码荡型请求", () => {
	assert.equal(classifyRecallIntent("今天去体育馆吗"), "point");
	assert.equal(classifyRecallIntent("从头讲讲我们当初怎么认识的"), "sweep");
	assert.equal(classifyRecallIntent("还记得我们第一次见面吗"), "point");
	assert.equal(classifyRecallIntent("这一路走来经历了什么"), "sweep");
	assert.equal(classifyRecallIntent("我们之间到底发生过什么"), "point");
	assert.equal(classifyRecallIntent("来龙去脉给我说清楚"), "sweep");
});

test("rp-memory: 线召回——按弧线聚合、分支过滤、cap生效", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-arc-"));
	try {
		enableMemory(cwd);
		const makeEvent = (id: string, arc: string | undefined, turn: number, title: string, summary: string): RpEventDigest => ({
			kind: "rp-event-digest", id, title, status: "active", importance: "normal", tags: [], recallAnchors: [],
			summary, evidenceLevel: "source-backed", turnRange: { from: turn, to: turn },
			sourceRefs: [{ entryId: `entry-turn-${turn}`, entryType: "message", turn }], arc,
		});
		await memoryUpsertEventDigest(cwd, scope, makeEvent("e1", "误会线", 1, "递伞误会", "女主误认男主为催债人。"));
		await memoryUpsertEventDigest(cwd, scope, makeEvent("e2", "误会线", 23, "关系恶化", "两人冷战数月。"));
		await memoryUpsertEventDigest(cwd, scope, makeEvent("e3", "误会线", 87, "互相理解", "误会终于澄清。"));
		await memoryUpsertEventDigest(cwd, scope, makeEvent("e4", "救赎线", 50, "一次救助", "男主在事故中救了女主。"));
		const arcs = memoryArcRecallForTurn(cwd, scope, new Set(["entry-turn-1", "entry-turn-23", "entry-turn-87", "entry-turn-50"]));
		assert.ok(arcs.length >= 2);
		assert.match(arcs[0].text, /误会线/);
		assert.match(arcs[0].text, /拍1|拍23|拍87/);
		const hidden = memoryArcRecallForTurn(cwd, scope, new Set(["entry-turn-999"]));
		assert.equal(hidden.length, 0, "兄弟分支无可见事件→无线");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: memory_diff审计记录create/merge", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-diff-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);
		const diff1 = memoryListDiff(cwd, scope);
		assert.ok(diff1.length >= 1);
	assert.equal(diff1[0].op, "create");
	assert.equal(diff1[0].title, "男女主初次相遇");

	const evolved = { ...sampleEvent, title: "雨中初遇（修正）", summary: "同ID覆盖走update。", status: "resolved" as const };
	await memoryUpsertEventDigest(cwd, scope, evolved);
	const diff2 = memoryListDiff(cwd, scope);
	assert.ok(diff2.length >= 2);
	assert.ok(diff2[0].op === "merge" || diff2[0].op === "update");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: SKILL.md含op/arc/links字段要求", () => {
	const skill = readFileSync("skills/剧情记忆摘要/SKILL.md", "utf8");
	assert.match(skill, /"op"/);
	assert.match(skill, /"arc"/);
	assert.match(skill, /"links"/);
	assert.match(skill, /caused_by/);
	assert.match(skill, /evolved_from/);
	assert.match(skill, /resolved_the/);
	assert.match(skill, /contradicts/);
	assert.match(skill, /merge:</);
	assert.match(skill, /existing-arcs/);
});

test("rp-memory: 逐 entry 归档 → 事件证据精确到条目，不误拉到无关 entry", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-precise-"));
	try {
		enableMemory(cwd);
		await memoryArchiveCompacted(cwd, scope, "整段占位", {
			perEntry: [
				{ entryId: "entry-001", entryType: "message", turn: 1, text: "早上的寒暄：沈舟值日后在走廊遇见云澜，只说了两句天气。".repeat(8) },
				{ entryId: "entry-002", entryType: "message", turn: 2, text: "云澜把一块青玉佩塞进沈舟掌心，说三年后在青梧谷相见，以此为信物。" },
				{ entryId: "entry-003", entryType: "message", turn: 3, text: "两人各怀心事，谁也没有再说话。".repeat(6) },
			],
		});
		await memoryUpsertEventDigest(cwd, scope, {
			...sampleEvent,
			sourceRefs: [{ entryId: "entry-002", entryType: "message", turn: 2 }],
			sourceKey: "source_envelope_002",
		});
		const targets = memoryListEventDigests(cwd, scope);
		const event = targets.find((e) => e.title === sampleEvent.title);
		assert.ok(event, "事件卡应已入库");
		const evidence = await memoryEvidenceForEvent(cwd, scope, event!.id, 2);
		assert.ok(evidence.length >= 1, "应返回证据原文块");
		assert.ok(evidence[0]!.text.includes("青玉佩"), "证据应来自 entry-002 而非寒暄/沉默条目");
		assert.ok(!evidence[0]!.text.includes("寒暄"), "不得误拉到 entry-001");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 分支可见性 every 语义——多 sourceRefs 需全部落在祖先链", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-every-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, {
			...sampleEvent,
			title: "跨分支合并事件",
			sourceRefs: [
				{ entryId: "ancestor-1", entryType: "message", turn: 2 },
				{ entryId: "sibling-9", entryType: "message", turn: 9 },
			],
			branchLeafId: "leaf-b",
		});
		const events = memoryListEventDigests(cwd, scope, new Set(["ancestor-1"]));
		assert.equal(events.length, 0, "只看到部分 refs → 整卡不可见（防兄弟分支污染）");

		const visible = memoryListEventDigests(cwd, scope, new Set(["ancestor-1", "sibling-9"]));
		assert.ok(visible.some((e) => e.title === "跨分支合并事件"), "全部 refs 在祖先链 → 可见");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 显式 merge 跨分支目标被拒，共享来源才放行", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-mergeguard-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, {
			...sampleEvent,
			title: "初遇雨夜",
			sourceRefs: [{ entryId: "entry-a", entryType: "message", turn: 1 }],
			branchLeafId: "leaf-a",
		});
		const created = memoryListEventDigests(cwd, scope);
		const targetId = created[0]!.id;

		const cross = await memoryUpsertEventDigest(cwd, scope, {
			...sampleEvent,
			title: "初遇雨夜（兄弟分支演进）",
			sourceRefs: [{ entryId: "entry-b", entryType: "message", turn: 2 }],
			branchLeafId: "leaf-b",
		}, { mergeInto: targetId });
		assert.equal(cross.stored, false, "无共享来源 → 不得跨分支合并");
		assert.match(cross.error ?? "", /not reachable|merge target/i);

		const shared = await memoryUpsertEventDigest(cwd, scope, {
			...sampleEvent,
			title: "初遇雨夜（补录）",
			sourceRefs: [{ entryId: "entry-a", entryType: "message", turn: 1 }],
			branchLeafId: "leaf-a",
		}, { mergeInto: targetId });
		assert.equal(shared.stored, true, "共享来源 → 允许合并");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 并发归档不丢写（keyed 锁串行化）", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-conc-"));
	try {
		enableMemory(cwd);
		const entries = Array.from({ length: 6 }, (_, i) => ({
			entryId: `entry-c-${i}`,
			entryType: "message" as const,
			turn: i + 1,
			text: `并发归档第 ${i} 段正文，包含独特标记 token-${i} 与后续剧情的足够长度描述。`,
		}));
		await Promise.all(
			entries.map((e, i) => memoryArchiveCompacted(cwd, scope, entries.map((x) => x.text).join("\n"), { perEntry: [e] })),
		);
		const { loadChunks } = await import("../src/memory/store.ts");
		const chunks = loadChunks(cwd, scope, "narrative");
		for (let i = 0; i < entries.length; i++) {
			assert.ok(chunks.some((c) => c.text.includes(`token-${i}`)), `第 ${i} 段归档不得被并发覆盖丢失`);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: parseRpSummaryEnvelope 暴露 wasEnvelope 标志", () => {
	const envelope = parseRpSummaryEnvelope(JSON.stringify({ version: 2, summaryMarkdown: "## Story Phase\n开局。", events: [], }));
	assert.equal(envelope.wasEnvelope, true);
	const legacy = parseRpSummaryEnvelope("## 前情提要\n三拍剧情。");
	assert.equal(legacy.wasEnvelope, false);
	const garbage = parseRpSummaryEnvelope("   ");
	assert.equal(garbage.wasEnvelope, false);
	assert.equal(garbage.summary, "");
});
