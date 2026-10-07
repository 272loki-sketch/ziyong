import assert from "node:assert/strict";
import test from "node:test";
import { buildEcologyRuntimePrompt, defaultLiteraryEcologyState, emptyEcologyCardPool, emptyEcologyGlobalPool, normalizeLiteraryEcologyState, validateEcologyTransition } from "../src/stage/literary-ecology.ts";
import { defaultState } from "../src/state.ts";

const text = "沈舟把信收好，说他明天会去图书馆帮忙。";
const quote = "他明天会去图书馆帮忙";
const trust = { entryId: "saved-story-1", text };
const evidence = { source: "narrative", sourceEntryId: trust.entryId, occurrenceId: "library", quote };
const event = (anchor: unknown = evidence) => ({ id: "library", name: "整理图书", userRole: "committed", userCommitment: anchor });
const next = (anchor: unknown = evidence) => normalizeLiteraryEcologyState({ occurrences: [event(anchor)] }, defaultLiteraryEcologyState())!;

test("双模式结算可引用宿主提供的已保存正文，保留模型写成的故事角色承诺", () => {
	const ecology = next();
	assert.deepEqual(validateEcologyTransition(defaultLiteraryEcologyState(), ecology, [], { trustedNarrative: trust }), []);
	assert.equal(ecology.occurrences[0].userRole, "committed");
	const start = text.indexOf(quote);
	assert.deepEqual(ecology.occurrences[0].userCommitment, { ...evidence, start, end: start + quote.length });
});

test("无宿主正文锚点时，正文、草稿与专家报告均不够成为承诺出处", () => {
	for (const anchor of [evidence, { ...evidence, source: "draft" }, { ...evidence, source: "expert" }]) {
		const ecology = next(anchor);
		validateEcologyTransition(defaultLiteraryEcologyState(), ecology, [], { latestUserEntryId: "u", latestUserText: text });
		assert.equal(ecology.occurrences[0].userRole, "optional");
		assert.equal(ecology.occurrences[0].userCommitment, undefined);
	}
});

test("正文来源 id、事件、逐字引文和 UTF-16 区间必须对应实际来源", () => {
	for (const anchor of [
		{ ...evidence, sourceEntryId: "other-branch-story" },
		{ ...evidence, occurrenceId: "other-event" },
		{ ...evidence, quote: "他愿意去图书馆帮忙" },
		{ ...evidence, start: 0, end: quote.length },
		{ ...evidence, source: "latest-user" },
	]) {
		const ecology = next(anchor);
		validateEcologyTransition(defaultLiteraryEcologyState(), ecology, [], { trustedNarrative: trust });
		assert.equal(ecology.occurrences[0].userRole, "optional");
	}
});

test("重复引文需明确精确区间，不能从两个角色的相同表述中猜测", () => {
	const repeated = { ...trust, text: text + text };
	const unanchored = next();
	validateEcologyTransition(defaultLiteraryEcologyState(), unanchored, [], { trustedNarrative: repeated });
	assert.equal(unanchored.occurrences[0].userRole, "optional");
	const start = text.indexOf(quote);
	const anchored = next({ ...evidence, start, end: start + quote.length });
	validateEcologyTransition(defaultLiteraryEcologyState(), anchored, [], { trustedNarrative: repeated });
	assert.equal(anchored.occurrences[0].userRole, "committed");
});

test("生态提示材料只在 aftermath 暴露宿主保存的正文 id，候选 narrativeText 不受信", () => {
	const input = { ecology: defaultLiteraryEcologyState(), global: emptyEcologyGlobalPool(), cardPool: emptyEcologyCardPool("card", "name"), state: defaultState(), history: [], userText: "继续", narrativeText: "候选稿" };
	for (const phase of ["arrival", "aftermath"] as const) {
		const normal = JSON.parse(buildEcologyRuntimePrompt("skill", { ...input, phase }).userText);
		assert.equal(normal.latest_turn.narrative_entry_id, null);
		const trusted = JSON.parse(buildEcologyRuntimePrompt("skill", { ...input, phase, trustedNarrative: trust }).userText);
		assert.equal(trusted.latest_turn.narrative_entry_id, phase === "aftermath" ? trust.entryId : null);
		assert.equal(trusted.latest_turn.narrative, phase === "aftermath" ? text : "候选稿");
	}
});
