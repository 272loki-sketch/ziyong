import { presentationFixtureReply } from "./support/agent-presentation-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@liyuan/agent-runtime";
import { DIRECTOR_ROLES, type DirectorPhase } from "../src/stage/agent-director.ts";
import { StageEngine, extractPureTextNarrative, type AssistantMsgLike, type StageStreamFn } from "../src/stage/engine.ts";
import { buildAgentPresentationMaterials, parseAgentPresentation } from "../src/stage/agent-presentation.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import type { GenerationMode } from "../src/stage/generation-mode.ts";

// Synthetic card/lore and faux streams only: no private card, credentials or API.
// New generation modes use agent-presentation; the legacy SDK strict builder is
// deliberately not called or given new expectations by these tests.
const CARD_SYSTEM = "FORMAT_PARITY_CARD_SYSTEM：依据原始卡格式交付，附属区域名为 <scene_sidecar>，不是正文容器。";
const CARD_POST = "FORMAT_PARITY_CARD_POST：保留本卡合法的 HTML 与 Markdown；不得只保留内置格式标签。";
const CARD_BOOK_FORMAT = "FORMAT_PARITY_CARD_BOOK：每拍正文之后附 <scene_sidecar>场景备忘</scene_sidecar>，不可省略这个自定义区域。";
const WORLD_FORMAT = 'FORMAT_PARITY_WORLD：每拍附 <aside class="scene-note"><strong>天气</strong>：薄雾</aside>，再附 Markdown 的 ## 场景备忘 与 - **天气**：薄雾。';
const OPTIONS_FORMAT = "FORMAT_PARITY_OPTIONS：每拍末尾保留 <options>1. 核对记录\n2. 观察灯塔</options> 行动选项。";
const INLINE_FORMAT = "FORMAT_PARITY_INLINE：<image> 插图及 <options> 行动选项位于正文内部；保留它们与前后叙事的相对位置，不得移到末尾。";
const SIDECAR = "<scene_sidecar>场景备忘：记录册已打开。</scene_sidecar>";
const HTML = '<aside class="scene-note"><strong>天气</strong>：薄雾</aside>';
const MARKDOWN = "## 场景备忘\n- **天气**：薄雾";
const OPTIONS = "<options>1. 核对记录\n2. 观察灯塔</options>";
const IMAGE = "<image>image### foggy observatory, lighthouse ###</image>";
const PARAGRAPHS = ["云澜从书架取下记录册。", "他指出窗外的灯塔。"];
const BODY = PARAGRAPHS.join("\n\n");
const LEGAL_FORMATS = { scene_sidecar: SIDECAR, HTML, Markdown: MARKDOWN, options: OPTIONS };

type Response = { text?: string; calls?: Array<{ name: string; args?: Record<string, unknown> }> };
type PresentationPayload = {
	phase: "agent-presentation";
	materials: ReturnType<typeof buildAgentPresentationMaterials>;
	frozen_narrative: string;
	author_draft: string;
	validation_errors?: string[];
};
const consult = (phase: DirectorPhase): Response => ({
	calls: [{ name: "consult_experts", args: { tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "只核对合成材料并返回报告" })) } }],
});
const directorScript = (body: string): Response[] => [
	consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] },
	{ text: body }, consult("review"), { calls: [{ name: "finalize" }] },
];

function presentationPayload(context: Parameters<StageStreamFn>[1]): PresentationPayload | undefined {
	for (const message of [...context.messages].reverse() as any[]) {
		if (message.role !== "user") continue;
		const text = message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
		try { const payload = JSON.parse(text); if (payload.phase === "agent-presentation") return payload; }
		catch { /* Main writer messages need not be JSON. */ }
	}
}

