import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@liyuan/agent-runtime";
import { StageEngine, type AssistantMsgLike, type StageStreamFn } from "../src/stage/engine.ts";
import { stateFromBranch } from "../src/stage/assemble.ts";
import { TURN_PERFORMANCE_ENTRY_TYPE, type TurnPerformance } from "../src/stage/performance.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

const setup = (config: Record<string, unknown> = {}) => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-consistency-"));
	writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "师姐", first_mes: "你来了。" } }));
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", compactEveryNTurns: 0, ...config }));
	mkdirSync(join(cwd, ".liyuan"));
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	return { cwd, sm, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
};
const model = { provider: "fixture", id: "old-model", compat: { supportsTools: false } };
const message = (text: string, extra: Record<string, unknown> = {}): AssistantMsgLike => ({
	role: "assistant", provider: "fixture", model: "old-model", content: [{ type: "text", text }], stopReason: "stop",
	usage: { input: 10, output: 5 }, ...extra,
});
const tool = (name: string, args: Record<string, unknown>): AssistantMsgLike => message("", { content: [{ type: "toolCall", id: name, name, arguments: args }], stopReason: "toolUse" });
const stream = (final: AssistantMsgLike, before?: () => void): ReturnType<StageStreamFn> => ({
	async *[Symbol.asyncIterator]() { before?.(); yield { type: final.stopReason === "error" ? "error" : "done", ...(final.stopReason === "error" ? { error: final } : { message: final }) }; },
	result: async () => final,
});
const metrics = (sm: InstanceType<typeof SessionManager>): TurnPerformance => (sm.getBranch().find(entry => entry.type === "custom" && entry.customType === TURN_PERFORMANCE_ENTRY_TYPE) as { data: TurnPerformance } | undefined)?.data!;

test("submission ACK follows user flush and retains client id, legacy API unchanged", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		let accepted = false, calls = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => {
			assert.equal(accepted, true, "writer starts only after accepted callback");
			return stream(message(calls++ === 0 ? "正文。" : '{"patch":{}}'));
		} });
		await engine.performTurn("用户输入。", { clientMessageId: "client-1", expectedSessionId: sm.getSessionId(), onAccepted: id => {
			const user = sm.getEntries().find(entry => entry.id === id) as { message: { details: { rpClientMessageId: string } } };
			assert.equal(user.message.details.rpClientMessageId, "client-1");
			assert.ok(readFileSync(sm.getSessionFile()!, "utf8").includes('"rpClientMessageId":"client-1"'));
			accepted = true;
		} });
		assert.equal(accepted, true);
		await assert.rejects(engine.performTurn("不应落到此会话。", { expectedSessionId: "another-session" }), /会话/);
		assert.equal(sm.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").length, 1);
	} finally { cleanup(); }
});

test("latest metadata is retained after assistant without losing user sibling semantics", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		sm.appendModelChange("fixture", "old-model"); sm.appendThinkingLevelChange("low");
		let calls = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => stream(message(calls++ === 0 ? "正文。" : '{"patch":{}}'), () => {
			if (calls === 1) {
				sm.appendModelChange("fixture", "obsolete-model"); sm.appendThinkingLevelChange("medium");
				sm.appendModelChange("fixture", "new-model"); sm.appendThinkingLevelChange("high");
			}
		}) });
		await engine.performTurn("继续。");
		const branch = sm.getBranch();
		const user = branch.find(entry => entry.type === "message" && entry.message.role === "user")!;
		const assistant = branch.find(entry => entry.type === "message" && entry.message.role === "assistant")!;
		assert.equal(assistant.parentId, user.id);
		assert.deepEqual(sm.buildSessionContext().model, { provider: "fixture", modelId: "new-model" });
		assert.equal(sm.buildSessionContext().thinkingLevel, "high");
		assert.equal(JSON.stringify(branch).includes("obsolete-model"), false);
		const reopened = SessionManager.open(sm.getSessionFile()!, join(cwd, "sessions"));
		assert.deepEqual(reopened.buildSessionContext().model, { provider: "fixture", modelId: "new-model" });
		assert.equal(reopened.buildSessionContext().thinkingLevel, "high");
	} finally { cleanup(); }
});

