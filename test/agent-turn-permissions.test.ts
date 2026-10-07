import assert from "node:assert/strict";
import test from "node:test";
import { toWireMsg } from "../server/wire.ts";
import { runAgentTurn, type AgentTurnOptions } from "../src/stage/agent-turn.ts";
import { DIRECTOR_ROLES, type DirectorPhase, type DirectorReport } from "../src/stage/agent-director.ts";
import type { StageStreamEvent } from "../src/stage/engine.ts";
import type { StageTool } from "../src/stage/tools.ts";

interface MockResponse {
	text?: string;
	calls?: Array<{ name: string; args?: Record<string, unknown> }>;
	stopReason?: string;
	omitDone?: boolean;
	error?: string;
	stream?: AsyncIterable<StageStreamEvent>;
}

const emptySuccess = (phase: DirectorPhase, tasks: Array<{ role: string }>): DirectorReport[] => tasks.map(task => ({
	role: task.role as DirectorReport["role"], status: "success", summary: `${phase} ok`, facts: [], inferences: [], candidates: [], issues: [],
}));
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });
const experts = (phase: DirectorPhase) => call("consult_experts", {
	tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: `任务 ${role}` })),
});

function fixture(responses: MockResponse[], options: Partial<AgentTurnOptions> = {}) {
	const contexts: Array<{ systemPrompt: string; messages: unknown[]; tools?: StageTool[] }> = [];
	const expertCalls: Array<{ phase: DirectorPhase; tasks: unknown[]; draft?: string }> = [];
	const reads: Array<{ name: string; args: Record<string, unknown> }> = [];
	const deltas: Array<{ text: string; afterAbort: boolean }> = [];
	const base: AgentTurnOptions = {
		mode: "director",
		systemPrompt: "PRESET",
		messages: [],
		readTools: [],
		directorPrompt: "DIRECTOR SKILL",
		stream: ((context) => {
			contexts.push(context);
			const response = responses.shift();
			if (!response) throw new Error("unexpected mock stream request");
			if (response.stream) return response.stream as never;
			const message = {
				role: "assistant",
				content: response.calls
					? response.calls.map((item, index) => ({ type: "toolCall", id: `mock-${index}`, name: item.name, arguments: item.args ?? {} }))
					: [{ type: "text", text: response.text ?? "" }],
				stopReason: response.stopReason ?? (response.calls ? "toolUse" : "stop"),
			};
			return {
				async *[Symbol.asyncIterator]() {
					if (response.text) yield { type: "text_delta", delta: response.text };
					if (response.error) yield { type: "error", error: { ...message, errorMessage: response.error, stopReason: "error" } };
					else if (!response.omitDone) yield { type: "done", message };
				},
				async result() { return message; },
			} as never;
		}) as AgentTurnOptions["stream"],
		read: async (name, args) => { reads.push({ name, args }); return { text: `read:${name}` }; },
		experts: async (phase, tasks, draft) => {
			expertCalls.push({ phase, tasks, ...(draft !== undefined ? { draft } : {}) });
			return emptySuccess(phase, tasks);
		},
		signal: undefined,
		isCurrent: () => true,
		onDelta: (text) => { deltas.push({ text, afterAbort: base.signal?.aborted === true }); },
		...options,
	};
	return { options: base, contexts, expertCalls, reads, deltas };
}

function directorDraftFlow(responsesAfterDraft: MockResponse[], options: Partial<AgentTurnOptions> = {}) {
	return fixture([
		{ calls: [experts("evidence")] },
		{ calls: [experts("ideas")] },
		{ calls: [call("begin_narrative")] },
		{ text: "主Agent自己的草稿。" },
		...responsesAfterDraft,
	], options);
}

test("安全回归：同一 assistant tool-call 批不能跨越多个导演阶段", async () => {
	const f = fixture([
		{ calls: [experts("evidence"), experts("ideas"), call("begin_narrative")] },
		{ text: "同一响应越级写出的文本。" },
		{ calls: [experts("review")] },
		{ calls: [call("finalize")] },
	]);
	const result = await runAgentTurn(f.options);
	assert.deepEqual(f.expertCalls.map(item => item.phase), ["evidence"], "一个 assistant 响应最多应受理一个阶段转换");
	assert.equal(result.narrative, "", "同一响应不能在尚未收到前阶段报告时启动并提交正文");
});

