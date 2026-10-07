import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@liyuan/agent-runtime";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@liyuan/ai/providers/faux";
import { registerFauxProvider, streamSimple } from "@liyuan/ai/compat";

import { DEFAULT_MAIN_MAX_TOKENS, FIRST_CALL_MAX_TOKENS, StageEngine, extractPureTextNarrative, isToolUnsupportedError, looksLikeCorruptedModelText, looksLikeTextualToolProtocol, mainStageMaxTokens, userAuthorizesTransition, type StageStreamFn } from "../src/stage/engine.ts";
import { listReplyVariants } from "../src/swipe.ts";

/** 临时舞台：配置+卡+独立会话目录 */
const makeStage = () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-eng-"));
	writeFileSync(
		join(cwd, "card.json"),
		JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
	);
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", creationMode: "ask" }));
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	return { cwd, sm };
};

const makeEngine = (
	cwd: string,
	sm: InstanceType<typeof SessionManager>,
	model: unknown,
	events: ConstructorParameters<typeof StageEngine>[0]["events"] = {},
) =>
	new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => model as never,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events,
	});

/**
 * 场记那一发（M3 起「本拍零落账」的拍才会发起——M-R1 后记账注入把落账拉到台上，
 * 兜底触发率大降，但直出代收+模型不落账的测试路径仍会走到）。
 */
const fauxScribeEmpty = () => fauxAssistantMessage(JSON.stringify({ patch: {} }));

/** 压缩那一发的 v2 envelope：10 节齐全，通过严格校验（梨园只接收结构化摘要为第二套事实权威）。 */
const fauxSummaryV2 = (progressText: string) =>
	fauxAssistantMessage(
		JSON.stringify({
			version: 2,
			summaryMarkdown: [
				`## Story Phase`,
				`当前阶段：early`,
				`## Story Progress`,
				progressText,
				`## Characters`,
				`沈舟：当前状态；云澜：当前状态。`,
				`## Core Events`,
				`暂无`,
				`## Promises & Threads`,
				`暂无未兑现承诺。`,
				`## Canon Facts`,
				`已确认时间线。`,
				`## Knowledge Boundaries`,
				`未知边界。`,
				`## Compression Boundary`,
				`压缩区间末端场景。`,
				`## Current Continuity`,
				`由最近保留正文与 rp-state 提供。`,
				`## Recall Index`,
				`暂无回照词。`,
			].join("\n"),
			events: [],
		}),
	);

/**
 * 直出正文一拍的完整应答序列（M-R1 五注入日程）：
 * 正文 → 代收回执轮（空应答）→ 记账注入轮（空应答）→ 场记兜底。
 * 合约为空（卡无状态栏）时谢幕注入不发生，日程即收束。
 */
const directBeat = (text: string | ((ctx: unknown) => unknown)) => [
	typeof text === "string" ? fauxAssistantMessage(text) : text,
	fauxAssistantMessage(""),
	fauxAssistantMessage(""),
	fauxScribeEmpty(),
];

test("引擎：识别中转 tokenizer 异常文本，不误伤正常 Markdown", () => {
	assert.equal(looksLikeCorruptedModelText("<｜begin▁of▁sentence｜>##### ####### Compression test #####"), true);
	assert.equal(looksLikeCorruptedModelText(`${"#".repeat(80)} 2024 ${"#".repeat(80)}`), true);
	assert.equal(looksLikeCorruptedModelText("## 教室\n\n她关掉 OAA，抬头看向窗外。"), false);
});

test("引擎：识别工具不兼容、文本化伪工具协议和用户显式跳转", () => {
	assert.equal(isToolUnsupportedError("400 tools are not supported by this endpoint"), true);
	assert.equal(isToolUnsupportedError("temporary gateway timeout"), false);
	assert.equal(looksLikeTextualToolProtocol('<｜DSML｜invoke name="draft_append">'), true);
	assert.equal(looksLikeTextualToolProtocol('draft_append({"segment":"正文"})'), true);
	assert.equal(looksLikeTextualToolProtocol("她推门进院。"), false);
	assert.equal(userAuthorizesTransition("推进到第二天清晨，我们去车站。"), true);
	assert.equal(userAuthorizesTransition("她提到明天可能有交流会。"), false);
});