// A faux formatting response, not a production template: reuse the exact frozen
// text and any author-authored image. For a prose-only draft, insert one synthetic
// image between its two paragraphs. An inline draft is reconstructed from the
// untouched author_draft; the parser checks it against the frozen prose facts.
function presentationResponse(payload: PresentationPayload, inline = false): string {
	let body = inline ? payload.author_draft : payload.frozen_narrative;
	const image = payload.author_draft.match(/<(image(?:Tag)?)\b[^>]*>[\s\S]*?<\/\1\s*>/i)?.[0] ?? IMAGE;
	if (!/<image(?:Tag)?\b/i.test(body)) {
		assert.ok(body.includes("\n\n"), "the synthetic prose has two paragraphs for inline illustration");
		body = body.replace("\n\n", `\n\n${image}\n\n`);
	}
	if (inline) assert.ok(body.includes(OPTIONS), "inline actions must survive in the author body");
	const formats = [SIDECAR, HTML, MARKDOWN, ...(!body.includes(OPTIONS) ? [OPTIONS] : [])].join("\n\n");
	return JSON.stringify({ body, formats, requirements: [
		{ name: "合成行动选项", kind: "actions", quote: OPTIONS },
		...Object.entries({ scene_sidecar: SIDECAR, HTML, Markdown: MARKDOWN }).map(([name, quote]) => ({ name, kind: "card-format", quote })),
	], missing: [] });
}

// Adapted from generation-mode-engine.test.ts: actual assembly and settlement,
// bounded faux responses. Presentation calls are routed by user JSON phase, not
// prompt wording, and never consume the main-agent workflow script.
function fixture(mode: GenerationMode, body = BODY, options: { customOnly?: boolean; inline?: boolean; worldFormat?: string } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-format-parity-"));
	const cleanup = () => rmSync(cwd, { recursive: true, force: true });
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: {
			name: "云澜", description: "在观测站核对记录的同伴。", first_mes: "记录册在这里。",
			system_prompt: CARD_SYSTEM, post_history_instructions: CARD_POST,
			character_book: { entries: [{ id: 1, name: "合成场景备忘规则", keys: [], constant: true, enabled: true, content: CARD_BOOK_FORMAT }] },
		} }));
		writeFileSync(join(cwd, "world.json"), JSON.stringify({ entries: {
			1: { uid: 1, comment: "合成展示规则", key: [], constant: true, disable: false, content: options.worldFormat ?? WORLD_FORMAT },
			...(!options.customOnly ? { 2: { uid: 2, comment: "合成交付位置规则", key: [], constant: true, disable: false, content: options.inline ? INLINE_FORMAT : OPTIONS_FORMAT } } : {}),
		} }));
		mkdirSync(join(cwd, ".liyuan"));
		cpSync(new URL("../skills/", import.meta.url), join(cwd, "skills"), { recursive: true });
		const steps = ["literaryDirector", "literaryContinuity", "directorSetting", "directorIdeas", "directorReviewFacts", "directorReviewStyle", "ecologyRuntime", "scribe"];
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({
			card: "card.json", lorebooks: ["world.json"], userName: "沈舟", generationMode: mode,
			literaryEcologyEnabled: false, literaryWorldEnabled: false,
			stepModels: Object.fromEntries(steps.map(id => [id, { provider: "faux", id }])),
		}));
		const sm = SessionManager.create(cwd, join(cwd, "sessions"));
		const requests: Array<{ model: string; context: Parameters<StageStreamFn>[1]; presentation?: PresentationPayload }> = [];
		const script: Response[] = mode === "direct" ? [{ text: body }] : directorScript(body);
		let presentationFail = false;
		const streamFn: StageStreamFn = (model, context) => {
			assert.ok(requests.length < 64, "faux request budget exhausted");
			const payload = presentationPayload(context);
			requests.push({ model: model.id, context: structuredClone(context), presentation: payload });
			let response: Response | undefined;
			if(model.id==="writer") {
				response=presentationFixtureReply(context);
				try { const input=JSON.parse((context.messages[0] as any)?.content?.[0]?.text??"{}"); if(input.phase==="author-boundary")response={text:JSON.stringify({fragments:[BODY]})}; } catch {}
			}
			if(response){try{const parsed=JSON.parse(response.text??"{}");if(parsed.body!==undefined)response=undefined;}catch{}}
			if (model.id === "writer" && payload) {
				const output = JSON.parse(presentationResponse(payload, options.inline));
				if (presentationFail) output.missing = ["合成未交付格式"];
				response = { text: JSON.stringify(output) };
			} else if (!response && model.id === "writer") response = script.shift();
			else if (!response && model.id === "literaryDirector") response = { text: JSON.stringify({ scenePressure: "既有事务", candidateBeats: ["核对观测记录"] }) };
			else if (!response && model.id === "scribe") response = { text: JSON.stringify({ patch: { location: "观测站" } }) };
			else if (!response && steps.includes(model.id)) response = { text: JSON.stringify({ summary: "合成材料核对完毕", facts: [], inferences: [], candidates: [], issues: [] }) };
			if (!response) throw new Error(`Unexpected faux request: ${model.id}`);
			const reply = response;
			const message: AssistantMsgLike = {
				role: "assistant",
				content: reply.calls ? reply.calls.map((call, i) => ({ type: "toolCall", id: `call-${requests.length}-${i}`, name: call.name, arguments: call.args ?? {} })) : [{ type: "text", text: reply.text ?? "" }],
				stopReason: reply.calls ? "toolUse" : "stop", usage: { input: 10, output: 10 },
			};
			return {
				async *[Symbol.asyncIterator]() {
					if (reply.text) {
						const midpoint = Math.ceil(reply.text.length / 2);
						yield { type: "text_delta", delta: reply.text.slice(0, midpoint) };
						yield { type: "text_delta", delta: reply.text.slice(midpoint) };
					}
					yield { type: "done", message };
				},
				async result() { return message; },
			};
		};
		const model = { id: "writer", provider: "faux", maxTokens: 10000 };
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model,
			findModel: (provider, id) => ({ ...model, provider, id }), getAuth: async () => ({}), streamFn });
		return { cwd, sm, requests, engine, setPresentationFail: (value: boolean) => { presentationFail = value; },
			cleanup: () => { engine.abort(); cleanup(); } };
	} catch (error) { cleanup(); throw error; }
}

