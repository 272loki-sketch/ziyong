import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCard } from "../src/card.ts";
import { buildNovelPlayCard } from "../src/novel-play/card.ts";
import type { NovelPackage } from "../src/novel-play/canon.ts";

function fixture() {
	const pkg: NovelPackage = {
		version: 1,
		docId: "doc-public",
		sourceFingerprint: "source-fingerprint",
		sourceChunkChars: 20_000,
		revision: "revision-1",
		stages: [{ id: "stage-1", order: 0, title: "开始" }],
		nodes: [{
			id: "node-start", key: "start", stageId: "stage-1", order: 0,
			title: "FUTURE_NODE_TITLE_DO_NOT_LEAK",
			summary: "FUTURE_NODE_SUMMARY_DO_NOT_LEAK",
			visibility: "secret", dependsOn: [],
			sourceRefs: [{ chunkIndex: 0, start: 0, end: 2, quote: "原文" }],
		}],
	};
	const input = {
		mode: "new-character" as const,
		workTitle: "雨夜藏书楼",
		pkg,
		anchor: { packageRevision: pkg.revision, nodeId: "node-start", position: "before" as const },
		snapshot: {
			confirmed: true as const,
			user: { name: "林岚", identity: "新来的图书管理员" },
			time: "九月清晨",
			place: "旧图书馆门厅",
			sceneText: "雨刚停，门厅里只有值班灯亮着。",
			openingNarration: "钥匙在锁孔里轻轻一响。",
			publicCharacterProfiles: [{ name: "周姨", profile: "门卫，认识每位常客。" }],
			publicWorldFacts: ["图书馆九点开门。"],
		},
		skillBody: "只依据卡内公开开场信息开始演出。",
	};
	return { pkg, input };
}

test("小说开演卡：V2 卡名表示作品演出而非玩家，现有 normalizeCard 保留标准字段", () => {
	const { input } = fixture();
	const raw = buildNovelPlayCard(input);
	const normalized = normalizeCard(raw);
	assert.equal(raw.spec, "chara_card_v2");
	assert.equal(normalized.name, "雨夜藏书楼·小说演出");
	assert.notEqual(normalized.name, input.snapshot.user.name);
	assert.equal(normalized.personality, "");
	assert.notEqual(normalized.personality, input.snapshot.user.identity);
	assert.match(normalized.description, /用户角色：林岚/);
	assert.match(normalized.description, /身份：新来的图书管理员/);
	assert.doesNotMatch(normalized.description, /周姨|图书馆九点开门/);
	assert.match(normalized.scenario, /九月清晨/);
	assert.equal(normalized.firstMes, "钥匙在锁孔里轻轻一响。");
	assert.equal(normalized.systemPrompt, input.skillBody);
	assert.deepEqual(normalized.book.map((entry) => entry.comment), [
		"小说开演·开场定位",
		"小说开演·人物·周姨",
		"小说开演·公开世界事实",
	]);
	assert.ok(normalized.book.every((entry) => entry.constant && entry.enabled));
	assert.match(normalized.book[0]?.content ?? "", /旧图书馆门厅/);
	assert.match(normalized.book[1]?.content ?? "", /认识每位常客/);
	assert.match(normalized.book[2]?.content ?? "", /图书馆九点开门/);
	assert.deepEqual(raw.data.extensions.liyuanNovelPlay, {
		docId: "doc-public", revision: "revision-1", startNodeId: "node-start", position: "before",
		playerName: "林岚", playerMode: "new-character",
	});
	assert.equal((normalized as unknown as { extensions?: unknown }).extensions, undefined);
});

test("小说开演卡：拒绝未确认快照、版本不匹配和不存在节点", () => {
	const { input } = fixture();
	assert.throws(() => buildNovelPlayCard({
		...input, snapshot: { ...input.snapshot, confirmed: false as true },
	}), /尚未由用户确认/);
	assert.throws(() => buildNovelPlayCard({
		...input, anchor: { ...input.anchor, packageRevision: "old" },
	}), /版本不匹配/);
	assert.throws(() => buildNovelPlayCard({
		...input, anchor: { ...input.anchor, nodeId: "missing" },
	}), /节点不存在/);
});

test("小说开演卡：作品标题及快照逐字段和总预算超限时拒绝", () => {
	const { input } = fixture();
	assert.throws(() => buildNovelPlayCard({ ...input, workTitle: "x".repeat(201) }), /作品标题超过长度上限/);
	assert.throws(() => buildNovelPlayCard({
		...input, snapshot: { ...input.snapshot, sceneText: "x".repeat(5_001) },
	}), /开场场景超过长度上限/);
	assert.throws(() => buildNovelPlayCard({
		...input,
		snapshot: {
			...input.snapshot,
			publicWorldFacts: Array.from({ length: 20 }, (_, index) => `${index}:${"x".repeat(1_400)}`),
		},
	}), /总长度超过上限/);
});

test("小说开演卡：不读取节点正文或未来剧情", () => {
	const { input } = fixture();
	const encoded = JSON.stringify(buildNovelPlayCard(input));
	assert.doesNotMatch(encoded, /FUTURE_NODE_TITLE_DO_NOT_LEAK/);
	assert.doesNotMatch(encoded, /FUTURE_NODE_SUMMARY_DO_NOT_LEAK/);
	assert.doesNotMatch(encoded, /source-fingerprint/);
	assert.doesNotMatch(encoded, /原文/);
});

test("小说开演卡：不修改输入", () => {
	const { input } = fixture();
	const before = structuredClone(input);
	buildNovelPlayCard(input);
	assert.deepEqual(input, before);
});

test("小说开演卡：拒绝输入字段中的角色宏，避免运行时身份替换", () => {
	const { input } = fixture();
	assert.throws(() => buildNovelPlayCard({ ...input, workTitle: "{{char}} 的故事" }), /可能意外改变身份文本/);
	assert.throws(() => buildNovelPlayCard({
		...input, snapshot: { ...input.snapshot, user: { ...input.snapshot.user, identity: "我是 {{char}} 的朋友" } },
	}), /可能意外改变身份文本/);
});
