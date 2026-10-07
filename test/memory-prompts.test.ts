import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildRpSummaryInitialPrompt, buildRpSummaryUpdatePrompt, RP_SUMMARY_SECTIONS } from "../src/scribe.ts";
import { parseRpSummaryEnvelope, runCompaction } from "../src/stage/compact.ts";
import { SUMMARY_ENTRY_TYPE, type BranchEntryLike } from "../src/stage/assemble.ts";
import { defaultState } from "../src/state.ts";
import { memorySearch } from "../src/tools/memory.ts";
import type { ToolContext } from "../src/tools/registry.ts";

const stageCtx = { surface: "stage", language: "中文" } as ToolContext;
const assistantCtx = { surface: "assistant", language: "中文" } as ToolContext;
const body = "林岚将铜钥匙归还给周青，说：‘钥匙已还清，约定到此兑现。’周青没有获知她此前的秘密身份。";
const ref = { entryId: "saved-prose", entryType: "message", turn: 37, textBasis: "rpNarrative" as const, charFrom: 0, charTo: body.length };
const tenSections = RP_SUMMARY_SECTIONS.split("\n").filter((line) => line.startsWith("## "));
const summary = tenSections.map((heading) => `${heading}\n本节只保存已确认事实。`).join("\n");
const event = {
	id: "source_return_key", sourceKey: "source_return_key", title: "林岚归还铜钥匙", status: "resolved", importance: "major",
	participants: ["林岚", "周青"], time: "次日傍晚", location: "桥边", arc: "铜钥匙约定线",
	tags: ["林岚", "铜钥匙", "归还"], recallAnchors: ["桥边的约定", "铜钥匙是否归还"],
	summary: "林岚归还铜钥匙，兑现此前的约定；周青仍不知她的秘密身份。",
	links: [{ to: "event_existing_promise", type: "resolved_the" }], sourceRefs: [ref], evidenceLevel: "source-backed",
};
const envelope = (events: unknown[]) => JSON.stringify({ version: 2, summaryMarkdown: summary, events });

test("记忆提示词：初建/增量保留十节、主要人物经历、已兑现结果和知情边界", () => {
	const input = { conversationText: body, stateSnapshot: "{}", language: "中文", userName: "周青", charName: "林岚" };
	for (const prompt of [buildRpSummaryInitialPrompt(input), buildRpSummaryUpdatePrompt({ ...input, previousSummary: summary })]) {
		for (const heading of tenSections) assert.ok(prompt.systemPrompt.includes(heading), heading);
		assert.match(prompt.systemPrompt, /关键事件和主要人物的重要经历/);
		assert.match(prompt.systemPrompt, /已解决的重要事件仍保留起因—关键行为—结果/);
		assert.match(prompt.systemPrompt, /时间先后不自动等于因果/);
		assert.match(prompt.systemPrompt, /作者读到秘密不表示角色知情/);
		assert.match(prompt.systemPrompt, /同一剧情线里的新选择、兑现、澄清等不要/);
		assert.match(prompt.systemPrompt, /未提供来源映射时留空/);
	}
	const update = buildRpSummaryUpdatePrompt({ ...input, previousSummary: summary }).systemPrompt;
	assert.match(update, /已兑现、已违约或取消/);
	assert.match(update, /不得仅因人物暂时离场、经历久远或事项已解决/);
	assert.match(update, /目标而非硬删阈值/);
	assert.doesNotMatch(update, /唯一能看到|第二套事实权威/);
});

