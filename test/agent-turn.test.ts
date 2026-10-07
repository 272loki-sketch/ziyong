import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn, type AgentTurnOptions } from "../src/stage/agent-turn.ts";
import { DIRECTOR_ROLES, type DirectorReport, type DirectorPhase } from "../src/stage/agent-director.ts";
import { generationWorkflowView } from "../src/stage/generation-mode.ts";

function stream(responses: any[], contexts: any[]) {
	return (context: any) => {
		contexts.push(context);
		const response = responses.shift();
		if (!response) throw new Error("unexpected model request");
		const message = { role: "assistant", content: response.calls ? response.calls.map((call: any, index: number) => ({ type: "toolCall", id: `call-${index}`, name: call.name, arguments: call.args ?? {} })) : [{ type: "text", text: response.text ?? "" }], stopReason: response.aborted ? "aborted" : response.calls ? "toolUse" : "stop" };
		return { async *[Symbol.asyncIterator]() { if (response.text) yield { type: "text_delta", delta: response.text }; yield { type: "done", message }; }, async result() { return message; } } as never;
	};
}
const consult = (phase: DirectorPhase) => ({ calls: [{ name: "consult_experts", args: { tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "本拍资料分析" })) } }] });
function fixture(responses: any[], mode: "direct" | "director" = "director") {
	const contexts: any[] = [], expertCalls: any[] = [], displayed: string[] = [], revised: string[] = [];
	const options: AgentTurnOptions = { mode, systemPrompt: "预设原文", messages: [], directorPrompt: "流程协议", readTools: [],
		stream: stream(responses, contexts), read: async () => ({ text: "readonly" }), isCurrent: () => true,
		experts: async (phase, tasks, draft) => { expertCalls.push({ phase, tasks, draft }); return tasks.map(task => ({ role: task.role, status: "success", summary: "完成", facts: [], inferences: [], candidates: [], issues: [] })) as DirectorReport[]; },
		onDelta: text => displayed.push(text), onResync: text => revised.push(text) };
	return { options, contexts, expertCalls, displayed, revised };
}

test("单Agent正文直出不经过稿纸工具，不施加转场/长段词语门禁", async () => {
	const text = '“第二天再谈。”她走向教室的窗边。' + "长句自然延伸。".repeat(30);
	const f = fixture([{ text }], "direct");const out = await runAgentTurn(f.options);
	assert.equal(out.narrative, text);assert.equal(out.aborted, false);assert.equal(f.contexts.length, 1);assert.equal(f.expertCalls.length, 0);assert.equal(f.displayed.join(""), text);
	assert.equal(f.contexts[0].tools, undefined);
});

test("导演固定3/2/2专家阶段，只有main普通文本成为正文，不强制修订", async () => {
	const f = fixture([consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "正文原稿。" }, consult("review"), { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.aborted, false);assert.equal(out.narrative, "正文原稿。");
	assert.deepEqual(f.expertCalls.map(x => [x.phase, x.tasks.length]), [["evidence", 3], ["ideas", 2], ["review", 2]]);
	assert.equal(f.expertCalls[2].draft, "正文原稿。");assert.equal(f.displayed.join(""), "正文原稿。");assert.equal(f.contexts[3].tools, undefined);
	assert.equal(out.workflow.stages.filter(x => x.stage === "revision").length, 0);
});

test("未完成固定阶段不能提前finalize或写稿", async () => {
	const f = fixture([{ calls: [{ name: "finalize" }, { name: "begin_narrative" }] }, consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "有效草稿。" }, consult("review"), { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.narrative, "有效草稿。");assert.equal(out.aborted, false);
	assert.match(JSON.stringify(f.contexts[1].messages), /不允许越过固定阶段/);
});

test("只读专家report不能自行改稿，main在审阅之后才可原子改稿", async () => {
	const f = fixture([consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "他把信放在桌上。" }, consult("review"), { calls: [{ name: "apply_draft_edits", args: { edits: [{ old: "桌上", new: "内袋" }] } }] }, { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.narrative, "他把信放在内袋。");assert.deepEqual(f.revised, ["他把信放在内袋。"]);assert.equal(out.aborted, false);
});

test("非法缺角色batch不执行专家，下一轮可恢复完整固定阶段", async () => {
	const f = fixture([{ calls: [{ name: "consult_experts", args: { tasks: [{ role: "continuity", task: "少项" }] } }] }, consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "正文。" }, consult("review"), { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.aborted, false);assert.equal(f.expertCalls.length, 3);assert.match(JSON.stringify(f.contexts[1].messages), /必须恰好包含/);
});

test("无工具API仍执行导演3/2/2，不伪造工具调用或自动改成direct", async () => {
	const f = fixture([{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "沿当前话题观察人物的不同反应" }, { role: "idea-b", task: "沿场景中的生活事务组织本拍" }] }) }, { text: "原始正文。" }, { text: '{"decision":"keep"}' }]);f.options.toolsSupported = false;
	const out = await runAgentTurn(f.options);assert.equal(out.aborted, false);assert.equal(out.workflow.mode, "director");assert.equal(out.workflow.toolFallback, true);assert.equal(out.narrative, "原始正文。");assert.deepEqual(f.expertCalls.map(x => x.tasks.length), [3, 2, 2]);
});

