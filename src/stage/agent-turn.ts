/** 双模式的单一正文所有者。专家调用由主 Agent 发起，但固定阶段由收据门禁保证。 */
import { isNativeToolsUnsupported } from "./model-failure.ts";
import { applyDraftEdits } from "../draft.ts";
import type { AssistantMsgLike, StageStreamEvent } from "./engine.ts";
import type { StageTool } from "./tools.ts";
import type { DirectorPhase, DirectorTask, DirectorReport } from "./agent-director.ts";
import { DIRECTOR_ROLES, formatDirectorReports } from "./agent-director.ts";
import type { GenerationMode, GenerationWorkflow } from "./generation-mode.ts";

type Message = Record<string, unknown>;
export interface AgentTurnOptions {
	mode: GenerationMode;
	systemPrompt: string;
	messages: unknown[];
	readTools: StageTool[];
	directorPrompt: string;
	stream: (context: { systemPrompt: string; messages: unknown[]; tools?: StageTool[] }, signal?: AbortSignal) => AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike> };
	read: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string; isError?: boolean }>;
	experts: (phase: DirectorPhase, tasks: DirectorTask[], draft?: string, signal?: AbortSignal) => Promise<DirectorReport[]>;
	signal?: AbortSignal;
	isCurrent: () => boolean;
	onDelta?: (text: string, reset: boolean) => void;
	onThinking?: (text: string) => void;
	onResync?: (text: string) => void;
	onActivity?: (text: string) => void;
	toolsSupported?: boolean;
	timeoutMs?: number;
	/** Engine strict default; legacy library callers may explicitly keep degraded delivery. */
	allowDegraded?: boolean;
	normalizeNarrative?: (text: string) => string;
	outputRecoveryPrompt?: string;
	toolProtocolRecoveryPrompt?: string;
}
export interface AgentTurnResult {
	narrative: string;
	authorDraft: string;
	final: AssistantMsgLike | null;
	aborted: boolean;
	error?: string;
	workflow: GenerationWorkflow;
}
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): StageTool => ({ name, description, parameters: { type: "object", properties, required } });
const FLOW_TOOLS: StageTool[] = [
	tool("get_draft", "读取当前尚未定稿的稿件。"),
	tool("consult_experts", "执行当前固定专家阶段。tasks 包含本阶段所有岗位各一次，返回报告，不修改正文。", { tasks: { type: "array", items: { type: "object", properties: { role: { type: "string" }, task: { type: "string" } }, required: ["role", "task"] } } }, ["tasks"]),
	tool("begin_narrative", "开始正文通道；下一次普通文本输出作为草稿。"),
	tool("begin_revision", "开始修订通道；下一次普通文本输出替换尚未定稿的完整草稿。"),
	tool("apply_draft_edits", "定点修改尚未定稿的草稿。每项 old 必须唯一匹配；任何一项失败整批不套用。", { edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] } } }, ["edits"]),
	tool("finalize", "将当前草稿定稿。需固定阶段收据。专家审阅失败时只有明确 acceptDegraded=true 才可降级交付；不要求修订。", { acceptDegraded: { type: "boolean" } }),
];
const now = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const textOf = (msg: AssistantMsgLike | null): string => (msg?.content ?? []).filter(x => x.type === "text").map(x => x.text ?? "").join("");
type AgentPhase = "evidence" | "ideas" | "ready" | "writing" | "review" | "decision" | "revision" | "finished";
const cancelled = (o: AgentTurnOptions) => o.signal?.aborted === true || !o.isCurrent();
const textualProtocol = (value: string) => /^\s*(?:<tool_call>|<function_call>|<\|?DSML\|?|<｜DSML｜|(?:draft_append|draft_write|consult_experts|finalize)\s*\()/i.test(value)
	|| /<(?:tool_call|function_call)>\s*\{[\s\S]*?"(?:name|arguments)"\s*:/i.test(value);
/** Structural incompleteness, not a word/style blacklist. Only the author continues it. */
export function narrativeNeedsCompletion(text:string,stopReason?:string):boolean {
	if(stopReason==="length")return true;
	return [["“","”"],["「","」"],["『","』"]].some(([open,close])=>text.split(open).length>text.split(close).length);
}

export async function runAgentTurn(o: AgentTurnOptions): Promise<AgentTurnResult> {
	const originalSignal = o.signal;
	const deadline = AbortSignal.timeout(Math.max(1, Math.min(7200_000, o.timeoutMs ?? (o.mode === "director" ? 3600_000 : 1800_000))));
	o = { ...o, signal: originalSignal ? AbortSignal.any([originalSignal, deadline]) : deadline };
	const workflow: GenerationWorkflow = { version: 1, mode: o.mode, stages: [], writerRounds: 0, toolFallback: o.toolsSupported === false };
	const convo: unknown[] = [...o.messages];
	let final: AssistantMsgLike | null = null, draft = "", revisionDraft = "", error: string | undefined;
	let nativeProtocolRetries = 0;
	let failedReview = false, completionAttempts = 0, completionPending = false, completionBuffer = "";
	const mainThoughts: string[] = [];
	let phase: AgentPhase = o.mode === "director" ? "evidence" : "writing";
	const isPhase = (...values: AgentPhase[]) => values.includes(phase);
	const readNames = new Set(o.readTools.map(x => x.name));
	const normalizeDraft = (text:string) => o.normalizeNarrative ? o.normalizeNarrative(text) : text;
	const receipts = (stage: GenerationWorkflow["stages"][number]["stage"], status: GenerationWorkflow["stages"][number]["status"], calls: number) => workflow.stages.push({ stage, status, calls });
	const exactEdits = (edits: unknown): boolean => Array.isArray(edits) && edits.length > 0 && edits.every(e => { if (!e || typeof e.old !== "string" || !e.old || typeof e.new !== "string") return false; const at = draft.indexOf(e.old); return at >= 0 && draft.indexOf(e.old, at + 1) < 0; });
	const canFinalize = () => o.mode === "direct" || workflow.stages.some(x => x.stage === "review");
	const protocol = (): string => {
		if (phase === "evidence" || phase === "ideas" || phase === "review") return `【流程阶段】${phase}。本阶段岗位：${DIRECTOR_ROLES[phase].join(" / ")}。使用 consult_experts，tasks 为这些岗位各一项；所有结果均是报告。`;
		if (phase === "ready") return "【流程阶段】资料阶段完成。用 begin_narrative 切入正文通道。";
		if (phase === "decision") return "【流程阶段】审阅已完成。无需修改可 finalize；修改可 apply_draft_edits 或 begin_revision。";
		return "";
	};
	if (o.mode === "director") { const input = convo.pop(); convo.push(now(`${o.directorPrompt}\n\n${protocol()}`)); if (input) convo.push(input); }

	async function owned<T>(promise: Promise<T>): Promise<T> {
		if (cancelled(o)) { void promise.catch(() => undefined); throw new Error("本拍取消、超时或分支改变"); }
		return await new Promise<T>((resolve, reject) => {
			const stop = () => { cleanup(); reject(new Error("本拍取消、超时或分支改变")); };
			const watch = setInterval(() => { if (cancelled(o)) stop(); }, 100);
			const cleanup = () => { clearInterval(watch); o.signal?.removeEventListener("abort", stop); };
			o.signal?.addEventListener("abort", stop, { once: true });
			promise.then(value => { cleanup(); if (cancelled(o)) reject(new Error("迟到结果未采用")); else resolve(value); }, err => { cleanup(); reject(err); });
		});
	}

	async function request(tools: StageTool[] | undefined, narrative: boolean): Promise<{ message: AssistantMsgLike | null; text: string; error?: string }> {
		if (cancelled(o)) return { message: null, text: "", error: "本拍已取消或分支改变" };
		workflow.writerRounds++;
		const priorDraft = narrative ? (phase === "writing" ? draft + (completionPending ? completionBuffer : "") : phase === "revision" ? revisionDraft : "") : "";
		let text = "", thought = "", message: AssistantMsgLike | null = null, failure: string | undefined;
		try {
			const stream = o.stream({ systemPrompt: o.systemPrompt, messages: convo, ...(tools?.length ? { tools } : {}) }, o.signal);
			const iterator = stream[Symbol.asyncIterator]();
			try { while (true) {
				const next = await owned(iterator.next()); if (next.done) break; const event = next.value;
				if (cancelled(o)) break;
				if (event.type === "text_delta" && event.delta) {
					const first = text.length === 0; text += event.delta;
					if (narrative) o.onDelta?.(event.delta, first && !priorDraft);
				} else if (event.type === "thinking_delta" && event.delta) { thought += event.delta; o.onThinking?.(event.delta); }
				else if (event.type === "done") message = event.message ?? null;
				else if (event.type === "error") { message = event.error ?? null; failure = message?.errorMessage || "主演请求失败"; break; }
			}
			} finally { void Promise.resolve(iterator.return?.()).catch(() => undefined); }
			if (!message && !cancelled(o) && !failure) failure = "主演流未返回最终消息";
			if (!text && message && !cancelled(o)) { text = textOf(message); if (narrative && text) o.onDelta?.(text, !priorDraft); }
			if (!thought && message && !cancelled(o)) { thought = message.content.filter(x => x.type === "thinking").map(x => x.thinking ?? "").join(""); if (thought) o.onThinking?.(thought); }
			if (message?.stopReason === "error") failure = message.errorMessage || "主演请求失败";
			if (message?.stopReason === "aborted") failure = message.errorMessage || "主演请求中断";
		} catch (err) { failure = err instanceof Error ? err.message : String(err); }
		if (thought) mainThoughts.push(thought);
		if (textualProtocol(text) || (message?.stopReason === "toolUse" && !message.content.some(item => item.type === "toolCall"))) { failure = "API返回文本化工具协议或空工具调用，未作为正文接收"; text = ""; if (narrative) o.onResync?.(priorDraft); }
		if (narrative && (cancelled(o) || failure) && text.trim()) draft = completionPending ? draft + normalizeDraft(completionBuffer + text) : priorDraft + text;
		return { message, text, ...(failure ? { error: failure } : {}) };
	}

	async function batch(p: DirectorPhase, tasks: DirectorTask[]): Promise<string> {
		const roles = DIRECTOR_ROLES[p];
		if (tasks.length !== roles.length || roles.some(role => tasks.filter(task => task.role === role).length !== 1)) return `未执行：本阶段必须恰好包含 ${roles.join(" / ")} 各一次。`;
		const rawResults = await owned(o.experts(p, tasks, p === "review" ? draft : undefined, o.signal));
		const results = roles.map(role => {
			const matches = rawResults.filter(report => report.role === role);
			return matches.length === 1 && ["success", "degraded", "failed"].includes(matches[0].status)
				? matches[0] : { role, status: "failed" as const, summary: "岗位回执缺失或重复，未当成成功。", facts: [], inferences: [], candidates: [], issues: [] };
		});
		if (p === "review") failedReview = results.some(report => report.status === "failed");
		if (cancelled(o)) throw new Error("专家结果已丢弃：回合取消或分支改变");
		receipts(p, results.some(x => x.status === "failed") && o.allowDegraded === false ? "failed" : results.some(x => x.status !== "success") ? "degraded" : "success", roles.length);
		if (o.allowDegraded === false && results.some(x => x.status === "failed")) throw new Error(`固定${p}阶段仍有失败岗位：${results.filter(x => x.status === "failed").map(x=>x.role).join("、")}。已诊断并尝试恢复，未跳过进入下一阶段。`);
		phase = p === "evidence" ? "ideas" : p === "ideas" ? "ready" : "decision";
		o.onActivity?.(`${p === "evidence" ? "固定资料分析" : p === "ideas" ? "双角度构思" : "固定成稿审阅"}${results.some(x => x.status !== "success") ? "已结束（部分报告降级）" : "已完成"}`);
		return `${formatDirectorReports(results)}\n\n${protocol()}`;
	}

	async function plainFallback(reason: "configured" | "unsupported"): Promise<void> {
		workflow.toolFallback = true;
		workflow.toolFallbackReason = reason;
		o.onActivity?.("主演工具协议不可用：固定阶段使用文本通道接续，未切换创作模式");
		if (o.mode === "director") {
			for (const p of ["evidence", "ideas"] as const) {
				if (workflow.stages.some(x => x.stage === p)) continue;
				let tasks: DirectorTask[] = DIRECTOR_ROLES[p].map(role => ({ role, task: "依据本拍输入和来源材料完成该岗位报告。" }));
				if (p === "ideas") {
					// Preserve main ownership of angle selection even without native function tools.
					convo.push(now('【文本流程协议】当前 ideas 阶段。以 JSON 返回两份任务简报，不输出正文：{"tasks":[{"role":"idea-a","task":"角度简报"},{"role":"idea-b","task":"另一个角度简报"}]}。'));
					const planned = await request(undefined, false);
					if (planned.error || cancelled(o)) { error = planned.error; return; }
					try {
						const value = JSON.parse(planned.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
						if (!Array.isArray(value.tasks) || value.tasks.length !== 2 || DIRECTOR_ROLES.ideas.some(role => value.tasks.filter((x: DirectorTask) => x?.role === role).length !== 1)
							|| value.tasks.some((x: DirectorTask) => typeof x.task !== "string" || !x.task.trim()) || value.tasks[0].task.trim() === value.tasks[1].task.trim()) throw new Error("角度简报无效");
						tasks = value.tasks.map((x: DirectorTask) => ({ role: x.role, task: x.task.slice(0, 2000) }));
					} catch { error = "文本角度简报不可解析或岗位不完整，未执行无差别构思"; return; }
					if (planned.message) convo.push(planned.message);
				}
				convo.push(now(await batch(p, tasks)));
			}
		}
		phase = "writing";
		convo.push(now("【正文通道】资料已就绪，直接输出本拍完整正文。"));
		const initial = await request(undefined, true); final = initial.message;
		if (initial.error || cancelled(o)) { error = initial.error; return; }
		draft = initial.text.trim(); if (!draft) { error = "主演未返回正文"; return; }
		receipts("draft", "success", 1);
		if (o.mode === "director") {
			phase = "review";
			const reviewResult = await batch("review", DIRECTOR_ROLES.review.map(role => ({ role, task: "核对当前未定稿正文，只报告有依据的问题。" })));
			if (cancelled(o)) return;
			const previous = draft;
			convo.push(final!); convo.push(now(`【定稿决策】\n${reviewResult}\n\n只返回 JSON：无需修订时 {"decision":"keep"}，需要修订时 {"decision":"revise","edits":[{"old":"唯一原文","new":"替换文本"}]}；专家请求失败时另须显式提供 "acceptDegraded":true 才能降级交付。当前草稿：\n${draft}`));
			const decision = await request(undefined, false); final = decision.message ?? final;
			if (decision.error) { error = decision.error; return; }
			try {
				const row = JSON.parse(decision.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
				if (!["keep", "revise"].includes(row.decision)) throw new Error("无效定稿决策");
				if (failedReview && row.acceptDegraded !== true) { error = "审阅请求失败，尚未形成明确的降级定稿决策"; return; }
				if (row.decision === "revise") {
					const edited = exactEdits(row.edits) ? applyDraftEdits(draft, row.edits) : { ok: false, text: undefined };
					if (edited.ok && typeof edited.text === "string") draft = edited.text;
					else { receipts("revision", "failed", 0); error = "文本修订未通过唯一原文定位，保留原稿但不冒称已完成定稿"; return; }
				}
			} catch { error = "文本定稿决策不可解析，保持原始草稿但不冒称已定稿"; o.onActivity?.(error); return; }
			if (draft !== previous) { receipts("revision", "success", 1); o.onResync?.(draft); }
		}
		phase = "finished"; receipts("finalize", workflow.stages.some(x => x.status === "degraded") ? "degraded" : "success", 0);
	}

	try {
		if (o.toolsSupported === false) await plainFallback("configured");
		else for (let round = 0; round < (o.mode === "director" ? 24 : 8) && !cancelled(o) && phase !== "finished"; round++) {
			const writing = phase === "writing" || phase === "revision";
			if(completionPending && o.outputRecoveryPrompt) {
				const repair=await request(undefined,false);final=repair.message??final;
				if(repair.error){error=repair.error;break;}
				try { const value=JSON.parse(repair.text.trim().replace(/^```(?:json)?\s*|\s*```$/g,""));if(typeof value.suffix!=="string"||!value.suffix.trim()||textualProtocol(value.suffix))throw new Error("invalid suffix");draft+=normalizeDraft(value.suffix); }
				catch{error="主作者输出恢复回执无效，保留未完成原稿，不捏造续写";break;}
				if(narrativeNeedsCompletion(draft)){error="主作者接续后对白仍未闭合，保留未完成稿，不冒称定稿";break;}
				completionPending=false;completionBuffer="";receipts("draft","success",1);o.onResync?.(draft);
				if(o.mode==="direct"){phase="finished";receipts("finalize","success",0);}else{phase="review";convo.push(now(protocol()));}
				continue;
			}
			const available = o.mode === "director" && !writing ? [...o.readTools, ...FLOW_TOOLS] : o.readTools;
			const result = await request(available, writing); final = result.message ?? final;
			if (result.error) {
				if (!draft && isNativeToolsUnsupported(result.error) && !workflow.toolFallback) { await plainFallback("unsupported"); break; }
				if (result.error.includes("文本化工具协议") && nativeProtocolRetries++ < 1 && o.toolProtocolRecoveryPrompt) {
					convo.push(now(o.toolProtocolRecoveryPrompt + "\n" + JSON.stringify({ phase, error: "malformed_native_tool_protocol", toolsSupported: true })));
					o.onActivity?.("原生工具回执无效：同一API重新提交一次，不切文本协议");
					continue;
				}
				error = result.error; break;
			}
			if (cancelled(o)) break;
			const calls = (result.message?.content ?? []).filter(x => x.type === "toolCall");
			if (calls.length === 0) {
				if (writing && result.text.trim()) {
					const revision = phase === "revision"; const rawDraft = revision ? revisionDraft + result.text.trim() : completionPending ? draft + normalizeDraft(completionBuffer + result.text.trim()) : draft + result.text.trim(); draft = rawDraft; revisionDraft = ""; completionPending=false;completionBuffer=""; if(draft!==rawDraft)o.onResync?.(draft);
					if(narrativeNeedsCompletion(normalizeDraft(draft),result.message?.stopReason)) {
						if(completionAttempts++>=2){error="正文仍以未闭合对白/供应商截断结束；已保留未完成稿，不冒称定稿";break;}
						if(result.message)convo.push({...result.message,content:[...(result.message.content??[]).filter(x=>x.type!=="text"),{type:"text",text:rawDraft}]});
						convo.push(now((o.outputRecoveryPrompt??"【输出恢复】")+"\n"+JSON.stringify({reason:"unclosed_quote_or_provider_length",draftIsPartial:true,operation:"continue_narrative",tail:draft.slice(-800)})));
						phase="writing";completionPending=true;completionBuffer="";continue;
					}
					receipts(revision ? "revision" : "draft", "success", 1);
					if (revision) o.onResync?.(draft);
					if (o.mode === "direct") { phase = "finished"; receipts("finalize", workflow.stages.some(x => x.status === "degraded") ? "degraded" : "success", 0); }
					else { phase = revision ? "decision" : "review"; convo.push(result.message!); convo.push(now(protocol())); }
				} else { if (result.message) convo.push(result.message); convo.push(now(protocol() || "当前正文通道未收到内容。")); }
				continue;
			}
			// 正文通道中，工具前后的主 Agent文字连续保留；准备通道文字不入稿。
			if (writing && result.text) { if (phase === "revision") { revisionDraft += result.text; draft = revisionDraft; } else if(completionPending)completionBuffer+=result.text;else draft += result.text; }
			if (result.message) convo.push(result.message);
			let transitionAccepted = false;
			for (const call of calls) {
				if (cancelled(o) || phase === "finished") break;
				const beforePhase = phase;
				const name = call.name ?? "", args = call.arguments ?? {};
				let text: string;
				if (transitionAccepted && FLOW_TOOLS.some(t => t.name === name && t.name !== "get_draft")) text = "未执行：本生成轮已受理一次阶段转换，读取回执后下一轮继续。";
				else if (name === "get_draft" && o.mode === "director") text = draft;
				else if (readNames.has(name)) text = (await owned(o.read(name, args, o.signal))).text;
				else if (name === "consult_experts" && o.mode === "director" && isPhase("evidence", "ideas", "review")) {
					const tasks = Array.isArray(args.tasks) ? args.tasks.map(raw => ({ role: String((raw as Record<string, unknown>)?.role ?? ""), task: String((raw as Record<string, unknown>)?.task ?? "").slice(0, 2000) })) as DirectorTask[] : [];
					text = await batch(phase as DirectorPhase, tasks);
				} else if (name === "begin_narrative" && isPhase("ready")) { phase = "writing"; text = "正文通道已开启。下一轮普通文本为正文草稿。"; }
				else if (name === "begin_revision" && phase === "decision") { revisionDraft = ""; phase = "revision"; text = "修订通道已开启，下一轮普通文本替换尚未定稿的草稿。"; }
				else if (name === "apply_draft_edits" && phase === "decision") {
					transitionAccepted = true; // Always read the mutation receipt before deciding to finalize.
					const edited = exactEdits(args.edits) ? applyDraftEdits(draft, args.edits as never) : { ok: false, text: undefined };
					if (edited.ok && typeof edited.text === "string") { draft = edited.text; receipts("revision", "success", 0); o.onResync?.(draft); text = "定点修改已应用。"; }
					else text = "修改未受理：原文定位失败，整批保持不变。";
				} else if (name === "finalize" && phase === "decision" && draft && canFinalize()) {
					if (failedReview && args.acceptDegraded !== true) text = "专家审阅未成功；需明确 acceptDegraded=true 才能降级交付，不当作审阅通过。";
					else { phase = "finished"; receipts("finalize", workflow.stages.some(x => x.status === "degraded") ? "degraded" : "success", 0); text = "当前草稿已定稿。"; }
				}
				else text = `未执行工具 ${name}：当前阶段 ${phase}，不允许越过固定阶段或修改已定稿内容。`;
				if (phase !== beforePhase) transitionAccepted = true;
				convo.push({ role: "toolResult", toolCallId: (call as { id?: string }).id, toolName: name, content: [{ type: "text", text }], timestamp: Date.now() });
			}
		}
		if (!cancelled(o) && phase !== "finished" && !error) error = "主 Agent达到流程轮数预算，未完成固定阶段；保留未完成草稿，不冒称定稿";
	} catch (err) { error = err instanceof Error ? err.message : String(err); }
	if (deadline.aborted && !originalSignal?.aborted) error = "Agent总体时间预算耗尽，保留已写内容但不冒称定稿";
	const aborted = cancelled(o) || phase !== "finished";
	if (draft) final = { ...(final ?? { role: "assistant", content: [] }), role: "assistant", content: [...mainThoughts.map(thinking => ({ type: "thinking", thinking })), { type: "text", text: draft }], stopReason: aborted ? "aborted" : "stop", ...(error ? { errorMessage: error } : {}) };
	return { narrative: normalizeDraft(draft), authorDraft: draft, final, aborted, ...(error ? { error } : {}), workflow };
}