test("引擎：模型声明不支持工具时直接使用纯文本小说模式", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("纯文本模式生成的完整正文。"), fauxScribeEmpty()] as never);
		const contexts: Array<{ systemPrompt?: string; tools?: unknown[] }> = [];
		const base = reg.getModel("faux-rp") as Record<string, unknown>;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => ({ ...base, compat: { ...((base.compat as Record<string, unknown> | undefined) ?? {}), supportsTools: false } }) as never,
			getAuth: async () => ({}),
			streamFn: ((model, context, options) => {
				contexts.push(context as never);
				return (streamSimple as unknown as StageStreamFn)(model, context, options);
			}) as StageStreamFn,
		});
		await engine.performTurn("继续当前场景。");
		assert.equal(contexts[0]?.tools, undefined);
		assert.match(contexts[0]?.systemPrompt ?? "", /纯文本主演模式/);
		assert.ok(JSON.stringify(sm.getBranch()).includes("纯文本模式生成的完整正文"));
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：纯文本小说模式分离正文与状态格式后正常落树", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("<content>纯文本正文落在宅邸门前。\n\n<status>时间：黄昏</status></content>"), fauxScribeEmpty()] as never);
		const base = reg.getModel("faux-rp") as Record<string, unknown>;
		let resynced: string[] | undefined;
		let cleared = 0;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => ({ ...base, compat: { ...((base.compat as Record<string, unknown> | undefined) ?? {}), supportsTools: false } }) as never,
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			events: { onDraftResync: (segments) => { resynced = segments; }, onStreamClear: () => { cleared++; } },
		});
		await engine.performTurn("继续当前场景。");
		const branch = JSON.stringify(sm.getBranch());
		assert.match(branch, /纯文本正文落在宅邸门前/);
		assert.deepEqual(resynced, ["纯文本正文落在宅邸门前。"]);
		assert.equal(cleared, 1);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("纯文本异常终态保留已收到正文，未闭合格式块不吞掉正文", async () => {
	assert.equal(extractPureTextNarrative("<content>前半段正文。\n\n<image>未完成图片参数"), "前半段正文。");
	assert.match(extractPureTextNarrative("<content>前段。<image>图片</image>后段。</content>"), /前段。.*后段。/s);
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const base = reg.getModel("faux-rp") as Record<string, unknown>;
		const streamFn: StageStreamFn = (model, context, options) => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "text_delta", delta: "<content>异常终态下仍应保留的正文。\n\n<options>未完成", contentIndex: 0 };
				yield { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "Stream ended without finish_reason" } };
			},
			result: async () => ({ role: "assistant", content: [], stopReason: "error" }),
		}) as never;
		let ended: { aborted: boolean; entryId?: string; error?: string } | undefined;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => ({ ...base, compat: { ...((base.compat as Record<string, unknown> | undefined) ?? {}), supportsTools: false } }) as never,
			getAuth: async () => ({}),
			streamFn,
			events: { onTurnEnd: (info) => { ended = info; } },
		});
		await engine.performTurn("继续当前场景。");
		const branch = JSON.stringify(sm.getBranch());
		assert.match(branch, /异常终态下仍应保留的正文/);
		assert.equal(ended?.aborted, true);
		assert.ok(ended?.entryId);
		const assistant = (sm.getBranch() as Array<{ message?: { role?: string; content?: Array<{ text?: string }> } }>).find((entry) => entry.message?.role === "assistant");
		assert.equal(assistant?.message?.content?.[0]?.text, "异常终态下仍应保留的正文。");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：稿纸已有正文但 provider 没有 final 时落 aborted assistant", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_write", { content: "断流前已经写入稿纸的正文。" })], { stopReason: "toolUse" }),
		] as never);
		let calls = 0;
		let ended: { aborted: boolean; entryId?: string; error?: string } | undefined;
		const base = reg.getModel("faux-rp") as Record<string, unknown>;
		const streamFn: StageStreamFn = (model, context, options) => {
			calls++;
			if (calls === 1) return (streamSimple as unknown as StageStreamFn)(model, context, options);
			return {
				async *[Symbol.asyncIterator]() {
					yield {
						type: "error",
						reason: "error",
						error: { role: "assistant", content: [], stopReason: "error", errorMessage: "Stream ended without finish_reason" },
					};
				},
				result: async () => ({ role: "assistant", content: [], stopReason: "error" }),
			} as never;
		};
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => ({ ...base }) as never,
			getAuth: async () => ({}),
			streamFn,
			events: { onTurnEnd: (info) => { ended = info; } },
		});

		await engine.performTurn("继续当前场景。");

		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } }>;
		const assistant = branch.find((entry) => entry.type === "message" && entry.message?.role === "assistant");
		assert.equal(calls, 2, "应先交稿，再在下一轮遇到 provider 断流");
		assert.equal(assistant?.message?.stopReason, "aborted");
		assert.equal(assistant?.message?.content?.find((part) => part.type === "text")?.text, "断流前已经写入稿纸的正文。");
		assert.ok(ended?.aborted && ended.entryId, "未完成稿也必须有可重放的 assistant 条目");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：工具字段被 API 拒绝后自动重试纯文本模式", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("自动降级后的小说正文。"), fauxScribeEmpty()] as never);
		const contexts: Array<{ systemPrompt?: string; tools?: unknown[] }> = [];
		let first = true;
		const streamFn: StageStreamFn = (model, context, options) => {
			contexts.push(context as never);
			if (first) {
				first = false;
				const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 tools are not supported by this endpoint" });
				return {
					async *[Symbol.asyncIterator]() { yield { type: "error", reason: "error", error }; },
					result: async () => error,
				} as never;
			}
			return (streamSimple as unknown as StageStreamFn)(model, context, options);
		};
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => reg.getModel("faux-rp"), getAuth: async () => ({}), streamFn });
		await engine.performTurn("继续当前场景。");
		assert.ok((contexts[0]?.tools?.length ?? 0) > 0, "首次按完整工具工作流请求");
		assert.equal(contexts[1]?.tools, undefined, "工具不兼容后撤掉 tools");
		assert.match(contexts[1]?.systemPrompt ?? "", /纯文本主演模式/);
		assert.ok(JSON.stringify(sm.getBranch()).includes("自动降级后的小说正文"));
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：中转异常文本不落树并清除实时稿", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage("<｜begin▁of▁sentence｜>##### Compression test ########################")]);
		let cleared = 0;
		let ended: { error?: string; entryId?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onStreamClear: () => cleared++,
			onTurnEnd: (info) => (ended = info),
		});
		await engine.performTurn("打开 OAA。看一眼当前状态。");
		const assistants = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
		assert.equal(assistants.length, 0);
		assert.ok(cleared > 0);
		assert.match(ended?.error ?? "", /异常解码文本/);
		assert.equal(ended?.entryId, undefined);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：一拍全链路（user 落树 → 流式 → assistant 落树 → 谢幕）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("云澜垂眸受了半礼。「山门夜巡未归的人，是你？」") as never);
		let partials = 0;
		let end: { aborted: boolean; entryId?: string; error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: () => partials++,
			onTurnEnd: (info) => (end = info),
		});

		await engine.performTurn("我上前行礼。");

		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
		const roles = branch.filter((e) => e.type === "message").map((e) => e.message?.role);
		assert.deepEqual(roles, ["user", "assistant"]);
		assert.ok(partials > 0, "流式部分事件应外发");
		assert.ok(end && !end.aborted && !end.error && end.entryId, "谢幕信息应带落树条目 id");
		assert.ok(JSON.stringify(branch).includes("山门夜巡"), "正文在树上");
		assert.equal(engine.isStreaming, false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：旁路 model/thinking 元数据不误触发本拍叶守卫", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("旁路期间仍应落树的正文。") as never);
		let injected = false;
		const streamFn = ((model, context, options) => {
			if (!injected) {
				injected = true;
				(sm as unknown as { appendModelChange: (provider: string, modelId: string) => string }).appendModelChange("new", "faux-rp");
				(sm as unknown as { appendThinkingLevelChange: (level: string) => string }).appendThinkingLevelChange("low");
			}
			return (streamSimple as unknown as StageStreamFn)(model, context, options);
		}) as StageStreamFn;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn,
		});

		await engine.performTurn("继续当前场景。");

		const branch = sm.getBranch() as Array<{ id?: string; parentId?: string | null; type: string; message?: { role?: string } }>;
		const user = branch.find((entry) => entry.type === "message" && entry.message?.role === "user");
		const assistant = branch.find((entry) => entry.type === "message" && entry.message?.role === "assistant");
		assert.ok(user?.id && assistant?.id, "旁路元数据不应阻止 assistant 落树");
		assert.equal(assistant?.parentId, user?.id, "assistant 仍应直接挂在本拍 user 下");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：主演流断流后切非流式重试，正文仍能落树", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("断流恢复后的正文。") as never);
		let calls = 0;
		const models: unknown[] = [];
		const streamFn = ((model, context, options) => {
			calls++;
			models.push(model);
			if (calls === 1) {
				return {
					async *[Symbol.asyncIterator]() {
						yield {
							type: "error",
							error: { role: "assistant", content: [], stopReason: "error", errorMessage: "Stream ended without finish_reason" },
						};
					},
					result: async () => ({ role: "assistant", content: [], stopReason: "error" }),
				} as never;
			}
			return streamSimple(model as never, context as never, options as never) as never;
		}) as unknown as StageStreamFn;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn,
		});

		await engine.performTurn("继续当前场景。");

		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("断流恢复后的正文。"));
		assert.ok(calls >= 2, "断流后应至少重试一次");
		assert.equal((models[1] as { compat?: { streaming?: boolean } }).compat?.streaming, false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：模型不支持 reasoning_effort 时，带工具请求不透传思考档", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("兼容模型正常落稿。") as never);
		const seen: Array<Record<string, unknown> | undefined> = [];
		const streamFn = ((model, context, options) => {
			seen.push(options);
			return streamSimple(model as never, context as never, options as never) as never;
		}) as unknown as StageStreamFn;
		const base = reg.getModel("faux-rp") as Record<string, unknown>;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => ({ ...base, compat: { supportsReasoningEffort: false } }) as never,
			getThinking: () => "low",
			getAuth: async () => ({}),
			streamFn,
		});

		await engine.performTurn("继续当前场景。");

		assert.ok(JSON.stringify(sm.getBranch()).includes("兼容模型正常落稿。"));
		assert.ok(seen.length > 0);
		assert.equal(seen[0]?.reasoning, undefined);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：模型未声明 reasoning_effort 能力时，带工具请求按最低公分母不透传", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("未声明能力的模型正常落稿。") as never);
		const seen: Array<Record<string, unknown> | undefined> = [];
		const streamFn = ((model, context, options) => {
			seen.push(options);
			return streamSimple(model as never, context as never, options as never) as never;
		}) as unknown as StageStreamFn;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getThinking: () => "low",
			getAuth: async () => ({}),
			streamFn,
		});

		await engine.performTurn("继续当前场景。");

		assert.ok(JSON.stringify(sm.getBranch()).includes("未声明能力的模型正常落稿。"));
		assert.equal(seen[0]?.reasoning, undefined);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：忙时排队（R9 回合互斥）——两拍依序完成", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([...directBeat("第一拍回应。"), ...directBeat("第二拍回应。")] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));

		const p1 = engine.performTurn("第一句。");
		const p2 = engine.performTurn("第二句。"); // 忙 → 入队
		await Promise.all([p1, p2]);

		const text = JSON.stringify(sm.getBranch());
		assert.ok(text.includes("第一拍回应"));
		assert.ok(text.includes("第二拍回应"));
		const idx1 = text.indexOf("第一拍回应");
		const idx2 = text.indexOf("第二拍回应");
		assert.ok(idx1 < idx2, "第二拍必须排在第一拍之后");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：regenerate 在钉回的 user 下挂 sibling（swipe 语义）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([...directBeat("第一版回复。"), ...directBeat("重演的第二版。")] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));

		await engine.performTurn("走进殿内。");
		const userId = (sm.getBranch() as Array<{ id: string; type: string; message?: { role?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "user",
		)?.id;
		assert.ok(userId);

		sm.branch(userId);
		await engine.regenerate();

		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("重演的第二版"), "当前分支是重演稿");

		// sibling 关系必须真的成立：swipe 变体只认 user 的**直接**子节点，留档等 custom
		// 条目一旦垫在中间就一个都认不出来（v1.4.1 起 reroll 恒显 1/1、旧变体不可达）。
		const entries = sm.getEntries() as Array<{
			id: string;
			parentId: string | null;
			type: string;
			message?: { role?: string; customType?: string };
		}>;
		const replies = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		assert.equal(replies.length, 2, "两版回复都在树上");
		for (const r of replies) assert.equal(r.parentId, userId, "每版回复都挂在 user 上（sibling）");
		const variants = listReplyVariants(
			entries.map((e) => ({
				id: e.id,
				parentId: e.parentId,
				type: e.type,
				role: e.message?.role,
				customType: e.message?.customType,
			})),
			userId,
			sm.getLeafId(),
		);
		assert.equal(variants.length, 2, "swipe 认出 2 个变体（UI 上的 2/2）");

	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：abort 半拍——已流出的正文落树、标记 aborted", async () => {
	const { cwd, sm } = makeStage();
	// 放慢出字速度，保证 abort 打在流中
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
		]);
		let end: { aborted: boolean; entryId?: string } | null = null;
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(end, "谢幕必须发生");
		assert.equal((end as { aborted: boolean }).aborted, true, "应标记为中断");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string; stopReason?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.ok(asst, "半拍正文仍应落树（用户看过的戏不消失）");
		assert.equal(asst?.message?.stopReason, "aborted");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：无模型/无用户输入的失败路径走通知，不落错误正文", async () => {
	const { cwd, sm } = makeStage();
	const notices: string[] = [];
	const engine = new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => undefined,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events: { onNotify: (_l, t) => notices.push(t) },
	});
	await engine.performTurn("你好。");
	assert.ok(notices.some((t) => t.includes("剧情模型")), "无模型应有人话提示");
	const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
		(e) => e.type === "message" && e.message?.role === "assistant",
	);
	assert.equal(asst.length, 0, "不落任何 assistant 消息");
	rmSync(cwd, { recursive: true, force: true });
});

// ---------------- M-A：宽进严出 + 验收报告喂回（取代 M2 幕后精修） ----------------

import { writeFileSync as wf } from "node:fs";
import { rebuildHistory, type BranchEntryLike } from "../src/stage/assemble.ts";