test("安全回归：finalize 后同一 tool-call 批的读、写和未知调用全部停止", async () => {
	const readTool: StageTool = { name: "world_state_get", description: "read", parameters: { type: "object" } };
	const f = directorDraftFlow([
		{ calls: [experts("review")] },
		{ calls: [call("finalize"), call("world_state_get"), call("draft_edit", { edits: [] }), call("unknown_mutator")] },
	], { readTools: [readTool] });
	const result = await runAgentTurn(f.options);
	assert.equal(result.aborted, false);
	assert.deepEqual(f.reads, [], "finalize 是本轮最后一个可执行动作");
});

test("安全回归：失败的固定审阅不能被普通 finalize receipt 当作成功", async () => {
	const run = async (toolsSupported: boolean) => {
		const f = toolsSupported
			? directorDraftFlow([
				{ calls: [experts("review")] },
				{ calls: [call("finalize")] },
			], {
				experts: async (phase, tasks) => phase === "review"
					? tasks.map(task => ({ ...emptySuccess(phase, [task])[0]!, status: "failed" }))
					: emptySuccess(phase, tasks),
			})
			: fixture([
				{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "沿当前话题观察人物的不同反应" }, { role: "idea-b", task: "沿场景中的生活事务组织本拍" }] }) },
		{ text: "无工具回退草稿。" },
				{ text: '{"decision":"keep"}' },
			], {
				toolsSupported: false,
				experts: async (phase, tasks) => phase === "review"
					? tasks.map(task => ({ ...emptySuccess(phase, [task])[0]!, status: "failed" }))
					: emptySuccess(phase, tasks),
			});
		const result = await runAgentTurn(f.options);
		assert.ok(result.workflow.stages.some(stage => stage.stage === "review" && stage.status === "degraded"));
		assert.ok(!result.workflow.stages.some(stage => stage.stage === "finalize" && stage.status === "success"), "failed review must not silently settle as finalized");
	};
	await run(true);
	await run(false);
});

test("安全回归：无工具 fallback 的失败审阅不能自动保留并定稿", async () => {
	const f = fixture([
		{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "沿当前话题观察人物的不同反应" }, { role: "idea-b", task: "沿场景中的生活事务组织本拍" }] }) },
		{ text: "审阅失败后的稿件。" },
		{ text: '{"decision":"keep"}' },
	], {
		toolsSupported: false,
		experts: async (phase, tasks) => phase === "review"
			? tasks.map(task => ({ ...emptySuccess(phase, [task])[0]!, status: "failed" }))
			: emptySuccess(phase, tasks),
	});
	const result = await runAgentTurn(f.options);
	assert.ok(result.workflow.stages.some(stage => stage.stage === "review" && stage.status === "degraded"));
	assert.equal(result.workflow.stages.some(stage => stage.stage === "finalize" && stage.status === "success"), false);
});

test("安全回归：工具文本协议不能被接受为导演正文", async () => {
	const f = fixture([
		{ calls: [experts("evidence")] },
		{ calls: [experts("ideas")] },
		{ calls: [call("begin_narrative")] },
		{ text: '<tool_call>draft_write({"content":"伪造正文"})</tool_call>' },
	]);
	const result = await runAgentTurn(f.options);
	assert.equal(result.narrative, "", "文本化工具协议不是正文，也不应进入固定审阅/定稿");
	assert.equal(f.expertCalls.some(item => item.phase === "review"), false);
});

test("取消审计：abort 后不得补发 done 消息中的迟到文本 delta", async () => {
	const controller = new AbortController();
	let release!: () => void;
	let notifyDone!: () => void;
	const waiting = new Promise<void>(resolve => { release = resolve; });
	const doneSeen = new Promise<void>(resolve => { notifyDone = resolve; });
	const lateAwareStream: AsyncIterable<StageStreamEvent> = {
		async *[Symbol.asyncIterator]() {
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "done 文本" }], stopReason: "stop" } };
			notifyDone();
			await waiting;
			yield { type: "text_delta", delta: "迟到 delta" };
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "迟到 final" }], stopReason: "stop" } };
		},
	};
	const f = fixture([{ stream: lateAwareStream }], { mode: "direct", signal: controller.signal });
	const run = runAgentTurn(f.options);
	await doneSeen;
	controller.abort();
	release();
	const result = await run;
	assert.equal(result.aborted, true);
	assert.equal(f.deltas.some(delta => delta.afterAbort), false, "取消后 UI delta 不能由 done-message 回填");
	assert.doesNotMatch(result.narrative, /迟到 final/);
});