test("记忆提示词：当前memory Skill送入摘要但不替换envelope，源正文不重复发送", () => {
	const prompt = buildRpSummaryInitialPrompt({ conversationText: body, stateSnapshot: "{}", language: "中文", userName: "周青",
		sourceEntries: [{ role: "assistant", text: body, sourceRef: ref }], memoryInstructions: "SYNTHETIC_USER_MEMORY_POLICY" });
	assert.match(prompt.systemPrompt, /SYNTHETIC_USER_MEMORY_POLICY/);
	assert.match(prompt.systemPrompt, /独立提取的外层 \{events\} 与 op 不替换本次协议/);
	assert.match(prompt.userText, /<conversation>\n<source-entries>/);
	assert.equal(prompt.userText.split(body).length - 1, 1, "不能把原文和source-entries各发送一次");
	assert.match(prompt.userText, /saved-prose/);
	assert.match(prompt.userText, /rpNarrative/);
});

test("事件Skill：人物覆盖、阶段独立、可执行merge和真实来源，不设建卡配额", () => {
	const skill = readFileSync("skills/剧情记忆摘要/SKILL.md", "utf8");
	assert.match(skill, /不默认只有一对男女主/);
	assert.match(skill, /本窗口有重要经历的主要人物/);
	assert.match(skill, /已解决、已结束不等于不值得记/);
	assert.match(skill, /新阶段事件/);
	assert.match(skill, /共享来源条目/);
	assert.match(skill, /不猜 merge/);
	assert.match(skill, /不要把整个窗口所有条目挂到每张卡/);
	assert.match(skill, /不设必出条数/);
	assert.match(skill, /计划本身可以记录为/);
});

test("两模式作者提示词：具体query、隐含回指、无命中不改人物记忆且不强制每拍检索", () => {
	for (const path of ["skills/主演文本直出/SKILL.md", "skills/导演主Agent/SKILL.md"]) {
		const skill = readFileSync(path, "utf8");
		assert.match(skill, /memory_search/);
		assert.match(skill, /人物姓名＋关键行为\/物品/);
		assert.match(skill, /还记得/);
		assert.match(skill, /额度允许/);
		assert.match(skill, /不.*原话|不能补成逐字原话/);
		assert.match(skill, /不.*角色.*忘记|无命中.*角色失忆/);
		assert.match(skill, /不.*强制.*检索|不.*强制查阅次数/);
		assert.doesNotMatch(skill, /必须.*story_search|调用.*recallEvidence/);
	}
	const expert = readFileSync("skills/导演证据整理/SKILL.md", "utf8");
	assert.match(expert, /非恋爱主线和主要配角/);
	assert.match(expert, /不能自行调用记忆或全文工具/);
	assert.match(expert, /不为通过来源校验制造事实/);
});

test("摘要envelope：事件字段往返、来源基准由宿主决定、范围限实际原文", () => {
	const parsed = parseRpSummaryEnvelope(envelope([{ ...event, sourceRefs: [{ ...ref, textBasis: "entryText", charFrom: -50, charTo: 999999 }, { entryId: "invented-source" }] }]), [ref]);
	assert.equal(parsed.events.length, 1);
	const saved = parsed.events[0]!;
	for (const key of ["participants", "time", "location", "arc", "links", "status", "importance", "recallAnchors"] as const) assert.deepEqual(saved[key], event[key]);
	assert.deepEqual(saved.sourceRefs, [ref], "不得保留伪造的source或模型选择的错误偏移基准");
	assert.equal(parseRpSummaryEnvelope(envelope([{ ...event, op: "skip" }]), [ref]).events.length, 0);
	assert.equal(parseRpSummaryEnvelope("## 前情\n正文\n## 人物\n角色\n## 伏笔\n未决").wasEnvelope, false);
});