const missingFormats = (text: string, formats: Record<string, string>) => Object.entries(formats).filter(([, format]) => !text.includes(format)).map(([name]) => name);
const replyFrom = (sm: SessionManager) => (sm.getBranch() as any[]).find(entry => entry.type === "message" && entry.message.role === "assistant");
const latestSettlement = (sm: SessionManager, id: string) => (sm.getBranch() as any[]).filter(entry => entry.customType === "rp-turn-settlement" && entry.data.narrativeEntryId === id).at(-1)?.data;

// Replay contract: the latest successful per-entry presentation artifact supplies
// the displayed body and formats. rpNarrative is still the frozen fact authority;
// neither the old curtain override nor the original message replaces this artifact.
function deliveredText(sm: SessionManager): string {
	const reply = replyFrom(sm);
	assert.ok(reply, "a successful turn must save an assistant reply");
	assert.notEqual(reply.message.stopReason, "aborted", "the fixture must finish the main workflow");
	const settlement = latestSettlement(sm, reply.id);
	assert.equal(settlement?.status, "complete", "ordinary settlement must include presentation");
	assert.equal(settlement.presentationDone, true);
	const artifact = (sm.getBranch() as any[]).filter(entry => entry.customType === "rp-presentation-delivery" && entry.data.targetEntryId === reply.id).at(-1)?.data;
	assert.ok(artifact, "delivery must be persisted for replay, not merely streamed");
	assert.equal(artifact.version, 1);
	const output = [artifact.body, artifact.formats].filter(Boolean).join("\n\n");
	for (const requirement of artifact.requirements) assert.ok(output.includes(requirement.quote), "requirements must cite actual delivery");
	assert.ok(artifact.requirements.some((requirement: any) => requirement.kind === "actions"));
	return output;
}