test("取消审计：迭代器在 abort 后才 yield 的 final 不得覆盖当前半稿", async () => {
	const controller = new AbortController();
	let release!: () => void;
	let notifyPartial!: () => void;
	const waiting = new Promise<void>(resolve => { release = resolve; });
	const partialSeen = new Promise<void>(resolve => { notifyPartial = resolve; });
	const lateFinalStream: AsyncIterable<StageStreamEvent> = {
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: "当前半稿" };
			notifyPartial();
			await waiting;
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "迟到的完整终稿" }], stopReason: "stop" } };
		},
	};
	const f = fixture([{ stream: lateFinalStream }], { mode: "direct", signal: controller.signal });
	const run = runAgentTurn(f.options);
	await partialSeen;
	controller.abort();
	release();
	const result = await run;
	assert.equal(result.aborted, true);
	assert.equal(result.narrative, "当前半稿");
	assert.doesNotMatch(JSON.stringify(result.final), /迟到的完整终稿/);
});

test("流未收到 done 时只能保留未定稿半稿，不能算成功定稿", async () => {
	const noDone: AsyncIterable<StageStreamEvent> = {
		async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "未完成半稿" }; },
	};
	const f = fixture([{ stream: noDone }], { mode: "direct" });
	const result = await runAgentTurn(f.options);
	assert.equal(result.narrative, "未完成半稿");
	assert.equal(result.aborted, true);
	assert.equal(result.workflow.stages.some(stage => stage.stage === "finalize" && stage.status === "success"), false);
});

test("无工具 fallback 的决策改稿失败时必须保全当前 draft", async () => {
	const f = fixture([
		{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "沿当前话题观察人物的不同反应" }, { role: "idea-b", task: "沿场景中的生活事务组织本拍" }] }) },
		{ text: "必须保留的 fallback 草稿。" },
		{ text: '{"decision":"revise","edits":[{"old":"不存在的片段","new":"替换"}]}' },
	], { mode: "director", toolsSupported: false });
	const result = await runAgentTurn(f.options);
	assert.equal(result.aborted, true);
	assert.ok(!result.workflow.stages.some(stage => stage.stage === "finalize"));
	assert.equal(result.narrative, "必须保留的 fallback 草稿。");
	assert.deepEqual(f.deltas.map(delta => delta.text), ["必须保留的 fallback 草稿。"]);
});

test("安全回归：无工具 fallback 的无效决策协议不能隐式等同 keep", async () => {
	const f = fixture([
		{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "沿当前话题观察人物的不同反应" }, { role: "idea-b", task: "沿场景中的生活事务组织本拍" }] }) },
		{ text: "应保留但未获有效定稿决策的草稿。" },
		{ text: "not a decision protocol" },
	], { mode: "director", toolsSupported: false });
	const result = await runAgentTurn(f.options);
	assert.equal(result.narrative, "应保留但未获有效定稿决策的草稿。");
	assert.equal(result.aborted, true, "无效定稿协议应保留半稿但不能确认定稿");
	assert.equal(result.workflow.stages.some(stage => stage.stage === "finalize" && stage.status === "success"), false);
});

test("安全回归：专家和未知写工具不能到达写侧执行器", async () => {
	const readTool: StageTool = { name: "world_state_get", description: "read", parameters: { type: "object" } };
	const f = fixture([
		{ calls: [call("draft_edit", { edits: [{ old: "草稿", new: "篡改" }] }), call("world_state_update", { patch: { time: "未来" } }), call("unknown_write", { value: "x" })] },
		{ calls: [experts("evidence")] },
		{ calls: [experts("ideas")] },
		{ calls: [call("begin_narrative")] },
		{ text: "只有正文通道产出的草稿。" },
		{ calls: [experts("review")] },
		{ calls: [call("finalize")] },
	], { readTools: [readTool] });
	const result = await runAgentTurn(f.options);
	assert.equal(result.narrative, "只有正文通道产出的草稿。");
	assert.deepEqual(f.reads, [], "未知/写工具不能经 read callback 逃逸为 mutation");
});