test("memory_search：只有query参数，具体人物/物品查询无副作用，命中保留辨识字段", async () => {
	const props = (memorySearch.parameters(stageCtx) as { properties: Record<string, unknown> }).properties;
	assert.deepEqual(Object.keys(props), ["query"]);
	assert.match(memorySearch.description(stageCtx), /人物姓名＋关键行为\/物品/);
	const queries: string[] = [];
	const result = await memorySearch.run({ query: "林岚 铜钥匙 桥边 归还 是否兑现" }, { searchMemory: async (q) => {
		queries.push(q); return [{ text: JSON.stringify(event), meta: { kind: "event", evidenceLevel: "source-backed", eventId: "canonical-key" } }];
	} }, stageCtx);
	assert.deepEqual(queries, ["林岚 铜钥匙 桥边 归还 是否兑现"]);
	for (const text of ["人物：林岚、周青", "时间：次日傍晚", "地点：桥边", "剧情线：铜钥匙约定线", "事件概括，非逐字原文", "周青仍不知"]) assert.ok(result.text.includes(text), text);
	const other = await memorySearch.run({ query: queries[0] }, { searchMemory: async () => [{ text: JSON.stringify(event), meta: { kind: "event" } }] }, assistantCtx);
	assert.equal(result.text, other.text);
});

test("memory_search无命中：只承认检索缺口，不把角色失忆作为剧情出路", async () => {
	const result = await memorySearch.run({ query: "林岚 铜钥匙" }, { searchMemory: async () => [] }, stageCtx);
	assert.match(result.text, /必要且剩余检索额度允许/);
	assert.match(result.text, /无命中不表示事情没发生、角色失忆或承诺未兑现/);
	assert.doesNotMatch(result.text, /角色可以.*记不太清/);
});

function canonicalBranch(startTurn = 1): BranchEntryLike[] {
	return Array.from({ length: 10 }, (_, index) => {
		const turn = startTurn + index;
		return [
			{ id: `u-${turn}`, type: "message", message: { role: "user", content: `第${turn}拍输入，核对已发生的承诺与人物经历。` } },
			{ id: `a-${turn}`, type: "message", message: { role: "assistant", content: "DISPLAY_ONLY_SHOULD_NOT_ENTER_MEMORY",
				details: { rpNarrative: `第${turn}拍正文。${body}${"已确认行为与结果。".repeat(80)}` } } },
		] as BranchEntryLike[];
	}).flat();
}

test("真实压缩接线：调用前发送canonical条目来源，具体事件只回指选定来源", async () => {
	const branch = canonicalBranch(); let seen = false;
	const outcome = await runCompaction({
		getLeafId: () => "same-leaf", appendSummaryEntry: () => {},
		sideText: async (sp, ut) => {
			seen = true; assert.match(sp, /SYNTHETIC_MEMORY_SKILL/);
			assert.doesNotMatch(ut, /DISPLAY_ONLY_SHOULD_NOT_ENTER_MEMORY/);
			const entries = JSON.parse(ut.match(/<source-entries>\n([\s\S]*?)\n<\/source-entries>/)![1]);
			const chosen = entries.find((entry: { sourceRef: { entryId: string } }) => entry.sourceRef.entryId === "a-2");
			assert.ok(chosen); assert.equal(chosen.sourceRef.textBasis, "rpNarrative"); assert.equal(chosen.sourceRef.turn, 2);
			assert.ok(!entries.some((entry: { sourceRef: { entryId: string } }) => entry.sourceRef.entryId === "a-10"));
			return envelope([{ ...event, sourceRefs: [chosen.sourceRef, { entryId: "sibling-secret" }] }]);
		},
		appendEventDigests: async (events) => { assert.equal(events[0]!.sourceRefs.length, 1); assert.equal(events[0]!.sourceRefs[0]!.entryId, "a-2"); },
	}, { branch, state: defaultState(), language: "中文", userName: "周青", charName: "林岚", everyNTurns: 3, memoryInstructions: "SYNTHETIC_MEMORY_SKILL" });
	assert.equal(outcome.kind, "compacted"); assert.equal(seen, true);
});