test("scribe tolerates metadata but real branch changes never receive stale ledger or metrics", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		let calls = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => {
			calls++;
			return stream(message(calls === 1 ? "她走到门前。" : '{"patch":{"location":"门前"}}'), () => { if (calls === 2) sm.appendThinkingLevelChange("high"); });
		} });
		await engine.performTurn("继续。");
		assert.equal(stateFromBranch(sm.getBranch() as BranchEntryLike[]).location, "门前");
		assert.equal(sm.buildSessionContext().thinkingLevel, "high");
		const anchor = sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!.id;
		calls = 0;
		const stale = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => {
			calls++;
			return stream(message(calls === 1 ? "另一拍正文。" : '{"patch":{"location":"不得泄漏"}}'), () => { if (calls === 2) sm.branch(anchor); });
		} });
		await stale.performTurn("另一个输入。");
		assert.equal(sm.getLeafId(), anchor, "stale scribe must not append diagnostics/world/performance to navigated branch");
		assert.equal(JSON.stringify(sm.getBranch()).includes("不得泄漏"), false);
	} finally { cleanup(); }
});

test("queued submission keeps binding and cannot append to a replaced session", async () => {
	const first = setup(), second = setup();
	try {
		let current = first.sm, release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const final = message("正文。");
		const engine = new StageEngine({ cwd: first.cwd, getSessionManager: () => current as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => ({
			async *[Symbol.asyncIterator]() { await gate; yield { type: "done", message: final }; }, result: async () => final,
		}) });
		const running = engine.performTurn("第一句。");
		const queued = engine.performTurn("队列句。", { expectedSessionId: first.sm.getSessionId(), clientMessageId: "queued" });
		const rejected = assert.rejects(queued, /会话/);
		current = second.sm; release();
		await running; await rejected;
		assert.equal(second.sm.getEntries().some(entry => entry.type === "message"), false);
	} finally { first.cleanup(); second.cleanup(); }
});

test("confirmed writer context overflow never blindly resends identical payload", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		let calls = 0; const notices: string[] = [];
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => ({ ...model, compat: { supportsTools: true } }), getAuth: async () => ({}), streamFn: () => { calls++; return stream(message("", { stopReason: "error", errorMessage: "400 context_length_exceeded: maximum context length is 1024 tokens" })); }, events: { onNotify: (_level, notice) => notices.push(notice) } });
		await engine.performTurn("输入。");
		assert.equal(calls, 1);
		assert.equal(notices.filter(notice => notice.includes("安全压缩")).length, 1);
	} finally { cleanup(); }
});

test("soft capacity warning does not alter payload and checks later writer calls", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		const raw = "特殊正文 < arbitrary### {[]}".repeat(400);
		const responses = [tool("draft_write", { content: "正文。" }), tool("draft_seal", {}), message(""), message('{"patch":{}}')];
		let calls = 0; const payloads: string[] = [], notices: string[] = [];
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => ({ ...model, contextWindow: 100, compat: { supportsTools: true } }), getAuth: async () => ({}), streamFn: (_model, context) => { payloads.push(JSON.stringify(context)); return stream(responses[calls++]!); }, events: { onNotify: (_level, notice) => notices.push(notice) } });
		await engine.performTurn(raw);
		assert.ok(payloads[0]!.includes(raw));
		assert.ok(payloads[1]!.includes(raw));
		assert.equal(notices.filter(notice => notice.includes("容量预检")).length, 1);
		const assistant = sm.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant") as { message: { details: { rpContextPreflight: { checks: number } } } };
		assert.ok(assistant.message.details.rpContextPreflight.checks >= 3);
	} finally { cleanup(); }
});