test("取消保留半稿但不虚报定稿，不再执行review或finalize", async () => {
	const f = fixture([{ text: "已写出的半稿", aborted: true }], "direct");const out = await runAgentTurn(f.options);
	assert.equal(out.aborted, true);assert.equal(out.narrative, "已写出的半稿");assert.equal(out.final?.stopReason, "aborted");assert.equal(out.workflow.stages.some(x => x.stage === "finalize"), false);
});

test("Wire模式投影不透传prompt、报告、reasoning等未知字段", () => {
	const out = generationWorkflowView({ version: 1, mode: "director", writerRounds: 8, stages: [{ stage: "review", status: "success", calls: 2, prompt: "SECRET" }], reasoning: "SECRET", reports: ["SECRET"] });
	assert.ok(out);assert.doesNotMatch(JSON.stringify(out), /SECRET|prompt|reasoning|reports/);
});


test("读取工具不响应取消也不会卡住回合，晚到结果不写入上下文", async () => {
	const f = fixture([{ calls: [{ name: "world_state_get" }] }], "direct");
	f.options.readTools = [{ name: "world_state_get", description: "read", parameters: { type: "object" } }];
	f.options.read = async () => await new Promise(() => {}); f.options.timeoutMs = 25;
	const result = await runAgentTurn(f.options);assert.equal(result.aborted, true);assert.equal(result.narrative, "");assert.match(result.error ?? "", /时间预算/);
});

test("供应商标stop但对白未闭合时由同一主作者接续，不截成假定稿", async()=>{
 const f=fixture([{text:'他抬起头说：“听'},{text:'我把话说完。”他收起了书。'}],"direct");const out=await runAgentTurn(f.options);
 assert.equal(out.aborted,false);assert.equal(out.narrative,'他抬起头说：“听我把话说完。”他收起了书。');assert.equal(f.expertCalls.length,0);assert.equal(f.contexts.length,2);
});
test("输出恢复不把等待/看向等正常词当禁词，也不擅自补写正文",async()=>{
 const f=fixture([{text:'她看向窗外，等待雨停。'}],"direct");const out=await runAgentTurn(f.options);assert.equal(out.narrative,'她看向窗外，等待雨停。');assert.equal(f.contexts.length,1);
});

test("输出恢复的下一轮再次包正文标签时不丢掉之前已写的部分",async()=>{
 const f=fixture([{text:'<content>他说：“听'},{text:'<main_output><content>我说完。”</content></main_output>'}],"direct");const {extractPureTextNarrative}=await import("../src/stage/engine.ts");f.options.normalizeNarrative=extractPureTextNarrative;const out=await runAgentTurn(f.options);assert.equal(out.narrative,'他说：“听我说完。”');assert.equal(out.aborted,false);
});

test("机械接续协议由主作者返回suffix，原稿保持不变且无专家代写",async()=>{
 const f=fixture([{text:'他低声说：“听'},{text:'{"suffix":"我说完。”随后他收起了书。"}'}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.narrative,'他低声说：“听我说完。”随后他收起了书。');assert.equal(f.expertCalls.length,0);
});