test("增量来源拍号：第二次摘要的绝对拍号不从1重计", async () => {
	const old: BranchEntryLike[] = canonicalBranch(1).slice(0, 6);
	old.push({ id: "previous-summary", type: "custom", customType: SUMMARY_ENTRY_TYPE, data: { summary, coversThroughId: "a-3" } });
	const branch = [...old, ...canonicalBranch(4)];
	const outcome = await runCompaction({ getLeafId: () => "same-leaf", appendSummaryEntry: () => {}, sideText: async (_sp, ut) => {
		const entries = JSON.parse(ut.match(/<source-entries>\n([\s\S]*?)\n<\/source-entries>/)![1]);
		assert.equal(entries[0].sourceRef.turn, 4); assert.match(ut, /<previous-summary>/); return envelope([]);
	} }, { branch, state: defaultState(), language: "中文", userName: "周青", charName: "林岚", everyNTurns: 3 });
	assert.equal(outcome.kind, "compacted");
});

test("压缩来源兼容：旧SDK正文继续使用已清洗序列化，不强行改成canonical来源表", async () => {
	const branch = canonicalBranch();
	branch[1]!.message = { role: "assistant", content: "LEGACY_COMMITTED_STORY。" + "旧正文内容。".repeat(120) };
	const outcome = await runCompaction({ getLeafId: () => "same-leaf", appendSummaryEntry: () => {}, sideText: async (_sp, ut) => {
		assert.match(ut, /LEGACY_COMMITTED_STORY/); assert.doesNotMatch(ut, /<source-entries>/); return envelope([]);
	} }, { branch, state: defaultState(), language: "中文", userName: "周青", charName: "林岚", everyNTurns: 3 });
	assert.equal(outcome.kind, "compacted");
});

test("来源标签预算：JSON转义后超限回退旧正文，不重复或静默截断已提交文本", async () => {
	const branch = canonicalBranch();
	(branch[1]!.message!.details as Record<string, unknown>).rpNarrative = "QUOTE_BEGIN" + '"'.repeat(60_000) + "QUOTE_END";
	const outcome = await runCompaction({ getLeafId: () => "same-leaf", appendSummaryEntry: () => {}, sideText: async (_sp, ut) => {
		assert.match(ut, /QUOTE_BEGIN/); assert.match(ut, /QUOTE_END/); assert.doesNotMatch(ut, /<source-entries>/);
		assert.ok(ut.length < 120_000, "不能用重复来源正文绕过原输入预算"); return envelope([]);
	} }, { branch, state: defaultState(), language: "中文", userName: "周青", charName: "林岚", everyNTurns: 3 });
	assert.equal(outcome.kind, "compacted");
});


test("sourceAware反例：全部来源无效或空范围时拒绝整份摘要，不用整个窗口补源", async () => {
	for (const sourceRefs of [[{ entryId: "invented-source" }], [{ entryId: "a-2", charFrom: 999999, charTo: 999999 }], []]) {
		let writes = 0;
		const outcome = await runCompaction({ getLeafId: () => "same-leaf", appendSummaryEntry: () => { writes++; },
			archive: async () => { writes++; }, appendEventDigests: async () => { writes++; },
			sideText: async () => envelope([{ ...event, sourceRefs }]),
		}, { branch: canonicalBranch(), state: defaultState(), language: "中文", userName: "周青", charName: "林岚", everyNTurns: 3 });
		assert.equal(outcome.kind, "failed"); assert.equal(writes, 0);
		if (outcome.kind === "failed") assert.match(outcome.error, /拒绝用整个窗口补造证据/);
	}
});

test("摘要链接合同仅承诺已实现能力：不要求尚未重写的同批sourceKey目标", () => {
	const prompt = buildRpSummaryInitialPrompt({ conversationText: body, stateSnapshot: "{}", language: "中文", userName: "周青",
		memoryInstructions: readFileSync("skills/剧情记忆摘要/SKILL.md", "utf8") });
	assert.match(prompt.systemPrompt, /本路径的 links 只指已提供的已有 canonical id，不使用同批 sourceKey 目标/);
	assert.match(prompt.systemPrompt, /本路径尚不解析同批 sourceKey 链接/);
});