/** 在临时舞台上加一个带纪律块（禁词表）的预设 */
const addBannedWordPreset = (cwd: string) => {
	wf(
		join(cwd, "preset.json"),
		JSON.stringify({
			blocks: [{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过" }' }],
			samplers: {},
		}),
	);
	wf(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", preset: "preset.json" }));
};

test("引擎循环：直出→代收+回执（零验收零测量，8/10）→模型可重交→定稿", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const contexts: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				contexts.push(ctx);
				return fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。");
			},
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			(ctx) => {
				contexts.push(ctx);
				// 模型看到代收回执里的禁词事实，自己判断重交（回执不含指令）
				return fauxAssistantMessage([fauxToolCall("draft_write", { content: "她沉下一层霜色，收剑入鞘。" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(""), // 记账注入轮：无变动直接停
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
		});
		await engine.performTurn("拔剑指向她。");

		// 定稿 = 模型重交的稿（重交是模型自己的判断，回执没给它任何理由）
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("沉下一层霜色"), "定稿是模型重交的文本");

		// 代收回执：一句认收，零验收零测量（验收已整体退役）
		const fed = JSON.stringify(contexts[1].messages);
		assert.ok(fed.includes("正文已代收为 draft_write"), "代收回执在场");
		assert.ok(!fed.includes("禁词"), "回执无任何匹配统计（验收退役）");
		assert.ok(!/约 \d+ 字|验收/.test(fed), "回执无测量值无验收字样");

		// 过程条：代收 → 交稿；R7 仍守：写作阶段 system 不见禁词细则
		assert.ok(activities.some((a) => a.includes("代收")));
		assert.ok(activities.some((a) => a.includes("交稿")));
		assert.ok(String(contexts[0].systemPrompt).includes("词汇黑名单"), "预设启用块原文直通提示词（拆层退场）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：代收回执后模型不改（只闲聊收笔）→ 保留现稿如实交付，闲聊不落树", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。"),
			fauxAssistantMessage("就这样吧。"), // 模型看过事实仍不改，闲聊收笔
			fauxAssistantMessage(""), // 记账注入轮：无变动直接停
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("拔剑指向她。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("闪过"), "模型拒改 → 保留现稿（引擎不替模型做决定）");
		assert.ok(!finalText.includes("就这样吧"), "收笔闲聊不进正文");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：干净直出=代收后走完记账席位收束，过程条只有一条代收", async () => {
	const { cwd, sm } = makeStage(); // 无预设
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("干净的一拍正文。") as never);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
		});
		await engine.performTurn("走进殿内。");
		assert.equal(reg.getPendingResponseCount(), 0, "初稿+回执轮+记账轮+场记兜底，四发用尽");
		assert.deepEqual(activities, ["直出正文已代收为 draft_write"], "只有一条代收过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：场记记账（R8 独占 + R4 账本=f(分支)） ----------------

import { stateFromBranch } from "../src/stage/assemble.ts";

const fauxScribe = (patch: Record<string, unknown>) => fauxAssistantMessage(JSON.stringify({ patch }));

test("引擎记账：定稿后场记落 rp-state 快照；账本 = f(分支)", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const scribeCtx: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage("云澜接过怀表，指尖顿了顿。"),
			fauxAssistantMessage(""), // 代收回执轮
			fauxAssistantMessage(""), // 记账注入轮：模型没落账 → 场记兜底
			(ctx) => {
				scribeCtx.push(ctx);
				return fauxScribe({ time: "戌时", location: "溪桥", inventory: ["黄铜怀表（云澜持有）"] });
			},
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("我把怀表递给她。");

		const state = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.equal(state.time, "戌时");
		assert.equal(state.location, "溪桥");
		assert.deepEqual(state.inventory, ["黄铜怀表（云澜持有）"]);
		assert.ok(activities.some((a) => a.startsWith("记账")), "记账过程条");
		// 场记读到的是本拍定稿正文
		assert.ok(JSON.stringify(scribeCtx[0].messages).includes("指尖顿了顿"));
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：swipe 重演后账本自动回滚（8/02 泄漏事故复测）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她收下了怀表。"),
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			fauxScribe({ inventory: ["黄铜怀表（云澜持有）"], flags: { 赠礼: "已收下" } }),
			fauxAssistantMessage("她把怀表推了回来。"),
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			fauxScribe({ inventory: ["黄铜怀表（沈舟持有）"], flags: { 赠礼: "被拒绝" } }),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("我把怀表递给她。");
		assert.deepEqual(stateFromBranch(sm.getBranch() as BranchEntryLike[]).inventory, ["黄铜怀表（云澜持有）"]);

		// swipe：叶钉回 user，重演一版
		const userId = (sm.getBranch() as Array<{ id: string; type: string; message?: { role?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "user",
		)?.id;
		assert.ok(userId);
		sm.branch(userId);
		await engine.regenerate();

		const after = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.deepEqual(after.inventory, ["黄铜怀表（沈舟持有）"], "废弃分支的账本不得泄漏到新分支");
		assert.equal(after.flags["赠礼"], "被拒绝");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：中断的半拍不记账（半截正文不进账本）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
			fauxScribe({ time: "不该被记下的时间" }),
		]);
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
		});
		await engine.performTurn("开演。");

		const snaps = (sm.getBranch() as Array<{ type?: string; customType?: string }>).filter(
			(e) => e.type === "custom" && e.customType === "rp-state",
		);
		assert.equal(snaps.length, 0, "中断拍不落账本快照");
		assert.equal(reg.getPendingResponseCount(), 1, "场记那一发根本没发出");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：台上检索工具循环（R2 查资料 + R6 动笔即收敛） ----------------

/** 带一条可被检索命中的世界书的舞台 */
const addLorebook = (cwd: string) => {
	wf(
		join(cwd, "lore.json"),
		JSON.stringify({
			entries: {
				"0": {
					uid: 0,
					key: ["骨誓", "北境"],
					comment: "北境骨誓",
					content: "北境以骨为契：折骨立誓，背誓者终身不得入祠。",
					constant: false,
					enabled: true,
					order: 100,
				},
			},
		}),
	);
	wf(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", lorebooks: ["lore.json"] }),
	);
};

test("引擎工具：查设定 → 结果回喂 → 续演正文；工具装配进 Context", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage([fauxToolCall("lorebook_search", { query: "骨誓" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("她提起北境的规矩：折骨立誓，背誓不得入祠。");
			},
			fauxAssistantMessage(""), // 代收回执轮
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("北境的骨誓是什么规矩？");

		// 读侧 + 写侧全清单装配进首轮。lorebook_toggle 不在其中：本用例未注入
		// setDisabledLore，统一层按依赖过滤（依赖缺失的工具不上清单，见 adapters/stage.ts）
		const names = (ctxs[0].tools ?? []).map((t) => t.name).sort();
		assert.deepEqual(names, [
			"beat_plan",
			"beat_step_done",
			"card_read",
			"draft_append",
			"draft_edit",
			"draft_read",
			"draft_seal",
			"draft_search",
			"draft_write",
			"lorebook_list",
			"lorebook_search",
			"lorebook_write",
			"memory_search",
			"world_state_get",
			"world_state_update",
		]);

		// 检索结果以 toolResult 回喂
		const fed = JSON.stringify(ctxs[1].messages);
		assert.ok(fed.includes("toolResult"), "工具结果以 toolResult 角色回喂");
		assert.ok(fed.includes("折骨立誓"), "命中的设定正文在场");

		// 续演正文流式上屏 + 落树
		//
		// 这一拍查过库（lookups=1），模型却直出正文由引擎代收为 draft_write——
		// 代收走 internal 旁路跳过门禁，否则这拍的正文会被拦下丢掉。
		assert.ok(streamed.includes("背誓不得入祠"), "工具轮后的正文照常流式");
		assert.ok(
			activities.some((a) => a.includes("直出正文已代收")),
			"查过库后的直出正文仍被代收（门禁不拦兜底路径）",
		);
		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string } }>;
		assert.deepEqual(
			branch.filter((e) => e.type === "message").map((e) => e.message?.role),
			["user", "assistant"],
			"工具过程不落树（R3：过程不进历史）",
		);
		assert.ok(JSON.stringify(branch).includes("背誓不得入祠"), "定稿在树上");
		assert.ok(activities.some((a) => a.includes("查设定「骨誓」")), "过程条报告检索");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_write 工具交稿 → 收稿即验回喂 → 收笔定稿", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage([fauxToolCall("draft_write", { content: "她点头应下此事。" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(""); // 记账注入轮：无变动直接停
			},
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const draftFlags: boolean[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d, draft) => {
				if (kind === "text") {
					streamed += d;
					if (draft) draftFlags.push(true);
				}
			},
		});
		await engine.performTurn("此事你应是不应？");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "她点头应下此事。", "定稿 = 工具提交的稿");
		assert.ok(streamed.startsWith("她点头应下此事。"), "D1：draft_write 的 content 走 text 通道上屏");
		assert.ok(draftFlags.length > 0, "draft_write 转发带 draft 标记（前端替换语义）");
		assert.ok(JSON.stringify(ctxs[1].messages).includes("已收稿"), "收稿+验收报告以 toolResult 回喂");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条报告交稿");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_append 分段续写 → 中途查证 → draft_seal 封笔 → 定稿为拼接全文（M-E）", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 第一段：先写开头（首段前有第 1 轮构思，无需 thinking 块）
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "山门外的雪落了一夜。" })], {
				stopReason: "toolUse",
			}),
			// 写到需要查证的地方停下来查——这正是分段续写要换来的东西
			fauxAssistantMessage(
				[fauxThinking("写到骨誓的规矩，记不清细节，停下来查设定。"), fauxToolCall("lorebook_search", { query: "骨誓" })],
				{ stopReason: "toolUse" },
			),
			// 拿到设定后接着往下写（查证轮有思考，不触发零思考门禁）
			fauxAssistantMessage(
				[
					fauxThinking("承接路标：把查到的骨誓规矩落进这段，他记起北境的戒律。"),
					fauxToolCall("draft_append", { segment: "他记起北境的规矩：背誓不得入祠。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 封笔
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""), // 看到验收报告 → 收笔
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		let resets = 0;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d, draft, reset) => {
				if (kind !== "text") return;
				streamed += d;
				if (draft && reset) resets++;
			},
		});
		await engine.performTurn("我推门进屋。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("山门外的雪落了一夜。"), "第一段在定稿里");
		assert.ok(finalText.includes("背誓不得入祠"), "续写的第二段也在定稿里（追加不覆盖）");
		assert.ok(
			finalText.indexOf("山门外") < finalText.indexOf("背誓不得入祠"),
			"两段按写作顺序拼接",
		);
		// 关键体验：续写不得 reset——已上屏的段落是已经发生的事，不能被擦掉重排
		assert.equal(resets, 0, "draft_append 的流式转发不带 reset（不清屏重写）");
		assert.ok(streamed.includes("山门外的雪落了一夜。"), "第一段流式上屏");
		assert.ok(streamed.includes("背誓不得入祠"), "第二段流式上屏");
		assert.ok(
			activities.some((a) => a.includes("演完第 1 个路标")) && activities.some((a) => a.includes("演完第 2 个路标")),
			"过程条按段报告续写",
		);
		assert.ok(activities.some((a) => a.includes("封笔")), "过程条报告封笔");
		// 时间线持久化：两段独立记档（刷新后仍是「一段段长出来」的形态）
		const branch = JSON.stringify(sm.getBranch());
		assert.ok(branch.includes("rpTimeline"), "时间线随 details 持久化");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：受理门拒掉的段落不落树，接受后正文成为定稿", async () => {
	const { cwd, sm } = makeStage();
	// 一张「每轮必读」skill，触发受理门
	mkdirSync(join(cwd, "skills", "必读"), { recursive: true });
	writeFileSync(
		join(cwd, "skills", "必读", "SKILL.md"),
		"---\nname: 必读\ndescription: 落笔前必读\neveryBeat: true\n每轮: true\n---\n\n每段写之前读我。",
	);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 第 1 段：没读 skill 就交 → 受理门拒绝（不转发的证明）
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "被拒的一段，不该上屏。" })], { stopReason: "toolUse" }),
			// 读完 skill 重交 → 接受
			fauxAssistantMessage(
				[fauxToolCall("skill_read", { name: "必读" }), fauxToolCall("draft_append", { segment: "被接受的一段。" })],
				{ stopReason: "toolUse" },
			),
			// 封笔
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""), // 记账/收束轮
			fauxScribeEmpty(),
		]);
		const streamed: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, d, draft) => {
				if (kind === "text" && draft) streamed.push(d);
			},
		});
		await engine.performTurn("我推门进屋。");

		// provider 参数增量可能已先流出，但权威定稿必须只含受理内容。
		assert.ok(streamed.some((s) => s.includes("被接受的一段")), "受理通过的段落才上屏");
		// 定稿只有被接受的段落
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("被接受的一段"), "定稿含受理段落");
		assert.ok(!finalText.includes("被拒的一段"), "定稿不含被拒段落");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：受理门按路标计费——同一路标内第二段免读，勾掉路标才重新计门（8/16）", async () => {
	const { cwd, sm } = makeStage();
	mkdirSync(join(cwd, "skills", "必读"), { recursive: true });
	writeFileSync(
		join(cwd, "skills", "必读", "SKILL.md"),
		"---\nname: 必读\ndescription: 落笔前必读\neveryBeat: true\n每轮: true\n---\n\n落笔前读我。",
	);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 规划轮必须和落笔物理分开。
			fauxAssistantMessage(
				[
					fauxToolCall("beat_plan", { steps: ["路标一", "路标二"] }),
					fauxToolCall("skill_read", { name: "必读" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段，同路标内。" })], { stopReason: "toolUse" }),
			// 同一条路标内再交一段，**没有重读** → 也该受理（按段计费时这里会被打回）
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第二段，仍在同一路标，免读。" })], {
				stopReason: "toolUse",
			}),
			// 勾掉路标一 → 门重新计；接着不读就交 → 应被打回
			fauxAssistantMessage(
				[
					fauxToolCall("beat_step_done", { step: 1 }),
					fauxToolCall("draft_append", { segment: "越过新路标却没读，应被打回。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 补读后重交 → 受理
			fauxAssistantMessage(
				[fauxToolCall("skill_read", { name: "必读" }), fauxToolCall("draft_append", { segment: "补读后的一段。" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("我推门进屋。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("第一段，同路标内。"), "路标内首段受理");
		assert.ok(finalText.includes("第二段，仍在同一路标，免读。"), "同一路标内第二段免读即受理——按路标计费的证据");
		assert.ok(!finalText.includes("越过新路标却没读"), "勾掉路标后门重新计，未读即打回");
		assert.ok(finalText.includes("补读后的一段。"), "补读后重交受理");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_append 后忘了封笔 → 催告一轮 → 仍不封则兜底封笔，日程照走（M-E/M-R1）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "她把伞收在门外，抖了抖雪。" })], {
				stopReason: "toolUse",
			}),
			// 停手但没封笔 → 引擎催封笔一轮（§2.4 文案）
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(""); // 催告后仍不封笔 → 引擎兜底封笔
			},
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {});
		await engine.performTurn("我抬头看她。");

		const nudge = JSON.stringify(ctxs[0]?.messages ?? []);
		assert.ok(nudge.includes("已续写 1 个路标未封笔。写完就 draft_seal，没写完接着写。"), "催封笔 = 契约文案（§2.4）");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "她把伞收在门外，抖了抖雪。", "兜底封笔，正文照常落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：格式尾巴（状态栏占位+catsay）走 text 通道 → 并入定稿正文与持久化时间线", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 8/05 实锤形态：draft_write 只交正文，思考里宣告还要写状态栏与点评
			fauxAssistantMessage(
				[
					fauxThinking("The user decides. Now the status bar and cat commentary."),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 尾巴轮：状态栏占位 + 咪咪点评（预设格式栈，不走 draft_write）
			fauxAssistantMessage(
				"<StatusPlaceHolderImpl/>\n\n<catsay>\n<details><summary>😼咪咪点评</summary>\n选天赋磨叽半天喵呜。\n</details>\n</catsay>",
			),
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("往溪桥去。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		// 树上正文 = 用户面定稿：正文 + 状态栏占位 + 咪咪点评都在
		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("暮色四合"), "正文在树上");
		assert.ok(treeText.includes("StatusPlaceHolderImpl"), "状态栏占位并入定稿——不再被过滤");
		assert.ok(treeText.includes("咪咪点评"), "咪咪点评并入定稿——不再被过滤");
		assert.ok(streamed.includes("咪咪点评"), "尾巴也流式上屏过");
		// 模型面历史仍整块剥 catsay（防往拍模仿）——「历史剥、树留」双语义各就位
		assert.ok(history[history.length - 1].text.includes("暮色四合"), "历史含正文");
		assert.ok(!history[history.length - 1].text.includes("咪咪点评"), "历史剥掉格式栈（往拍模仿源）");

		// 时间线随 details 持久化：resync/刷新后尾巴仍在
		const entry = branch.filter((e) => e.type === "message" && e.message?.content).pop();
		const timeline = entry?.message?.details?.rpTimeline as
			| Array<{ kind: string; text?: string; draft?: boolean }>
			| undefined;
		assert.ok(Array.isArray(timeline), "rpTimeline 落树持久化");
		const textSegs = (timeline ?? []).filter((s) => s.kind === "text");
		const tlText = textSegs.map((s) => s.text ?? "").join("\n\n");
		assert.ok(tlText.includes("咪咪点评"), "持久化时间线含尾巴");
		// 分段同构（8/09 输出形式）：稿段与尾巴段各自独立——稿段带 draft，尾巴段不带
		assert.equal(textSegs.length, 2, "稿段 + 尾巴段，互不吸收");
		assert.ok(textSegs[0].draft === true && (textSegs[0].text ?? "").includes("暮色四合"), "稿段在前且带 draft 标记");
		assert.ok(textSegs[1].draft !== true && (textSegs[1].text ?? "").includes("咪咪点评"), "尾巴独立末段（非稿段）");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条照常");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：场记只读正文，不把谢幕小剧场升级为账本事实", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const scribeCtx: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_write", { content: "她仍站在体育馆里，没有回答邀请。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("<Small_theater>论坛热帖：她已经提交申请并离开体育馆。</Small_theater>"),
			fauxAssistantMessage(""), // 主演记账席位不落账，随后进入场记兜底
			(ctx) => {
				scribeCtx.push(ctx as never);
				return fauxScribeEmpty();
			},
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("我暂时不作决定。");
		const fed = JSON.stringify(scribeCtx[0]?.messages ?? []);
		assert.match(fed, /仍站在体育馆/);
		assert.doesNotMatch(fed, /论坛热帖|提交申请|离开体育馆/);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：world_state_update 记账——模型提交 patch，账本落树，场记旁路不再发出", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("world_state_update", { patch: { time: "戌时", location: "溪桥" } })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(""), // 记账轮结束
			// 注意：没有场记那一发——模型已记账，旁路兜底不得发出
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("往溪桥去。");

		const state = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.equal(state.time, "戌时");
		assert.equal(state.location, "溪桥");
		assert.equal(reg.getPendingResponseCount(), 0, "三发用尽——场记旁路没有发出（D5 兜底只在无 patch 时）");
		assert.ok(activities.some((a) => a.includes("记账")), "记账过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：空手停笔（0 字病灶）→ 催稿一轮 → 补交定稿", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage(""), // 思考完不写正文（实弹三拍 0 字的复现）
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("补上的正文。");
			},
			fauxAssistantMessage(""), // 代收回执轮
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");

		const nudge = JSON.stringify(ctxs[0].messages);
		assert.ok(nudge.includes("你还没有落笔。用 draft_append 演出，或 draft_write 一次交完，否则本拍无产出。"), "逼稿 = 契约文案（§2.4）");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "补上的正文。", "补交的正文成为定稿——空拍被结构性消灭");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：催稿后仍空手 → 认栽收拍并通知（不再静默丢拍）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
		const notices: string[] = [];
		let end: { error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onNotify: (_l, t) => notices.push(t),
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(notices.some((t) => t.includes("未交出任何正文")), "空拍必须有人话通知");
		assert.equal((end as { error?: string } | null)?.error, "no-draft");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.equal(asst.length, 0, "空拍不落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎工具：不查资料的一拍零额外调用（工具是可选的，不是必经的）", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("她点了点头，没多问。") as never);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("我说了声走吧。");

		assert.equal(reg.getPendingResponseCount(), 0, "直出四发（初稿/回执/记账/场记），无工具轮");
		assert.ok(!activities.some((a) => a.startsWith("查")), "没查就不出检索过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M4 长局压缩（引擎自管） ----------------

/** 写配置：压缩周期可调 */
const setCompactEvery = (cwd: string, everyNTurns: number) =>
	writeFileSync(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", compactEveryNTurns: everyNTurns }),
	);

test("引擎压缩：攒够拍数后自管落 rp-summary，被覆盖的正文不再进上下文", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 2);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const long = (i: number) => `第 ${i} 拍的正文。${"云".repeat(1200)}`;
		// 8 拍：保留 6 + 周期 2 → 第 8 拍收尾时应触发一次压缩
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push((ctx: unknown) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(long(i));
			});
			responses.push(fauxAssistantMessage("")); // 代收回执轮
			responses.push(fauxAssistantMessage("")); // 记账注入轮
			responses.push(fauxScribeEmpty());
		}
		// 压缩那一发（第 8 拍尾）
		responses.push(fauxSummaryV2("前情提要：沈舟与云澜在山门相遇。"));
		reg.setResponses(responses as never);

		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		const branch = sm.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
		const summaries = branch.filter((e) => e.type === "custom" && e.customType === "rp-summary");
		assert.equal(summaries.length, 1, "应恰好落一条 rp-summary");
		const data = summaries[0].data as { summary: string; coversThroughId: string; turns: number };
		assert.ok(data.summary.includes("前情提要"));
		assert.equal(data.turns, 2, "8 拍保留 6 → 覆盖前 2 拍");
		assert.ok(activities.some((a) => a.includes("前情已压缩")), "过程条报告压缩");

		// 树只追加：原文楼层照旧全在（重放/回看不受影响）
		assert.ok(JSON.stringify(branch).includes("第 1 拍的正文"), "被覆盖的正文仍在树上");
		assert.equal(reg.getPendingResponseCount(), 0, "八拍（各四发）+ 一次压缩");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：下一拍装配读回【前情提要】，被覆盖的往拍原文消失（长局提速的实质）", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 2);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const cap = (text: string) => (ctx: unknown) => {
			ctxs.push(ctx as never);
			return fauxAssistantMessage(text);
		};
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(cap(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		responses.push(fauxSummaryV2("前情提要：沈舟与云澜在山门相遇，立了骨誓。"));
		// 压缩之后的第 9 拍
		responses.push(cap("第 9 拍的正文。"));
		responses.push(fauxAssistantMessage(""));
		responses.push(fauxAssistantMessage(""));
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);

		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 9; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		const capturedBeat9 = ctxs[ctxs.length - 1];
		const flat = JSON.stringify(capturedBeat9.messages);
		assert.ok(flat.includes("【前情提要】"), "摘要以前情提要块回读进上下文");
		assert.ok(flat.includes("立了骨誓"), "摘要正文在场");
		assert.ok(!flat.includes("第 1 拍的正文"), "被覆盖的往拍原文不再进上下文");
		assert.ok(!flat.includes("第 2 拍的正文"), "被覆盖的往拍原文不再进上下文");
		assert.ok(flat.includes("第 7 拍的正文"), "保留区往拍逐字仍在");

		// 用户当拍的话仍是最后一句（8/03 教训不能被压缩打破）
		const lastMsg = capturedBeat9.messages[capturedBeat9.messages.length - 1] as { content: Array<{ text: string }> };
		assert.ok(lastMsg.content[0].text.trimEnd().endsWith("第 9 拍我说的话。"), "用户当拍的话必须是上下文最后一句");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：中断的半拍不触发压缩（脏拍不压）", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 1);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		// 第 8 拍收尾时可裁正文（前 2 拍）才越过字数地板 → 恰好压一次
		responses.push(fauxSummaryV2("前情提要：前两拍的摘要。"));
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);
		const before = (sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary");
		assert.equal(before.length, 1, "干净收笔的拍会压缩");

		// 中断的半拍：只出正文不出场记/压缩
		reg.setResponses([fauxAssistantMessage(`第 9 拍。${"云".repeat(1200)}`, { stopReason: "aborted" })]);
		await engine.performTurn("第 9 拍我说的话。");
		const after = (sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary");
		assert.equal(after.length, 1, "中断半拍不得触发新压缩");
		assert.equal(reg.getPendingResponseCount(), 0);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：compactNow() 手动压缩不等周期；流式中拒绝", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 0); // 自动压缩关闭
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			0,
			"everyNTurns=0 时不自动压缩",
		);

		reg.setResponses([fauxSummaryV2("前情提要：手动压缩产出的摘要。")]);
		const r = await engine.compactNow();
		assert.equal(r.kind, "compacted");
		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			1,
			"手动压缩落一条摘要",
		);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("逐段硬门：同一轮第二个 draft_append 拒收，下一轮可继续", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [
			// 一轮连发两个 append：只收第一段。
			fauxAssistantMessage(
				[
					fauxToolCall("draft_append", { segment: "她推门进院。" }),
					fauxToolCall("draft_append", { segment: "院里空无一人。" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "院里空无一人。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		];
		reg.setResponses(responses as never);

		const activities: string[] = [];
		const resyncs: string[][] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d), onDraftResync: (segments) => resyncs.push(segments) });
		await engine.performTurn("你先进去。");

		assert.ok(activities.some((a) => a.includes("演完第 1 个路标")) && activities.some((a) => a.includes("演完第 2 个路标")), "两段都收");
		assert.ok(activities.some((a) => a.includes("同轮第二次正文修改被拦下")), "同轮第二段有明确拒收记录");
		assert.deepEqual(resyncs[0], ["她推门进院。"], "撤掉已流式上屏但未受理的第二段");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.indexOf("她推门进院。") < finalText.indexOf("院里空无一人。"), "两段按序拼接落树");
		assert.equal(finalText.match(/院里空无一人。/g)?.length, 1, "拒收段只在下一轮受理一次");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("五注入日程：进度行每轮替换、判定注入路标演完时一次（§2.3）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			// 规划轮：首轮末端注入应带规划卡（契约文案）
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 演第一段（此轮上下文应有【进度】路标 1/2）
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "她推门进院。" }), fauxToolCall("beat_step_done", { step: 1 })], { stopReason: "toolUse" })),
			// 演第二段并勾掉（此轮上下文应有【进度】路标 2/2——旧的进度行被替换）
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "院里的人抬起头。" }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			// 路标全部演完：此轮上下文应有【判定】
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[0].includes("【第 1 步·规划】本拍还没有计划。"), "规划卡随首轮末端注入送达");
		assert.ok(ctxs[1].includes("【进度】路标 1/2「推门」；已演 0 段。"), "进度行只投影路标与段数");
		assert.ok(ctxs[2].includes("【进度】路标 2/2「见人」；已演 1 段"), "进度行更新到当前路标");
		assert.equal((ctxs[2].match(/【进度】/g) ?? []).length, 1, "替换语义：上下文里只有一条进度行");
		assert.ok(ctxs[3].includes("【判定】继续写"), "判定注入在路标演完且稿非空时出现");
		assert.ok(!ctxs[3].includes("必要时 `ask`"), "判定不再引入剧情询问");
		assert.ok(ctxs[4].includes("【记账】已封笔。"), "seal 之后第一件事是记账注入");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("抢跑 seal 时序保证（PLAN-ASK §2.2）：路标演完同轮直接封笔被判定回执拦下，二次 seal 受理", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门"] })], { stopReason: "toolUse" })),
			// 抢跑形态：同一轮里演完、勾完、直接 seal——判定席位从未送达
			cap(
				fauxAssistantMessage(
					[
						fauxToolCall("draft_append", { segment: "她推门进院。" }),
						fauxToolCall("beat_step_done", { step: 1 }),
						fauxToolCall("draft_seal", {}),
					],
					{ stopReason: "toolUse" },
				),
			),
			// 判定回执已达；模型再次 seal → 照常受理
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[2].includes("【判定】继续写"), "首次 seal 不受理——回执即判定文案（同一席位提前送达）");
		assert.ok(!ctxs[2].includes("询问用户") && !ctxs[2].includes("`ask`"), "判定只保留稿纸协议");
		assert.ok(!ctxs[2].includes("已封笔"), "首次 seal 未被受理");
		assert.ok(ctxs[3].includes("已封笔"), "二次 seal 照常受理（一次性保证，不成循环）");
		assert.ok(ctxs[3].includes("【记账】已封笔。"), "受理后日程继续：记账注入");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("路标完成必须有正文证据，正文落地后才允许推进判定", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 稿纸 0 字连勾两条应直接拒绝。
			cap(fauxAssistantMessage([fauxToolCall("beat_step_done", { step: 1 }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "她推门进院。" }), fauxToolCall("beat_step_done", { step: 1 })], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "院里的人抬起头。" }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[2].includes("尚无已受理正文"), "0 字路标完成被拒绝");
		assert.ok(ctxs[4].includes("【判定】继续写"), "正文与路标都完成后判定出现");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("判定送达不依赖路标勾选（8/12 放宽）：没勾完路标就封笔被判定回执拦下，二次 seal 受理", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 实弹形态：只勾了第 1 条路标（勾 1/2）就直接封笔——判定席位从未送达
			cap(
				fauxAssistantMessage(
					[
						fauxToolCall("draft_append", { segment: "她推门进院。" }),
						fauxToolCall("beat_step_done", { step: 1 }),
						fauxToolCall("draft_seal", {}),
					],
					{ stopReason: "toolUse" },
				),
			),
			// 判定回执已达；模型再次 seal → 照常受理（拦一次不拦第二次，防空转）
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[2].includes("【判定】继续写"), "没勾完路标直接封笔也被拦——回执即判定文案");
		assert.ok(!ctxs[2].includes("询问用户") && !ctxs[2].includes("`ask`"), "判定只保留稿纸协议");
		assert.ok(!ctxs[2].includes("已封笔"), "首次 seal 未被受理（判定优先于封笔）");
		assert.ok(ctxs[3].includes("已封笔"), "二次 seal 照常受理（一次性保证，不成循环）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("判定送达不依赖工具轮（8/12 补洞）：勾不齐路标就停手，兜底封笔前补判定", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 只勾了第 1 条（勾 1/2，allDone=false → 工具轮判定分支不触发），然后停手
			cap(
				fauxAssistantMessage(
					[fauxToolCall("draft_append", { segment: "她推门进院。" }), fauxToolCall("beat_step_done", { step: 1 })],
					{ stopReason: "toolUse" },
				),
			),
			// 停手1：催封笔（appends>0 未封笔）
			cap(fauxAssistantMessage("")),
			// 停手2：催过仍停手 → 兜底封笔前补判定（工具轮判定分支跑不到，停手分支补）
			cap(fauxAssistantMessage("")),
			// 停手3：判定已送达 → 兜底封笔 → 记账 → 谢幕 → 收束
			cap(fauxAssistantMessage("")),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[3].includes("已续写 1 个路标未封笔"), "停手1：催封笔");
		assert.ok(ctxs[4].includes("【判定】继续写"), "停手2：兜底封笔前补判定");
		assert.ok(!ctxs[4].includes("询问用户") && !ctxs[4].includes("`ask`"), "补的判定只保留稿纸协议");
		assert.equal((ctxs[4].match(/【判定】/g) ?? []).length, 1, "判定只补一次，不成循环");
		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
		assert.ok(JSON.stringify(branch).includes("她推门进院"), "正文在树上（兜底封笔正常收束）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});




test("每轮修复可见性：draft_edit 修改后分段重同步（8/09 输出形式）", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd); // 禁词表 { "闪过" }
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		// 第一轮：beat_plan
		responses.push(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门"] })], { stopReason: "toolUse" }));
		// 第二轮：append 带禁词的第一段
		responses.push(
			fauxAssistantMessage(
				[fauxThinking("承接路标：她推门进来，眼中闪过一道冷光。"), fauxToolCall("draft_append", { segment: "她推门进来，眼中闪过一道冷光。" })],
				{ stopReason: "toolUse" },
			),
		);
		// 第三轮：draft_edit 修掉禁词
		responses.push(
			fauxAssistantMessage(
				[fauxThinking("修掉禁词。"), fauxToolCall("draft_edit", { edits: [{ old: "眼中闪过一道冷光", new: "眼中亮起一道冷光" }] })],
				{ stopReason: "toolUse" },
			),
		);
		// 第四轮：封笔
		responses.push(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }));
		responses.push(fauxAssistantMessage(""));
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);

		const resyncs: string[][] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDraftResync: (segments) => resyncs.push(segments),
		});
		await engine.performTurn("你先进去。");

		// 编辑后收到分段重同步推送：修后分段原位替换，禁词已消失
		assert.ok(resyncs.length >= 1, "draft_edit 后应收到 draft_resync 推送");
		const last = resyncs[resyncs.length - 1];
		assert.ok(last.some((p) => p.includes("眼中亮起一道冷光")), "推送的是修后分段");
		assert.ok(last.every((p) => !p.includes("闪过")), "禁词已消失");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("记账注入（§2.3）：seal 后席位保证；本拍已有落账（结构信号）则跳过", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let postSealCtx = "";
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "进屋叙话"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("draft_append", { segment: "他推门进屋，炉火将熄。" })],
				{ stopReason: "toolUse" },
			),
			// 首次 seal：路标没勾 → 判定回执拦下；二次 seal 照常受理 → 注入记账
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			// seal 之后第一件事：记账注入（捕获）；模型据此落账
			(ctx) => {
				postSealCtx = JSON.stringify((ctx as { messages?: unknown[] }).messages ?? []);
				return fauxAssistantMessage([fauxToolCall("world_state_update", { patch: { location: "屋内" } })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(""), // 记账轮结束（停止调用写账工具）→ 无合约 → 收束
			// 模型已落账：场记兜底不发出
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(postSealCtx.includes("【记账】已封笔。核对本拍变动并落账"), "记账注入 = 契约文案");
		assert.ok(postSealCtx.includes("没有变动就直接停"), "记账注入完整送达");
		assert.ok(!postSealCtx.includes("【演段回看】") && !postSealCtx.includes("【谢幕】"), "封笔后不催演；谢幕在记账轮之后");
		assert.equal(stateFromBranch(sm.getBranch() as BranchEntryLike[]).location, "屋内", "台上落账生效");
		assert.equal(reg.getPendingResponseCount(), 0, "场记兜底未发出（本拍已有落账）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("记账顺序：sealed 前 patch 被拒，封笔后注入记账并受理", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let postSealCtx = "";
		reg.setResponses([
			// 同轮先记账再交稿：调用顺序决定此 patch 尚未 sealed，必须拒绝
			fauxAssistantMessage(
				[
					fauxToolCall("world_state_update", { patch: { time: "戌时" } }),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			(ctx) => {
				postSealCtx = JSON.stringify((ctx as { messages?: unknown[] }).messages ?? []);
				return fauxAssistantMessage([fauxToolCall("world_state_update", { patch: { time: "戌时" } })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(""),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("往溪桥去。");

		assert.ok(postSealCtx.includes("【记账】"), "sealed 前调用不算落账，封笔后记账席位仍出现");
		assert.ok(postSealCtx.includes("正文尚未封笔"), "首个 patch 的拒绝回执可审计");
		assert.equal(stateFromBranch(sm.getBranch() as BranchEntryLike[]).time, "戌时");
		assert.equal(reg.getPendingResponseCount(), 0, "场记兜底未发出");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("规划旁白不入正文：稿落地前工具轮的 text 产出被清理，不拼进定稿（8/09 实弹）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 规划轮：模型把读题/列路标走了 text 通道（实弹形态）——旁白，不是正文
			fauxAssistantMessage(
				[fauxText("先读题：用户要看炉火，我列一下路标。"), fauxToolCall("beat_plan", { steps: ["推门"] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxThinking("演第一段。"), fauxToolCall("draft_append", { segment: "他推门进屋，炉火将熄。" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			// 停手轮直接带尾巴（稿落地后的 text = 合法尾巴，保留）
			fauxAssistantMessage("<catsay>点评一句。</catsay>"),
			fauxScribeEmpty(),
		]);
		let clears = 0;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onStreamClear: () => clears++,
		});
		await engine.performTurn("你先进去。");

		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }>; details?: { rpTimeline?: unknown } };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("他推门进屋"), "正文在树上");
		assert.ok(treeText.includes("点评一句"), "稿后尾巴保留");
		assert.ok(!treeText.includes("先读题"), "规划旁白不得拼进定稿正文");
		const tl = (lastMsg?.message?.details?.rpTimeline ?? []) as Array<{ kind: string; text?: string }>;
		const tlText = tl.filter((s) => s.kind === "text").map((s) => s.text ?? "").join("\n");
		assert.ok(!tlText.includes("先读题"), "落树时间线的正文段不含旁白");
		assert.ok(clears >= 1, "旁白轮触发 stream 清理（前端收进过程条）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("轮次耗尽收场：安全阀撤工具，当前卡无格式计划时不凭空生成谢幕", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let lastCtx = "";
		let lastCtxHadTools = true;
		const responses: unknown[] = [
			fauxAssistantMessage(
				[fauxToolCall("beat_plan", { steps: ["一", "二", "三", "四", "五", "六", "七", "八"] })],
				{ stopReason: "toolUse" },
			),
		];
		// 19 个 append，把轮次预算（20）耗到最后一轮
		for (let i = 1; i <= 19; i++) {
			responses.push(
				fauxAssistantMessage(
					[fauxThinking(`想第 ${i} 段。`), fauxToolCall("draft_append", { segment: `第 ${i} 段正文。` })],
					{ stopReason: "toolUse" },
				),
			);
		}
		// 最后一轮（lastRound，工具已收起）：模型只思考、没有产生可见格式。
		responses.push((ctx: { messages?: unknown[]; tools?: unknown }) => {
			lastCtx = JSON.stringify(ctx.messages ?? []);
			lastCtxHadTools = ctx.tools !== undefined;
			return fauxAssistantMessage([fauxThinking("格式已经想好，准备交付。")]);
		});
		let curtainCtxHadTools = true;
		let curtainReasoning: unknown;
		responses.push((ctx: { tools?: unknown }, options?: { reasoning?: unknown }) => {
			curtainCtxHadTools = ctx.tools !== undefined;
			curtainReasoning = options?.reasoning;
			return fauxAssistantMessage("<options>独立交付的选项。</options>");
		});
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");

		assert.ok(lastCtx.includes("【收场】"), "轮次耗尽时注入收场指令（不再让模型不明所以干想散场）");
		assert.equal(lastCtxHadTools, false, "最后一轮工具已收起");
		assert.equal(curtainCtxHadTools, false, "独立谢幕席位不开放工具");
		assert.equal(curtainReasoning, "off", "独立谢幕继承本测试配置的推理档");
		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(!branchText.includes('"rpCurtain"'), "当前卡未声明格式，不凭空建立谢幕格式");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("直出代收回执（§2.4）：事实+可用动作，格式块归属声明在场；正文不推倒", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let nudgeCtx = "";
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["解衣", "磨墨", "奉砚"] })], { stopReason: "toolUse" }),
			// 列了路标却整拍直出（8/09 实弹形态）——代收，不推倒，去向归模型判断
			fauxAssistantMessage("她解衣取砚，磨墨奉上，一气呵成。"),
			(ctx: { messages?: unknown[] }) => {
				nudgeCtx = JSON.stringify(ctx.messages ?? []);
				return fauxAssistantMessage("");
			},
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开始吧。");

		assert.ok(nudgeCtx.includes("正文已代收为 draft_write。需要改就重交，不需要就结束。"), "代收回执 = 一句认收（零验收，8/10）");
		assert.ok(!nudgeCtx.includes("验收"), "回执无验收字样");
		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("一气呵成"), "直出正文仍代收落树（不推倒）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- P7：ask 工具（剧情共创决策） ----------------

test("台上清单：未注入询问接口时不含 ask", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }> }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("你好。");
			},
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");
		const names = (ctxs[0].tools ?? []).map((t) => t.name);
		assert.ok(!names.includes("ask"), "未注入 askUser 时 ask 不上清单");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("台上清单：即使配置 ask 并注入询问接口，仍不含 ask", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }> }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("你好。");
			},
			fauxScribeEmpty(),
		]);
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async () => "好",
		});
		await engine.performTurn("开演。");
		const names = (ctxs[0].tools ?? []).map((t) => t.name);
		assert.ok(!names.includes("ask"), "注入宿主询问接口也不向正文暴露 ask");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("台上不执行模型误发的 ask，未知工具不阻塞续写或丢失现稿", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let asked = 0;
		const contexts: string[] = [];
		const capture = (response: unknown) => (ctx: unknown) => { contexts.push(JSON.stringify(ctx)); return response; };
		reg.setResponses([
			capture(fauxAssistantMessage([fauxToolCall("ask", { question: "要如何继续？", options: ["甲", "乙"] })], { stopReason: "toolUse" })),
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["翻开账本", "补记账目"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "沈舟翻开账本，圈出两处漏记。" }), fauxToolCall("beat_step_done", { step: 1 })], { stopReason: "toolUse" }),
			capture(fauxAssistantMessage([fauxToolCall("ask", { question: "还要继续吗？", options: ["继续", "停止"] })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "云澜拿起笔，将欠缺的数字补进页边。" }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""), fauxScribeEmpty(),
		] as never);
		const engine = new StageEngine({
			cwd, getSessionManager: () => sm as never, getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}), streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async () => { asked++; throw new Error("正文不应调用宿主询问接口"); },
		});
		await engine.performTurn("继续。");
		assert.equal(asked, 0, "未装配工具不能调用宿主询问通道");
		assert.ok(contexts.some(ctx => ctx.includes("未知写侧工具 ask")), "误发 ask 按未知工具返回，不假装执行");
		const branch = JSON.stringify(sm.getBranch());
		assert.ok(branch.includes("沈舟翻开账本，圈出两处漏记。"));
		assert.ok(branch.includes("云澜拿起笔，将欠缺的数字补进页边。"));
	} finally {
		reg.unregister(); rmSync(cwd, { recursive: true, force: true });
	}
});

