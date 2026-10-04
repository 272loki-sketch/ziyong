import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { extractNovelOpening } from "../src/novel-play/opening.ts";
import { novelNodeId } from "../src/novel-play/source.ts";
import type { NovelSource } from "../src/novel-play/source.ts";
import type { StoredNovelPackage } from "../src/novel-play/store.ts";

function validOutput(quote = "旧钟楼。") {
	const fact = { text: quote, quote };
	return { time: fact, place: fact, sceneText: fact, openingNarration: fact, publicCharacterProfiles: [], publicWorldFacts: [fact] };
}

function fixture() {
	const text = "旧钟楼。清晨。门厅。雨停。锚点事件。未来凶手揭晓。";
	const source: NovelSource = { version: 1, docId: "doc-1", title: "测试小说", fingerprint: "fp-1", chunkChars: 100, chunks: [{ index: 0, chars: text.length, chapters: [], text }] };
	const quote = "锚点事件。";
	const start = text.indexOf(quote);
	const ref = { chunkIndex: 0, start, end: start + quote.length, quote };
	const node = { id: novelNodeId(source, ref, "anchor"), key: "anchor", stageId: "stage-1", order: 0, title: "锚点", summary: "摘要", visibility: "public" as const, dependsOn: [], sourceRefs: [ref] };
	const pkg = buildNovelPackage(source, [{ id: "stage-1", order: 0, title: "开篇" }], [node]);
	return { stored: { version: 1, source, package: pkg } satisfies StoredNovelPackage, anchor: { packageRevision: pkg.revision, nodeId: node.id, position: "before" as const } };
}

const base = (overrides: Partial<Parameters<typeof extractNovelOpening>[0]> = {}) => {
	const { stored, anchor } = fixture();
	return { stored, anchor, player: { name: "林岚", identity: "新来的管理员" }, skillBody: "只提取给定原文范围。", modelCall: async () => validOutput(), ...overrides };
};

test("小说开场提取：before/after 使用精确锚点截止，且绝不发送未来文本或摘要", async () => {
	for (const position of ["before", "after"] as const) {
		let sent = "";
		const proposal = await extractNovelOpening(base({
			anchor: { ...fixture().anchor, position },
			modelCall: async request => { sent = request.userText; return validOutput(); },
		}));
		const parsed = JSON.parse(sent);
		assert.doesNotMatch(parsed.source_range.text, /未来凶手揭晓/);
		assert.doesNotMatch(sent, /摘要/);
		assert.equal(parsed.source_range.text.includes("锚点事件。"), position === "after");
		assert.equal(proposal.confirmed, false);
		assert.equal((proposal.draft as { confirmed?: unknown }).confirmed, undefined);
		assert.equal(proposal.draft.user.identity, "新来的管理员");
	}
});

test("小说开场提取：预算只保留合格前缀的连续尾部", async () => {
	let supplied = "";
	await extractNovelOpening(base({ contextChars: 12, modelCall: async request => {
		supplied = JSON.parse(request.userText).source_range.text;
		const quote = supplied.slice(0, 4);
		return validOutput(quote);
	} }));
	assert.equal(supplied.length, 12);
	assert.doesNotMatch(supplied, /旧钟楼/);
	assert.doesNotMatch(supplied, /锚点事件/);
});

test("小说开场提取：缺失锚点、版本不匹配和多段锚点均闭门拒绝", async () => {
	await assert.rejects(extractNovelOpening(base({ anchor: { ...fixture().anchor, nodeId: "missing" } })), /节点不存在/);
	await assert.rejects(extractNovelOpening(base({ anchor: { ...fixture().anchor, packageRevision: "old" } })), /版本不匹配/);
	const { stored, anchor } = fixture();
	const node = stored.package.nodes[0];
	const second = { ...node.sourceRefs[0], start: 0, end: 4, quote: stored.source.chunks[0].text.slice(0, 4) };
	const changed = { ...node, sourceRefs: [node.sourceRefs[0], second], id: novelNodeId(stored.source, node.sourceRefs[0], node.key) };
	const pkg = buildNovelPackage(stored.source, stored.package.stages, [changed]);
	await assert.rejects(extractNovelOpening(base({ stored: { version: 1, source: stored.source, package: pkg }, anchor: { packageRevision: pkg.revision, nodeId: changed.id, position: anchor.position } })), /多段证据/);
});

test("小说开场提取：严格校验唯一引句并返回原文 chunk offsets 和确认 digest", async () => {
	const proposal = await extractNovelOpening(base({ modelCall: async () => `前言\n\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\`` }));
	assert.equal(proposal.digest.length, 64);
	assert.equal(proposal.evidence.length, 5);
	for (const evidence of proposal.evidence) {
		const chunk = fixture().stored.source.chunks[evidence.source.chunkIndex];
		assert.equal(chunk.text.slice(evidence.source.start, evidence.source.end), evidence.source.quote);
		assert.equal(evidence.rangeEnd - evidence.rangeStart, evidence.source.quote.length);
	}
	await assert.rejects(extractNovelOpening(base({ modelCall: async () => validOutput("。") })), /精确且唯一/);
	await assert.rejects(extractNovelOpening(base({ modelCall: async () => ({ ...validOutput(), time: { text: "编造时间", quote: "旧钟楼。" } }) })), /禁止补写/);
});

test("小说开场提取：坏输出按上限重试，取消立即停止且不重试", async () => {
	let attempts = 0;
	const proposal = await extractNovelOpening(base({ maxAttempts: 2, modelCall: async () => {
		attempts++;
		return attempts === 1 ? "bad" : validOutput();
	} }));
	assert.equal(proposal.confirmed, false);
	assert.equal(attempts, 2);
	attempts = 0;
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(extractNovelOpening(base({ signal: controller.signal, maxAttempts: 3, modelCall: async () => { attempts++; return validOutput(); } })), { name: "AbortError" });
	assert.equal(attempts, 0);
	await assert.rejects(extractNovelOpening(base({ maxAttempts: 4 })), /1 到 3/);
});

test("小说开场提取：外部玩家身份不要求原文证据，事实数组可以为空但核心场景不可缺", async () => {
	const proposal = await extractNovelOpening(base({ player: { name: "原文没有的人", identity: "用户明确设定的身份" }, modelCall: async () => ({ ...validOutput(), publicWorldFacts: [] }) }));
	assert.deepEqual(proposal.draft.user, { name: "原文没有的人", identity: "用户明确设定的身份" });
	assert.equal(proposal.draft.publicWorldFacts.length, 0);
	await assert.rejects(extractNovelOpening(base({ modelCall: async () => ({ ...validOutput(), openingNarration: undefined }) })), /必须是对象/);
});