test("performance excludes planning text, includes scribe settlement and reports known usage", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		const responses = [tool("draft_write", { content: "真正正文。" }), tool("draft_seal", {}), message(""), message('{"patch":{}}')];
		let calls = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => ({ ...model, compat: { supportsTools: true } }), getAuth: async () => ({}), streamFn: () => {
			const call = ++calls, final = responses[call - 1]!;
			return { async *[Symbol.asyncIterator]() {
				if (call === 1) { yield { type: "text_delta", delta: "计划旁白。" }; await new Promise(resolve => setTimeout(resolve, 35)); yield { type: "toolcall_end", contentIndex: 0, toolCall: final.content[0] }; }
				if (call === 4) await new Promise(resolve => setTimeout(resolve, 30));
				yield { type: "done", message: final };
			}, result: async () => final };
		} });
		await engine.performTurn("继续。");
		const data = metrics(sm);
		assert.ok(data.timeToFirstNarrativeMs! >= 30, "planning delta is not first narrative");
		assert.ok(data.totalMs >= data.timeToFirstNarrativeMs! + 25);
		assert.equal(data.phases.writer?.calls, 3);
		assert.equal(data.phases["settlement.scribe"]?.calls, 1);
		assert.equal(data.phases.writer?.inputTokens, 30);
		assert.equal(data.phases.writer?.outputTokens, 15);
		assert.equal(data.providerRetries, "unknown");
		assert.equal(JSON.stringify(data).includes("计划旁白"), false);
	} finally { cleanup(); }
});

test("empty failed generation does not rewind away newly accepted settings", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => stream(message("", { stopReason: "error", errorMessage: "context_length_exceeded" }), () => { sm.appendModelChange("fixture", "new-model"); sm.appendThinkingLevelChange("high"); }) });
		await engine.performTurn("继续。");
		assert.deepEqual(sm.buildSessionContext().model, { provider: "fixture", modelId: "new-model" });
		assert.equal(sm.buildSessionContext().thinkingLevel, "high");
	} finally { cleanup(); }
});

test("subsequent context overflow preserves accepted draft as aborted, without ledger commit", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		let calls = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => ({ ...model, compat: { supportsTools: true } }), getAuth: async () => ({}), streamFn: () => stream(++calls === 1 ? tool("draft_write", { content: "保留正文。" }) : message("", { stopReason: "error", errorMessage: "context_length_exceeded" })) });
		await engine.performTurn("继续。");
		assert.equal(calls, 2);
		const assistant = sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant") as { message: { stopReason: string; details: { rpNarrative: string; rpContextPreflight: { confirmedOverflow: boolean } } } };
		assert.equal(assistant.message.stopReason, "aborted");
		assert.equal(assistant.message.details.rpNarrative, "保留正文。");
		assert.equal(assistant.message.details.rpContextPreflight.confirmedOverflow, true);
		assert.equal(sm.getBranch().some(entry => entry.type === "custom" && entry.customType === "rp-state"), false);
	} finally { cleanup(); }
});