test("进度行场面包投影（8/12 skill指导删除后）：包名投影按数据在场；无数据=纯事实", async () => {
	const { progressLine } = await import("../src/stage/engine.ts");
	const { createWorkspace } = await import("../src/stage/workspace.ts");
	const ws = createWorkspace();
	ws.draft = "她推门进院。";
	ws.appends = 1;
	const bare = progressLine(ws);
	assert.ok(bare.startsWith("【进度】"), "事实前缀");
	assert.ok(!bare.includes("skill指导") && !bare.includes("场面包"), "无数据零注入（零痕迹）");
	assert.ok(!bare.includes("正文约") && !bare.includes("500") && !bare.includes("800"), "轮次进度不测量字数");
	const withPacks = progressLine(ws, ["情欲", "打斗"]);
	assert.ok(withPacks.includes("可读场面包：情欲 / 打斗"), "包名清单=数据投影");
	assert.ok(!withPacks.includes("skill_read"), "仅包名清单=被动投影，不含强制指令");
	assert.ok(withPacks.startsWith(bare.slice(0, bare.indexOf("。") + 1)), "事实前缀不因注入改变");
	// everyBeat skill：本拍首次落笔前读取一次，后续段落复用本拍上文内容
	const withForced = progressLine(ws, ["skill指导"], ["skill指导"]);
	assert.ok(withForced.includes("skill_read") && withForced.includes("skill指导"), "forcedSkills→落笔前强制先读指令");
});

