import assert from "node:assert/strict";
import test from "node:test";
import { isNativeToolsUnsupported } from "../src/stage/model-failure.ts";
import { runAgentTurn, type AgentTurnOptions } from "../src/stage/agent-turn.ts";
import { DIRECTOR_ROLES, type DirectorPhase, type DirectorReport } from "../src/stage/agent-director.ts";
import type { AssistantMsgLike } from "../src/stage/engine.ts";

const SCHEMA_ERROR = "Invalid function parameters / tools[0] schema invalid";
const PSEUDO_TOOL = '<tool_call>{"name":"consult_experts","arguments":{"tasks":[]}}</tool_call>';
type Response = { text?: string; error?: string; calls?: Array<{ name: string; args?: Record<string, unknown> }> };
const consult = (phase: DirectorPhase): Response => ({ calls: [{ name: "consult_experts", args: {
	tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "合成资料核对" })),
} }] });
const nativeScript = (): Response[] => [consult("evidence"), consult("ideas"),
	{ calls: [{ name: "begin_narrative" }] }, { text: "云澜打开记录册。他开始核对观测数据。" },
	consult("review"), { calls: [{ name: "finalize" }] }];

// Adapted from agent-turn.test.ts; all API replies/errors and expert reports are
// synthetic. Tool capability is independent of semantic report degradation.
function fixture(responses: Response[], recovery = false) {
	const contexts: Parameters<AgentTurnOptions["stream"]>[0][] = [];
	const expertCalls: Array<{ phase: DirectorPhase; count: number }> = [];
	const options: AgentTurnOptions = {
		mode: "director", systemPrompt: "合成卡原文", messages: [], directorPrompt: "合成流程协议",
		readTools: [], toolsSupported: true, timeoutMs: 3000, allowDegraded: false,
		...(recovery ? { toolProtocolRecoveryPrompt: "合成回执恢复：返回原生toolCall，不伪造文本协议。" } : {}),
		read: async () => ({ text: "readonly" }), isCurrent: () => true,
		experts: async (phase, tasks) => {
			expertCalls.push({ phase, count: tasks.length });
			return tasks.map(task => ({ role: task.role, status: "success", summary: "完成", facts: [], inferences: [], candidates: [], issues: [] })) as DirectorReport[];
		},
		stream: context => {
			contexts.push(structuredClone(context));
			const response = responses.shift();
			if (!response) throw new Error("unexpected faux request");
			if (response.error) throw new Error(response.error);
			const message: AssistantMsgLike = { role: "assistant",
				content: response.calls ? response.calls.map((call, index) => ({ type: "toolCall", id: `call-${contexts.length}-${index}`, name: call.name, arguments: call.args ?? {} })) : [{ type: "text", text: response.text ?? "" }],
				stopReason: response.calls ? "toolUse" : "stop",
			};
			return { async *[Symbol.asyncIterator]() {
				if (response.text) yield { type: "text_delta", delta: response.text };
				yield { type: "done", message };
			}, async result() { return message; } };
		},
	};
	return { options, contexts, expertCalls };
}

test("原生工具能力：参数/schema错误、未知函数和HTTP524不等于unsupported", () => {
	for (const error of [SCHEMA_ERROR, "Invalid function arguments for consult_experts",
		"Unknown function: consult_experts", "Function consult_experts is unknown",
		"HTTP 524 upstream timed out", "HTTP 400 tools[0].function.parameters schema invalid"]) {
		assert.equal(isNativeToolsUnsupported(error), false, error);
	}
});

test("原生工具能力：只有显式function calling is not supported等拒绝才判unsupported", () => {
	for (const error of ["function calling is not supported", "This model does not support tools",
		"unsupported parameter: tools", "不支持原生工具调用"]) {
		assert.equal(isNativeToolsUnsupported(error), true, error);
	}
});

test("导演API schema错误不自动切文本协议，不伪造固定阶段成功", async () => {
	const f = fixture([{ error: SCHEMA_ERROR }]);
	const out = await runAgentTurn(f.options);
	assert.equal(out.workflow.toolFallback, false);
	assert.equal(out.aborted, true);
	assert.equal(out.error, SCHEMA_ERROR);
	assert.equal(out.narrative, "");
	assert.equal(f.contexts.length, 1);
	assert.ok(f.contexts[0].tools?.some(tool => tool.name === "consult_experts"));
	assert.equal(f.expertCalls.length, 0);
	assert.equal(out.workflow.stages.some(stage => stage.stage === "finalize"), false);
});

test("文本化伪工具协议不得静默判API不可用，无恢复时保留明确失败", async () => {
	const f = fixture([{ text: PSEUDO_TOOL }]);
	const out = await runAgentTurn(f.options);
	assert.equal(out.workflow.toolFallback, false);
	assert.equal(out.aborted, true);
	assert.match(out.error ?? "", /文本化工具协议/);
	assert.equal(out.narrative, "");
	assert.equal(f.contexts.length, 1);
	assert.equal(f.expertCalls.length, 0);
});

test("文本化伪工具协议恢复仍发送原生tools，固定3/2/2阶段不靠文本fallback", async () => {
	const f = fixture([{ text: PSEUDO_TOOL }, ...nativeScript()], true);
	const out = await runAgentTurn(f.options);
	assert.equal(out.aborted, false, out.error);
	assert.equal(out.workflow.toolFallback, false);
	assert.equal(out.narrative, "云澜打开记录册。他开始核对观测数据。");
	assert.ok(f.contexts[1].tools?.some(tool => tool.name === "consult_experts"));
	assert.match(JSON.stringify(f.contexts[1].messages), /malformed_native_tool_protocol/);
	assert.deepEqual(f.expertCalls, [{ phase: "evidence", count: 3 }, { phase: "ideas", count: 2 }, { phase: "review", count: 2 }]);
	assert.ok(out.workflow.stages.every(stage => stage.status === "success"));
});