function formatMaterials(cwd: string) {
	const materials = loadStageMaterials(cwd);
	return buildAgentPresentationMaterials({ card: materials.card, entries: materials.entries, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
}

// Keep the original eight regression intents, using the new adaptive contract.
test("extractPureTextNarrative：剥正文外层容器但保留正文内部的 image 插图", () => {
	const body = [PARAGRAPHS[0], IMAGE, PARAGRAPHS[1]].join("\n\n");
	assert.equal(extractPureTextNarrative(`<main_output><content>${body}</content></main_output>`), body);
});

test("自定义 scene_sidecar 与 HTML/Markdown 定义不依赖固定标签才能进入格式材料", () => {
	const f = fixture("direct", BODY, { customOnly: true });
	try {
		const materials = formatMaterials(f.cwd);
		for (const original of [CARD_BOOK_FORMAT, WORLD_FORMAT]) assert.ok(materials.sources.some(source => source.content === original), "selected sources must contain the full original definition");
		assert.equal(materials.card.systemPrompt, CARD_SYSTEM);
		assert.equal(materials.card.postHistoryInstructions, CARD_POST);
	} finally { f.cleanup(); }
});

test("格式收口保留自定义块、HTML、Markdown与行动选项，并校验冻结正文和真实引用", () => {
	const payload = { frozen_narrative: BODY, author_draft: BODY } as PresentationPayload;
	const json = presentationResponse(payload);
	const parsed = parseAgentPresentation(json, BODY);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.delivery.body, [PARAGRAPHS[0], IMAGE, PARAGRAPHS[1]].join("\n\n"));
	assert.deepEqual(missingFormats(parsed.delivery.formats, LEGAL_FORMATS), []);
	const row = JSON.parse(json);
	for (const invalid of [
		{ ...row, body: row.body.replace("书架", "桌边") },
		{ ...row, body: `${BODY}\n\n${IMAGE}` },
		{ ...row, requirements: [{ name: "虚假选项", kind: "actions", quote: "本次未输出的行动" }] },
		{ ...row, missing: ["scene_sidecar"] },
	]) assert.equal(parseAgentPresentation(JSON.stringify(invalid), BODY).ok, false);
});

for (const mode of ["direct", "director"] as const) {
	test(`${mode}：主作者收到原始卡与内嵌/挂载世界书格式要求`, { timeout: 15000 }, async () => {
		const f = fixture(mode);
		try {
			await f.engine.performTurn("继续核对记录。", { generationMode: mode });
			deliveredText(f.sm);
			const writer = f.requests.find(request => request.model === "writer" && !request.presentation);
			assert.ok(writer);
			const originalText = [writer.context.systemPrompt, ...writer.context.messages.map((message: any) => message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"))].join("\n");
			assert.deepEqual(missingFormats(originalText, { card_system: CARD_SYSTEM, card_post_history: CARD_POST, card_book: CARD_BOOK_FORMAT, mounted_worldbook: WORLD_FORMAT, options_rule: OPTIONS_FORMAT }), []);
			const payload = f.requests.find(request => request.presentation)?.presentation;
			assert.ok(payload);
			assert.equal(payload.frozen_narrative, replyFrom(f.sm).message.details.rpNarrative);
			assert.equal(payload.author_draft, BODY);
			assert.deepEqual(missingFormats(payload.materials.sources.map(source => source.content).join("\n"), { card_book: CARD_BOOK_FORMAT, mounted_worldbook: WORLD_FORMAT, options_rule: OPTIONS_FORMAT }), []);
		} finally { f.cleanup(); }
	});

	test(`${mode}：正常交付保留全部合法卡格式，而非只剩固定标签`, { timeout: 15000 }, async () => {
		const output = [BODY, ...Object.values(LEGAL_FORMATS)].join("\n\n");
		const f = fixture(mode, output);
		try {
			await f.engine.performTurn("继续核对记录。", { generationMode: mode });
			const delivered = deliveredText(f.sm);
			assert.deepEqual(missingFormats(delivered, LEGAL_FORMATS), []);
			assert.ok(delivered.indexOf(PARAGRAPHS[0]) < delivered.indexOf(IMAGE));
			assert.ok(delivered.indexOf(IMAGE) < delivered.indexOf(PARAGRAPHS[1]), "complete image must be between unchanged prose paragraphs");
			assert.equal(f.requests.find(request => request.presentation)?.presentation?.author_draft, output, "formatting receives the unstripped author draft");
		} finally { f.cleanup(); }
	});
}

test("direct：正文内嵌 image 与行动选项不移走、不遗漏，保持前后叙事顺序", { timeout: 15000 }, async () => {
	const fragments = [PARAGRAPHS[0], IMAGE, PARAGRAPHS[1], OPTIONS, "他将本拍记录收好。"];
	const f = fixture("direct", fragments.join("\n\n"), { inline: true });
	try {
		await f.engine.performTurn("继续核对记录。", { generationMode: "direct" });
		const payload = f.requests.find(request => request.presentation)?.presentation;
		assert.equal(payload?.author_draft, fragments.join("\n\n"), "the presentation request must retain the inline author draft");
		const delivered = deliveredText(f.sm);
		const actualOrder = fragments.filter(fragment => delivered.includes(fragment)).sort((a, b) => delivered.indexOf(a) - delivered.indexOf(b));
		assert.deepEqual(actualOrder, fragments);
		const artifact = (f.sm.getBranch() as any[]).find(entry => entry.customType === "rp-presentation-delivery").data;
		assert.equal(artifact.body, fragments.join("\n\n"), "already-correct inline body must remain byte-for-byte unchanged");
		assert.ok(!artifact.formats.includes(OPTIONS), "inline actions are not duplicated as a tail panel");
	} finally { f.cleanup(); }
});

test("自适应格式材料保留超6000字原文及末端定义，不按旧预算截断", () => {
	const longFormat = `${WORLD_FORMAT}\n${"合成格式示例行。".repeat(900)}\n<scene_sidecar>FORMAT_PARITY_LONG_END</scene_sidecar>`;
	assert.ok(longFormat.length > 6000);
	const f = fixture("direct", BODY, { worldFormat: longFormat });
	try {
		const materials = formatMaterials(f.cwd);
		const source = materials.sources.find(entry => entry.content.includes("FORMAT_PARITY_WORLD"));
		assert.equal(source?.content, longFormat);
		assert.equal(materials.sourceIndex.find(entry => entry.id === source?.id)?.chars, longFormat.length);
	} finally { f.cleanup(); }
});

test("格式交付失败留pending，retry恢复同一正文且不重复scribe", { timeout: 15000 }, async () => {
	const f = fixture("direct");
	try {
		f.setPresentationFail(true);
		await f.engine.performTurn("继续核对记录。", { generationMode: "direct" });
		const reply = replyFrom(f.sm);
		assert.ok(reply);
		const frozenReply = JSON.stringify(reply.message);
		const pending = latestSettlement(f.sm, reply.id);
		assert.equal(pending.status, "pending");
		assert.equal(pending.ledgerDone, true);
		assert.equal(pending.presentationDone, false);
		assert.ok(pending.degradedDomains.includes("presentation"));
		assert.ok(!f.sm.getBranch().some((entry: any) => entry.customType === "rp-presentation-delivery"));
		const failed = f.requests.filter(request => request.presentation);
		assert.ok(failed.length > 0 && failed.length <= 6, "presentation failure has a bounded retry budget");
		assert.ok(failed.some(request => request.presentation?.validation_errors?.length));
		const scribeCalls = f.requests.filter(request => request.model === "scribe").length;
		assert.equal(scribeCalls, 1);
		f.setPresentationFail(false);
		const result = await f.engine.retryPendingSettlement();
		assert.equal(result.error, undefined);
		assert.deepEqual(missingFormats(deliveredText(f.sm), LEGAL_FORMATS), []);
		assert.equal(latestSettlement(f.sm, reply.id).recovered, true);
		assert.equal(JSON.stringify(replyFrom(f.sm).message), frozenReply, "retry does not rewrite the saved author reply");
		assert.equal(f.requests.filter(request => request.model === "scribe").length, scribeCalls);
		const afterRecovery = f.requests.length;
		assert.equal((await f.engine.retryPendingSettlement()).error, undefined);
		assert.equal(f.requests.length, afterRecovery, "a completed receipt does not request models again");
	} finally { f.cleanup(); }
});