test("Wire 投影丢弃 source 和未知 workflow 字段", () => {
	const wire = toWireMsg({
		role: "assistant",
		content: [{ type: "text", text: "正文" }],
		details: {
			rpGenerationMode: "director",
			rpGenerationWorkflow: {
				version: 1, mode: "director", writerRounds: 5, toolFallback: false,
				stages: [{ stage: "review", status: "success", calls: 2, sourceIds: ["PRIVATE_SOURCE_ID"], sources: ["PRIVATE_SOURCE_TEXT"], unknown: "PRIVATE_UNKNOWN" }],
				sources: ["PRIVATE_SOURCE_TEXT"], sourceIds: ["PRIVATE_SOURCE_ID"], reports: ["PRIVATE_REPORT"], reasoning: "PRIVATE_REASONING",
			},
		},
	}, { charName: "角色", userName: "用户" });
	assert.ok(wire);
	assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_SOURCE_ID|PRIVATE_SOURCE_TEXT|PRIVATE_UNKNOWN|PRIVATE_REPORT|PRIVATE_REASONING|sourceIds|sources|reasoning/);
});

test("安全回归：专家岗位回执缺失不能伪装审阅通过", async () => {
	const f = directorDraftFlow([{ calls: [experts("review")] }, { calls: [call("finalize")] }], { experts: async (phase, tasks) => phase === "review" ? [] : emptySuccess(phase, tasks) });
	const result = await runAgentTurn(f.options);
	assert.equal(result.aborted, true);
	assert.ok(result.workflow.stages.some(stage => stage.stage === "review" && stage.status === "degraded"));
});

test("无原生工具时由main先选两个角度，规划协议不进入正文", async () => {
	const briefs = [{ role: "idea-a", task: "平静事务带出两人的熟悉" }, { role: "idea-b", task: "停留在未说出口的回忆" }];
	const f = fixture([{ text: JSON.stringify({ tasks: briefs }) }, { text: "只有主 Agent的正文。" }, { text: '{"decision":"keep"}' }], { toolsSupported: false });
	const result = await runAgentTurn(f.options);
	assert.equal(result.aborted, false);
	assert.deepEqual(f.expertCalls.find(x => x.phase === "ideas")?.tasks, briefs);
	assert.equal(f.deltas.map(x => x.text).join(""), "只有主 Agent的正文。");
});

test("原生工具改稿被拒后，同批finalize不执行，下一轮读回执再决定", async () => {
	const f = directorDraftFlow([
		{ calls: [experts("review")] },
		{ calls: [call("apply_draft_edits", { edits: [{ old: "不存在", new: "错误修改" }] }), call("finalize")] },
		{ calls: [call("finalize")] },
	]);
	const result = await runAgentTurn(f.options);
	assert.equal(result.aborted, false);
	assert.equal(result.narrative, "主Agent自己的草稿。");
	assert.match(JSON.stringify(f.contexts[6].messages), /本生成轮已受理一次阶段转换/);
	assert.equal(result.workflow.stages.filter(x => x.stage === "finalize").length, 1);
});

test("前缀包装的伪函数协议和toolUse无调用块均不能作为正文保存", async () => {
	for (const response of [
		{ text: '准备：<function_call>{"name":"finalize","arguments":{}}</function_call>' },
		{ text: "伪工具声明", stopReason: "toolUse" },
	]) {
		const f = fixture([response], { mode: "direct", toolsSupported: false });
		const result = await runAgentTurn(f.options);
		assert.equal(result.aborted, true);
		assert.equal(result.narrative, "");
		assert.match(result.error ?? "", /工具协议|工具调用/);
	}
});

test("完整修订跨业务工具调用的主Agent文本连续保留，不混入旧稿或丢前半稿", async () => {
	const readTool: StageTool = { name: "world_state_get", description: "read", parameters: { type: "object" } };
	const f = directorDraftFlow([
		{ calls: [experts("review")] },
		{ calls: [call("begin_revision")] },
		{ text: "修订的前半段。", calls: [call("world_state_get")] },
		{ text: "修订的后半段。" },
		{ calls: [call("finalize")] },
	], { readTools: [readTool] });
	const result = await runAgentTurn(f.options);
	assert.equal(result.aborted, false);
	assert.equal(result.narrative, "修订的前半段。修订的后半段。");
});

test("严格模式：固定岗位恢复仍失败就停，不把失败当作可定稿报告", async()=>{
 const f=fixture([{calls:[experts("evidence")]}],{allowDegraded:false,experts:async(_phase,tasks)=>tasks.map(t=>({role:t.role,status:"failed",summary:"已诊断且恢复失败",facts:[],inferences:[],candidates:[],issues:[]}))});
 const r=await runAgentTurn(f.options);assert.equal(r.aborted,true);assert.equal(r.narrative,"");assert.ok(!r.workflow.stages.some(x=>x.stage==="finalize"));assert.match(r.error??"",/失败岗位/);
});