test("submission callback is absent on flush failure and callback exceptions do not undo accepted input", async () => {
	const first = setup();
	try {
		let accepted = false, calls = 0;
		const original = first.sm.flush.bind(first.sm);
		first.sm.flush = () => { throw new Error("fixture flush failed"); };
		const failed = new StageEngine({ cwd: first.cwd, getSessionManager: () => first.sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => { calls++; return stream(message("正文。")); } });
		await failed.performTurn("未刷盘。", { onAccepted: () => { accepted = true; } });
		assert.equal(accepted, false); assert.equal(calls, 0);
		first.sm.flush = original;
		const responses = [message("正文。"), message('{"patch":{}}')];
		const healthy = new StageEngine({ cwd: first.cwd, getSessionManager: () => first.sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => stream(responses[calls++]!) });
		await healthy.performTurn("已接受。", { onAccepted: () => { throw new Error("fixture ACK delivery failed"); } });
		assert.ok(first.sm.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"));
	} finally { first.cleanup(); }
});

test("metrics total includes independent curtain after ledger settlement", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "师姐", first_mes: "你来了。", extensions: { regex_scripts: [{ scriptName: "状态栏", findRegex: "/<comprehensive_now_status>[\\s\\S]*?<\\/comprehensive_now_status>/g", replaceString: "<div>display only</div>" }] } } }));
		let calls = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => {
			const call = ++calls, final = message(call === 1 ? "正文。" : call === 2 ? '{"patch":{}}' : "<comprehensive_now_status>已结算</comprehensive_now_status>");
			return { async *[Symbol.asyncIterator]() { if (call === 3) await new Promise(resolve => setTimeout(resolve, 30)); yield { type: "done", message: final }; }, result: async () => final };
		} });
		await engine.performTurn("继续。");
		const data = metrics(sm);
		assert.equal(calls, 3);
		assert.equal(data.phases.curtain?.calls, 1);
		assert.ok(data.phases.curtain!.durationMs >= 25);
		const assistant = sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant") as { message: { details: { rpWorkflow: { durationMs: number } } } };
		assert.ok(data.totalMs >= assistant.message.details.rpWorkflow.durationMs + 25);
	} finally { cleanup(); }
});

test("background Sogon/Sigon finishing during next turn never enter that turn's collector", async () => {
	const { cwd, sm, cleanup } = setup({ literaryQuality: "profile" });
	let release!: () => void, completed!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; }), completion = new Promise<void>(resolve => { completed = resolve; });
	try {
		let mainCalls = 0, finished = 0;
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: (_model, context) => {
			const background = /工作流 skill：(Sogon|Sigon)/.test(context.systemPrompt ?? "");
			if (background) {
				const final = message("后台画像。", { usage: { input: 999, output: 999 } });
				return { async *[Symbol.asyncIterator]() { await gate; yield { type: "done", message: final }; if (++finished === 2) completed(); }, result: async () => final };
			}
			if (++mainCalls === 3) release();
			return stream(message(mainCalls % 2 ? "正文。" : '{"patch":{}}'));
		} });
		await engine.performTurn("第一拍。");
		await engine.performTurn("第二拍。");
		await completion; await new Promise<void>(resolve => setImmediate(resolve));
		const records = sm.getBranch().filter(entry => entry.type === "custom" && entry.customType === TURN_PERFORMANCE_ENTRY_TYPE) as Array<{ data: TurnPerformance }>;
		assert.equal(records.length, 2);
		for (const { data } of records) {
			assert.equal(data.phases.writer?.calls, 1);
			assert.equal(data.phases["settlement.scribe"]?.calls, 1);
			assert.equal(Object.values(data.phases).reduce((sum, phase) => sum + (phase?.inputTokens ?? 0), 0), 20);
		}
	} finally { release(); cleanup(); }
});

test("model/thinking from a abandoned writer branch is never replayed", async () => {
	const { cwd, sm, cleanup } = setup();
	try {
		sm.appendModelChange("fixture", "old-model"); const anchor = sm.appendThinkingLevelChange("low");
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, getAuth: async () => ({}), streamFn: () => stream(message("不应落到回退分支的正文。"), () => {
			sm.appendModelChange("fixture", "stale-model"); sm.appendThinkingLevelChange("high"); sm.branch(anchor);
		}) });
		await engine.performTurn("继续。");
		assert.equal(sm.getLeafId(), anchor);
		assert.equal(sm.buildSessionContext().thinkingLevel, "low");
		assert.equal(JSON.stringify(sm.getBranch()).includes("stale-model"), false);
		assert.equal(sm.getBranch().some(entry => entry.type === "custom" && entry.customType === TURN_PERFORMANCE_ENTRY_TYPE), false);
	} finally { cleanup(); }
});