test("引擎：已有稿段后中断，已接收正文仍落树且不记账", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段已经完整写下。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("第二段只写到一半", { stopReason: "aborted" }),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("继续。 ");
		const branch = sm.getBranch() as Array<{ type?: string; customType?: string; message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } }>;
		const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
		const text = assistant?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
		assert.match(text, /第一段已经完整写下/);
		assert.equal(text.match(/第一段已经完整写下/g)?.length, 1, "已受理稿段不能在中断收敛时重复拼接");
		assert.match(text, /第二段只写到一半/, "后续普通文本半截也应保留");
		assert.equal(assistant?.stopReason, "aborted");
		assert.equal(branch.some((entry) => entry.customType === "rp-state"), false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：后续 provider 报错时，已接收稿段按未完成回复落树", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段已经完整写下。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429" }),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("继续。");
		const branch = sm.getBranch() as Array<{ type?: string; customType?: string; message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> } }>;
		const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message;
		assert.equal(assistant?.stopReason, "aborted");
		assert.match(assistant?.content?.map((part) => part.text ?? "").join("") ?? "", /第一段已经完整写下/);
		assert.equal(branch.some((entry) => entry.customType === "rp-state"), false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("3000 字预设不进入 progress/verdict 注入，wordRange 只影响 provider 容量", async () => {
	const { progressLine, verdictInjection } = await import("../src/stage/engine.ts");
	const { createWorkspace } = await import("../src/stage/workspace.ts");
	const ws = createWorkspace();
	ws.draft = "正文。";
	ws.appends = 1;
	const sent = `${progressLine(ws)}\n${verdictInjection("凌云")}`;
	assert.doesNotMatch(sent, /2800|3000|3200|目标|正文约|\d+\s*字/);
	assert.equal(mainStageMaxTokens({ id: "x" }, { min: 2800, max: 3200 }), 8448);
});



test("引擎：谢幕不再点名格式块——输出格式归卡/预设作者的散文与正则（合约整链退场）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage("云澜垂眸受了半礼。")),
			cap(fauxAssistantMessage("")), // 封笔轮
			// 记账+尾巴同轮：world_state_update 工具调用，同一流里 text 尾巴（真实模型行为）
			cap(
				fauxAssistantMessage([
					{ type: "text", text: "<state1>\n地点：山门\n</state1>" },
					fauxToolCall("world_state_update", { patch: { location: "山门" } }),
				]),
			),
			fauxScribeEmpty(),
		] as never);
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp") as never,
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
		});
		await engine.performTurn("我上前行礼。");

		// 全仓库不再有任何提到状态栏/格式块的送模文案——谢幕注入整链退场
		assert.ok(!ctxs.some((t) => t.includes("【谢幕】")), "无谢幕注入");
		assert.ok(!ctxs.some((t) => t.includes("格式块")), "无格式块点名");
		// 合约文件不再生成
		assert.ok(!existsSync(join(cwd, ".liyuan", "output-contract.declared.json")), "不再声明落盘");
		assert.ok(!existsSync(join(cwd, ".liyuan", "output-contract.json")), "不再生成合约文件");
		// 作者标签随正文照常入稿（mergeFinalText 认块形不认名字）
		const tree = JSON.stringify(sm.getBranch());
		assert.ok(tree.includes("<state1>") && tree.includes("山门"), "作者标签入稿");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：关闭格式补全时不调用合约侧模型、不注入谢幕", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("正文。") as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			declareContract: true,
			outputContract: false,
		});
		await engine.performTurn("继续");
		assert.equal(reg.getPendingResponseCount(), 0, "主流程响应刚好用尽，不得多出合约声明侧调用");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("everyBeat skill 本拍首读一次即可，多段续写不重复受理门空转", async () => {
	const { cwd, sm } = makeStage();
	mkdirSync(join(cwd, "skills", "节奏"), { recursive: true });
	writeFileSync(join(cwd, "skills", "节奏", "SKILL.md"), "---\nname: 节奏\ndescription: 节奏指南\neveryBeat: true\n---\n先看动作因果。");
	writeFileSync(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", skills: ["guide.md"] }),
	);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("skill_read", { name: "节奏" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第二段。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("继续。 ");

		const branch = sm.getBranch() as Array<{ message?: { role?: string; details?: Record<string, unknown> } }>;
		const message = [...branch].reverse().find((entry) => entry.message?.role === "assistant")?.message;
		const metrics = message?.details?.rpWorkflow as { skillReads: number; appends: number; rounds: number };
		assert.equal(metrics.skillReads, 1);
		assert.equal(metrics.appends, 2);
		assert.ok(metrics.rounds >= 4);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow KPI 持久化到 assistant details", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("你好。") as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你好。 ");

		const branch = sm.getBranch() as Array<{ message?: { role?: string; details?: Record<string, unknown> } }>;
		const details = [...branch].reverse().find((entry) => entry.message?.role === "assistant")?.message?.details;
		const metrics = details?.rpWorkflow as Record<string, number>;
		assert.deepEqual(
			Object.keys(metrics).sort(),
			["appendRejects", "appends", "budgetReached", "durationMs", "edits", "firstCallMaxTokens", "lookups", "narrativeChars", "outputTokens", "overBudget", "perCallMaxTokens", "planWrites", "rounds", "skillReads", "textChannelChars", "thinkingChars", "writes"].sort(),
		);
		assert.equal(metrics.planWrites, 0, "寒暄直出不被机械计划强制");
		assert.equal(metrics.appends, 0);
		assert.equal(metrics.budgetReached, false);
		assert.equal(metrics.writes, 1);
		assert.equal(metrics.firstCallMaxTokens, Math.min(FIRST_CALL_MAX_TOKENS, Number((reg.getModel("faux-rp") as { maxTokens?: number }).maxTokens)));
		assert.ok(metrics.durationMs >= 0 && metrics.rounds >= 1);
		const inputComposition = details?.rpInputComposition as Record<string, number>;
		assert.ok(inputComposition.initialChars > 0);
		assert.ok(inputComposition.systemChars > 0);
		assert.ok(inputComposition.toolSchemaChars > 0);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("主剧情调用预算：maxTokens 是每次总输出上限，并给长正文留足空间", () => {
	assert.equal(mainStageMaxTokens({ id: "x" }), DEFAULT_MAIN_MAX_TOKENS);
	assert.equal(mainStageMaxTokens({ id: "x", maxTokens: 6000 }), 6000, "不超过模型声明的输出上限");
	assert.equal(mainStageMaxTokens({ id: "x" }, { min: 500, max: 800 }), 4096);
	assert.equal(mainStageMaxTokens({ id: "x" }, { min: 3000, max: 6000 }), 14048);
});

test("主剧情调用始终尊重模型声明的输出上限", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		] as never);
		const captured: number[] = [];
		const streamFn: StageStreamFn = (model, context, options) => {
			captured.push(Number(options?.maxTokens));
			return (streamSimple as unknown as StageStreamFn)(model, context, options);
		};
		const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => reg.getModel("faux-rp"), getAuth: async () => ({}), streamFn });
		await engine.performTurn("继续。 ");
		const cap = Number((reg.getModel("faux-rp") as { maxTokens?: number }).maxTokens);
		assert.equal(captured[0], cap);
		assert.equal(captured[1], cap, "后续演段同样不能越过模型上限");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("单拍可连续追加超过三段，旧固定段数上限不再截断", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const contexts: string[] = [];
		const capture = (response: unknown) => (ctx: unknown) => {
			contexts.push(JSON.stringify(ctx));
			return response;
		};
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第二段。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第三段。" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第四段不应入稿。" })], { stopReason: "toolUse" }),
			capture(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("继续。 ");

		const branch = sm.getBranch() as Array<{ message?: { role?: string; content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		const message = [...branch].reverse().find((entry) => entry.message?.role === "assistant")?.message;
		const body = message?.content?.map((part) => part.text ?? "").join("") ?? "";
		const metrics = message?.details?.rpWorkflow as Record<string, number>;
		assert.ok(body.includes("第一段") && body.includes("第三段"));
		assert.ok(body.includes("第四段不应入稿"), "第四段按新架构正常进入定稿");
		assert.equal(metrics.appends, 4);
		assert.equal(metrics.appendRejects, 0);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("长正文不触发旧软预算截断，后续 append 仍可追加", async () => {
	const { MAX_DRAFT_BODY_CHARS } = await import("../src/stage/workspace.ts");
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const contexts: string[] = [];
		const capture = (response: unknown) => (ctx: unknown) => {
			contexts.push(JSON.stringify(ctx));
			return response;
		};
		const accepted = "字".repeat(MAX_DRAFT_BODY_CHARS + 400);
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: accepted })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "超额段不应入稿。" })], { stopReason: "toolUse" }),
			capture(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("继续。 ");

		const branch = sm.getBranch() as Array<{ message?: { role?: string; content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		const message = [...branch].reverse().find((entry) => entry.message?.role === "assistant")?.message;
		const body = message?.content?.map((part) => part.text ?? "").join("") ?? "";
		const metrics = message?.details?.rpWorkflow as Record<string, number>;
		assert.ok(body.startsWith(accepted));
		assert.ok(body.includes("超额段"));
		assert.equal(metrics.appends, 2);
		assert.equal(metrics.appendRejects, 0, "软预算不拒收当前原子段");
		assert.equal(metrics.overBudget, false);
		assert.equal(metrics.budgetReached, false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("旧软预算退场后，后续 append/read/skill 仍按正常工具循环执行", async () => {
	const { MAX_DRAFT_BODY_CHARS } = await import("../src/stage/workspace.ts");
	const { MAX_ROUNDS } = await import("../src/stage/tools.ts");
	const { cwd, sm } = makeStage();
	mkdirSync(join(cwd, "skills", "节奏"), { recursive: true });
	writeFileSync(join(cwd, "skills", "节奏", "SKILL.md"), "---\nname: 节奏\ndescription: 节奏指南\neveryBeat: true\n---\n先看动作因果。");
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", skills: ["guide.md"] }));
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const contexts: Array<{ tools?: Array<{ name: string }> }> = [];
		const capture = (response: unknown) => (ctx: unknown) => {
			contexts.push(ctx as { tools?: Array<{ name: string }> });
			return response;
		};
		const accepted = "字".repeat(MAX_DRAFT_BODY_CHARS);
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("skill_read", { name: "节奏" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: accepted })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一次超额。" })], { stopReason: "toolUse" }),
			capture(fauxAssistantMessage([
				fauxToolCall("draft_append", { segment: "重复超额一。" }),
				fauxToolCall("draft_read", {}),
			], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage([
				fauxToolCall("draft_append", { segment: "重复超额二。" }),
				fauxToolCall("skill_read", { name: "节奏" }),
			], { stopReason: "toolUse" })),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("继续。 ");

		const branch = sm.getBranch() as Array<{ message?: { role?: string; content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		const message = [...branch].reverse().find((entry) => entry.message?.role === "assistant")?.message;
		const body = message?.content?.map((part) => part.text ?? "").join("") ?? "";
		const metrics = message?.details?.rpWorkflow as Record<string, number | boolean>;
		assert.ok(body.startsWith(accepted));
		assert.ok(body.includes("第一次超额") && body.includes("重复超额二"));
		assert.equal(metrics.budgetReached, false);
		assert.equal(metrics.appendRejects, 0, "软预算完整收稿，不制造拒收");
		assert.equal(metrics.skillReads, 2);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("旧绝对正文上限退场，超长原子段可完整落树", async () => {
	const { MAX_DRAFT_ABSOLUTE_CHARS } = await import("../src/stage/workspace.ts");
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let retryTools: string[] = [];
		const captureRetry = (ctx: unknown) => {
			retryTools = ((ctx as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
			return fauxAssistantMessage([
				fauxToolCall("draft_append", { segment: "池宽治是故事中的主要人物，一句话回答完毕。" }),
			], { stopReason: "toolUse" });
		};
		reg.setResponses([
			fauxAssistantMessage([
				fauxToolCall("draft_append", { segment: "字".repeat(MAX_DRAFT_ABSOLUTE_CHARS + 1) }),
			], { stopReason: "toolUse" }),
			captureRetry,
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("池宽治是谁？一句话。 ");

		assert.ok(retryTools.includes("draft_append") && retryTools.includes("draft_write"), "空稿拒收后写入口仍在");
		const branch = sm.getBranch() as Array<{ message?: { role?: string; content?: Array<{ text?: string }>; details?: Record<string, unknown> } }>;
		const message = [...branch].reverse().find((entry) => entry.message?.role === "assistant")?.message;
		const body = message?.content?.map((part) => part.text ?? "").join("") ?? "";
		assert.match(body, /池宽治/);
		assert.equal((message?.details?.rpWorkflow as Record<string, number>).appendRejects, 0);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("零稿纯状态栏不能落树，且不会进入 curtain 收束", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("<state1>地点：山门</state1>"),
			fauxAssistantMessage("```css\n.state { color: red; }\n```"),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("池宽治是谁？ ");
		const assistants = (sm.getBranch() as Array<{ message?: { role?: string } }>).filter(
			(entry) => entry.message?.role === "assistant",
		);
		assert.equal(assistants.length, 0, "状态栏/CSS 不得冒充 narrative 落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：regex-only 状态栏直接由作者正则格式计划驱动，不恢复旧 output-contract", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-eng-contract-upgrade-"));
	writeFileSync(
		join(cwd, "card.json"),
		JSON.stringify({
			data: {
				name: "云澜",
				description: "{{user}}的师姐",
				first_mes: "你来了。",
				extensions: {
					regex_scripts: [{
						scriptName: "状态栏",
						findRegex: "/<comprehensive_now_status>[\\s\\S]*?<\\/comprehensive_now_status>/g",
						replaceString: "<div>很大的 HTML replacement 不应成为声明材料</div>",
					}],
				},
			},
		}),
	);
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan", "output-contract.json"), '{"modules":[]}');
	writeFileSync(join(cwd, ".liyuan", "output-contract.gen.json"), '{"modules":[]}');
	writeFileSync(
		join(cwd, ".liyuan", "output-contract.declared.json"),
		JSON.stringify({ fingerprint: "legacy", modules: [] }),
	);
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let curtainCtx = "";
		reg.setResponses([
			fauxAssistantMessage("云澜推开院门。"),
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			fauxScribeEmpty(),
			(ctx: { messages?: unknown[] }) => {
				curtainCtx = JSON.stringify(ctx.messages ?? []);
				return fauxAssistantMessage("<comprehensive_now_status>院内</comprehensive_now_status>");
			},
		] as never);
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp") as never,
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			declareContract: true,
		});
		await engine.performTurn("进院。 ");

		assert.ok(curtainCtx.includes("comprehensive_now_status"), "作者正则 findRegex 进入有界格式计划");
		assert.ok(!curtainCtx.includes("很大的 HTML replacement"), "不送料巨大 replacement");
		assert.equal(readFileSync(join(cwd, ".liyuan", "output-contract.json"), "utf8"), '{"modules":[]}', "旧合约文件不再被引擎读取或改写");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("主演请求：预设与工作流分开署名，主角可自然行动且正文不被结尾黑名单改写", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		mkdirSync(join(cwd, "skills", "主演分段演出"), { recursive: true });
		writeFileSync(join(cwd, "skills", "主演分段演出", "SKILL.md"), readFileSync(new URL("../skills/主演分段演出/SKILL.md", import.meta.url), "utf8"));
		const presetText = "按小说自然发展，沈舟可以依据既有人设做出日常决定，不要每次停下来等用户回应。";
		writeFileSync(join(cwd, "preset.json"), JSON.stringify({ name: "合成小说预设", blocks: [{ id: "narrative", name: "叙事边界", role: "system", channel: "resident", enabled: true, content: presetText }] }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟", creationMode: "ask" }));
		const contexts: string[] = [];
		const capture = (response: unknown) => (ctx: unknown) => {
			contexts.push(JSON.stringify(ctx));
			return response;
		};
		const first = "沈舟把折好的信收进外套内袋，答应先核对账目。\n\n云澜将桌上的账本推了过去。";
		const second = "他翻到末页，把两处数字圈出来。\n\n云澜看向你，接过笔，在页边补下漏记的一笔。";
		reg.setResponses([
			capture(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["收好信件并核对账目", "找出漏记的一笔"] })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage([fauxToolCall("draft_append", { segment: first }), fauxToolCall("beat_step_done", { step: 1 })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage([fauxToolCall("draft_append", { segment: second }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage("")),
			fauxScribeEmpty(),
		] as never);
		let asked = 0;
		const engine = new StageEngine({
			cwd, getSessionManager: () => sm as never, getModel: () => reg.getModel("faux-rp") as never,
			getAuth: async () => ({}), streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async () => { asked++; return undefined; },
		});
		await engine.performTurn("继续当前场景，主角可以作出符合人设的日常决定。");
		assert.equal(asked, 0);
		assert.ok(contexts[0].includes(presetText), "预设原文不被系统重写");
		assert.ok(contexts[0].includes("【主演工作流】"), "真实 writer 请求装入独立署名的系统工作流");
		assert.ok(!contexts[0].includes("代写边界") && !contexts[0].includes("重大未决"), "不再添加相反的叙事许可/确认规则");
		assert.ok(contexts.some(ctx => ctx.includes("【分段回看】")), "分段回看仍执行");
		for (const ctx of contexts) {
			assert.ok(!ctx.includes("到了玩家接话处用 draft_seal"));
			assert.ok(!ctx.includes("续写的自然下文涉及用户的行动或选择"));
			assert.ok(!ctx.includes("不得替用户决定未表达的思想或行动"));
		}
		const reply = sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(reply && reply.type === "message");
		assert.equal((reply.message.details as Record<string, unknown>).rpNarrative, `${first}\n\n${second}`, "正常主角言行和有剧情依据的看向你原样落树，修正不删改正文");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});
