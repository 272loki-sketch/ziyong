import type { BranchEntryLike } from "./assemble.ts";
import { projectTurnPerformance, TURN_PERFORMANCE_ENTRY_TYPE, type TurnPerformance } from "./performance.ts";

export type DiagnosticStatus = "success" | "degraded" | "skipped" | "reused" | "failed" | "committed" | "rejected" | "pending" | "stable" | "unavailable" | "approved";

export interface TurnDiagnosticStage {
	 id: string;
	 label: string;
	 status: DiagnosticStatus;
	 summary: string;
	 details?: Record<string, unknown>;
}

export interface TurnDiagnosticView {
	 version: 1;
	 entryId: string;
	 narrativeChars: number;
	 curtainChars: number;
	 timeline: { thinking: number; tools: number; text: number };
	 stages: TurnDiagnosticStage[];
	performance?: TurnPerformance;
	artifacts: {
		prep?: Record<string, unknown>;
		workflow?: Record<string, unknown>;
		contextPreflight?: Record<string, unknown>;
		curtain?: string;
		curtainTruncated?: boolean;
		patchAudit?: unknown[];
		commits: Array<{ type: string; status?: DiagnosticStatus; summary: string; data?: Record<string, unknown> }>;
	};
}

export interface TurnDiagnosticsView {
	version: 1;
	turns: TurnDiagnosticView[];
}

export interface TurnRuntimeDiagnostic {
	outline?: { status: DiagnosticStatus; summary: string };
}

const MAX_TURNS = 20;
const MAX_TEXT = 240;
const MAX_LIST = 8;
const MAX_CURTAIN = 32_000;
const MAX_COMMITS = 32;

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, max = MAX_TEXT): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function list(value: unknown, max = MAX_LIST): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, MAX_TEXT)).filter(Boolean).slice(0, max) : [];
}

function status(value: unknown, fallback: DiagnosticStatus): DiagnosticStatus {
	return ["success", "degraded", "skipped", "reused", "failed", "committed", "rejected", "pending", "stable", "unavailable", "approved"].includes(String(value))
		? value as DiagnosticStatus
		: fallback;
}

function customData(entry: BranchEntryLike): Record<string, unknown> | undefined {
	return recordOf(entry.data);
}

function commitSummary(type: string, data: Record<string, unknown> | undefined): string {
	if (!data) return "已写入分支条目";
	if (type === "rp-world-audit") {
		const audit = recordOf(data.audit);
		const auditSummary = text(audit?.summary);
		if (auditSummary) return auditSummary;
		const errors = list(data.errors, 3);
		if (errors.length) return errors.join("；");
	}
	if (type === "rp-ecology-state") {
		const degraded = recordOf(data.degraded);
		if (degraded) return `生态降级：${text(degraded.error) || "未记录原因"}`;
	}
	for (const key of ["digest", "summary", "message", "reason", "status", "verdict"]) {
		const value = text(data[key]);
		if (value) return value;
	}
	if (type === "rp-state") return "角色账本已提交";
	if (type === "rp-world-state") return "世界快照已提交";
	if (type === "rp-ecology-state") return "生态快照已提交";
	return "已写入分支条目";
}

function safeFields(source: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
	if (!source) return undefined;
	const output: Record<string, unknown> = {};
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string") output[key] = value.slice(0, MAX_TEXT);
		else if (typeof value === "number" || typeof value === "boolean") output[key] = value;
		else if (Array.isArray(value)) output[key] = value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, MAX_TEXT)).slice(0, MAX_LIST);
	}
	return Object.keys(output).length ? output : undefined;
}

function safePatchAudit(value: unknown): unknown[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 24).flatMap((item) => {
		const row = recordOf(item);
		if (!row) return [];
		const fields = Array.isArray(row.fields) ? row.fields.filter((field): field is string => typeof field === "string").slice(0, 8) : [];
		const lore = Array.isArray(row.lore) ? row.lore.flatMap((raw) => {
			const item = recordOf(raw);
			return item && typeof item.fingerprint === "string" ? [{ fingerprint: item.fingerprint.slice(0, MAX_TEXT) }] : [];
		}).slice(0, 8) : [];
		return [{
			...(typeof row.character === "string" ? { character: row.character.slice(0, MAX_TEXT) } : {}),
			...(fields.length ? { fields } : {}),
			...(lore.length ? { lore } : {}),
			...(typeof row.verification === "string" ? { verification: row.verification.slice(0, MAX_TEXT) } : {}),
		}];
	});
}

function stage(id: string, label: string, value: unknown, fallback: DiagnosticStatus, summary: string, details?: Record<string, unknown>): TurnDiagnosticStage {
	return { id, label, status: status(value, fallback), summary, ...(details ? { details } : {}) };
}

function diagnosticFor(branch: BranchEntryLike[], index: number, entry: BranchEntryLike, runtime?: TurnRuntimeDiagnostic): TurnDiagnosticView {
	const message = recordOf(entry.message);
	const details = recordOf(message?.details) ?? {};
	const prep = recordOf(details.rpPrep);
	const workflow = recordOf(details.rpWorkflow);
	const prepStatus = recordOf(prep?.workflowStatus) ?? {};
	const memoryRecall = recordOf(prep?.memoryRecall);
	const timeline = Array.isArray(details.rpTimeline) ? details.rpTimeline : [];
	const counts = timeline.reduce((result, item) => {
		const row = recordOf(item);
		const kind = text(row?.kind);
		if (kind === "thinking") result.thinking++;
		else if (kind === "tool") result.tools++;
		else if (kind === "text") result.text++;
		return result;
	}, { thinking: 0, tools: 0, text: 0 });
	const narrativeRaw = typeof details.rpNarrative === "string" ? details.rpNarrative.trim() : "";
	let curtainRaw = typeof details.rpCurtain === "string" ? details.rpCurtain.trim() : "";
	const commits: TurnDiagnosticView["artifacts"]["commits"] = [];
	let outlineReconcileSeen = false;
	let scribeDiagnostic: Record<string, unknown> | undefined;
	let memoryDiagnostic: Record<string, unknown> | undefined;
	let performance: TurnPerformance | undefined;
	for (let i = index + 1; i < branch.length; i++) {
		const next = branch[i];
		if (next.type === "user" || next.message?.role === "user" || next.message?.role === "assistant") break;
		if (next.type === "custom" && next.customType === TURN_PERFORMANCE_ENTRY_TYPE) {
			performance = projectTurnPerformance(next.data, entry.id ?? "") ?? performance;
			continue;
		}
		if (next.type === "custom" && next.customType === "rp-turn-diagnostic") {
			const data = customData(next);
			if (text(data?.sourceEntryId) === entry.id && text(data?.stage) === "scribe") scribeDiagnostic = data;
			if (text(data?.sourceEntryId) === entry.id && text(data?.stage) === "memory") memoryDiagnostic = data;
			continue;
		}
		if (next.type === "custom" && next.customType === "rp-curtain-override") {
			const data = customData(next);
			if (text(data?.targetEntryId) === entry.id && typeof data?.curtain === "string") curtainRaw = data.curtain.trim();
			continue;
		}
		if (next.type !== "custom" || !next.customType || !["rp-state", "rp-world-audit", "rp-world-state", "rp-ecology-state", "rp-outline-proposal", "rp-outline"].includes(next.customType)) continue;
		const data = customData(next);
		const sourceEntryId = text(data?._diagnosticSourceEntryId);
		if (["rp-state", "rp-world-state", "rp-ecology-state"].includes(next.customType) && sourceEntryId !== entry.id) continue;
		if (next.customType === "rp-world-audit" && text(data?.narrativeEntryId) !== entry.id) continue;
		if (["rp-outline-proposal", "rp-outline"].includes(next.customType)) {
			const proposal = recordOf(data?.proposal);
			if (next.customType === "rp-outline-proposal" && text(proposal?.kind) !== "reconcile") continue;
			if (next.customType === "rp-outline-proposal") outlineReconcileSeen = true;
			if (next.customType === "rp-outline" && !outlineReconcileSeen) continue;
		}
		const verdict = text(data?.verdict).toLowerCase();
		const entryStatus = text(data?.status).toLowerCase();
		const degraded = !!recordOf(data?.degraded);
		const resultStatus = verdict === "reject" || entryStatus === "rejected" ? "rejected"
			: ["fact-failed", "proposal-failed", "audit-failed"].includes(entryStatus) ? "failed"
			: degraded ? "degraded"
			: entryStatus === "pending" ? "pending"
			: entryStatus === "approved" ? "approved"
			: entryStatus === "committed" || next.customType === "rp-world-state" || next.customType === "rp-ecology-state" || next.customType === "rp-state" || next.customType === "rp-outline" ? "committed"
			: undefined;
		const commitDetails = { ...(safeFields(data, ["status", "verdict", "code", "stage", "round", "digest", "baseRound", "baseStateHash"]) ?? {}), ...(data?.audit ? { audit: true } : {}) };
		if (commits.length < MAX_COMMITS) commits.push({ type: next.customType, ...(resultStatus ? { status: resultStatus } : {}), summary: commitSummary(next.customType, data), ...(Object.keys(commitDetails).length ? { data: commitDetails } : {}) });
	}
	const curtain = curtainRaw.slice(0, MAX_CURTAIN);
	const worldAudit = commits.find((item) => item.type === "rp-world-audit");
	const worldCommit = commits.find((item) => item.type === "rp-world-state");
	const ecologyCommit = commits.find((item) => item.type === "rp-ecology-state");
	const outlineProposal = commits.find((item) => item.type === "rp-outline-proposal");
	const outlineCommit = commits.find((item) => item.type === "rp-outline");
	const worldAuditStatus = text(worldAudit?.data?.status).toLowerCase();
	const preflightRejected = worldAuditStatus === "rejected" && worldAudit?.data?.audit !== true;
	const worldAuditSummary = worldAudit?.summary ?? "世界链未运行";
	const factStatus: DiagnosticStatus = worldAuditStatus === "fact-failed" ? "failed" : worldAudit ? "success" : "skipped";
	const proposalStatus: DiagnosticStatus = worldAuditStatus === "fact-failed" ? "skipped" : ["proposal-failed"].includes(worldAuditStatus) ? "failed" : preflightRejected ? "rejected" : worldAudit ? "success" : "skipped";
	const auditStatus: DiagnosticStatus = ["fact-failed", "proposal-failed"].includes(worldAuditStatus) || preflightRejected ? "skipped" : worldAuditStatus === "audit-failed" ? "failed" : worldAuditStatus === "rejected" ? "rejected" : worldAudit ? "success" : "skipped";
	const worldCommitStatus: DiagnosticStatus = worldCommit || worldAuditStatus === "committed" ? "committed" : worldAuditStatus === "rejected" ? "rejected" : ["fact-failed", "proposal-failed", "audit-failed"].includes(worldAuditStatus) ? "failed" : "skipped";
	const patchAudit = safePatchAudit(details.rpPatchAudit);
	const ledgerCommitted = commits.some((item) => item.type === "rp-state");
	const scribeKind = text(scribeDiagnostic?.kind);
	const ledgerStatus: DiagnosticStatus = ledgerCommitted ? "committed" : scribeKind === "failed" || scribeKind === "stale" ? "degraded" : "skipped";
	const ledgerSummary = ledgerCommitted ? "角色账本已提交"
		: scribeKind === "failed" ? `场记失败：${text(scribeDiagnostic?.error) || "未记录原因"}`
			: scribeKind === "stale" ? "场记结果因分支变化被丢弃"
				: scribeKind === "skipped" ? "场记确认本拍无需新账本快照"
					: "本拍没有产生新的账本快照";
	const workflowStats = workflow ? {
		planWrites: number(workflow.planWrites), writes: number(workflow.writes), appends: number(workflow.appends), appendRejects: number(workflow.appendRejects),
		edits: number(workflow.edits), lookups: number(workflow.lookups), skillReads: number(workflow.skillReads), rounds: number(workflow.rounds),
		durationMs: number(workflow.durationMs), outputTokens: number(workflow.outputTokens), narrativeChars: number(workflow.narrativeChars),
	} : undefined;
	const stages: TurnDiagnosticStage[] = [
		stage("continuity", "文学连续性", prepStatus.continuity, prep?.literaryContinuity ? "success" : "skipped", prep?.literaryContinuity ? "连续性工件已生成" : "本拍未触发", safeFields(recordOf(prep?.literaryContinuity), ["positions", "ongoingActions", "promisesAndDeadlines", "unresolvedPlayerChoices", "uncertainties"])),
		stage("plot-adaptation", "生态剧情适配", prepStatus.plotAdaptation, prep?.plotAdaptation ? "success" : "skipped", prep?.plotAdaptation ? "卡级语法已将生态候选变形成当前事件" : prepStatus.plotAdaptation === "degraded" ? "调用或解析失败，正文按原流程继续" : "生态关闭或本拍未运行", safeFields(recordOf(prep?.plotAdaptation), ["cardGrammar", "selected", "reserves"])),
		stage("director", "Stitches 导演", prepStatus.director, prep?.literaryDirectionData ? "success" : typeof prep?.literaryDirection === "string" ? "reused" : "skipped", prep?.literaryDirectionData ? "导演工件已生成" : typeof prep?.literaryDirection === "string" ? "沿用旧导演工件" : "本拍未运行", safeFields(recordOf(prep?.literaryDirectionData), ["scenePressure", "characterInitiatives", "personalThreads", "candidateBeats", "relationshipLimit", "playerStop"])),
		stage("scene-conductor", "场面编排", prepStatus.sceneConductor, prep?.sceneConductor ? "success" : "skipped", prep?.sceneConductor ? "角色动作、信息边界与玩家停点已编排" : prepStatus.sceneConductor === "degraded" ? "调用或解析失败，主演按导演方向继续" : "本拍未运行", safeFields(recordOf(prep?.sceneConductor), ["sceneObjective", "turnOrder", "pressureShift", "playerStop"])),
		stage("ecology-arrival", "生态抵达", prepStatus.ecologyArrival, prep?.literaryEcology ? "success" : "skipped", prepStatus.ecologyArrival === "degraded" ? "候选失败或门禁拒绝，沿用上一快照" : prep?.literaryEcology ? "生态候选已交给导演" : "生态未运行", safeFields(recordOf(prep?.literaryEcology), ["round", "digest"])),
		stage("memory-recall", "剧情记忆召回", prepStatus.memoryRecall, memoryRecall?.results ? "success" : prepStatus.memoryRecall === "degraded" ? "degraded" : "skipped", prepStatus.memoryRecall === "degraded" ? "召回失败或超时，按摘要与状态继续" : memoryRecall?.results ? `命中 ${number(memoryRecall.results)} 条历史记忆` : "本拍未触发历史回照", safeFields(memoryRecall, ["triggered", "results", "queryChars", "mode", "arcs"])),
		stage("writer", "主演分段演出", undefined, workflowStats ? "success" : "failed", workflowStats ? `${workflowStats.appends || workflowStats.writes} 个稿段 · ${workflowStats.rounds} 轮` : "缺少主演工作流工件", workflowStats),
		stage("ledger", "角色账本", undefined, ledgerStatus, ledgerSummary, safeFields(scribeDiagnostic, ["kind", "reason", "error"])),
		stage("world-facts", "拍后事实信封", undefined, factStatus, factStatus === "success" ? "已提取带证据事实" : factStatus === "failed" ? worldAuditSummary : "世界链未运行", worldAudit?.data),
		stage("world-proposal", "世界转移提案", undefined, proposalStatus, proposalStatus === "success" ? "提案已通过确定性预审" : proposalStatus === "failed" || proposalStatus === "rejected" ? worldAuditSummary : "没有进入提案阶段", worldAudit?.data),
		stage("world-audit", "世界转移审计", undefined, auditStatus, auditStatus === "success" ? worldAuditSummary : auditStatus === "rejected" ? worldAuditSummary : auditStatus === "failed" ? worldAuditSummary : "没有进入审计阶段", worldAudit?.data),
		stage("world-commit", "世界原子提交", undefined, worldCommitStatus, worldCommit ? "世界快照已提交" : worldAuditStatus === "committed" ? "本拍没有到期变化，世界保持稳定" : worldCommitStatus === "rejected" ? "审计拒绝，保留上一快照" : worldCommitStatus === "failed" ? "世界链失败，保留上一快照" : "世界链未产生新快照"),
		stage("ecology-aftermath", "生态 aftermath", undefined, ecologyCommit?.status === "degraded" ? "degraded" : ecologyCommit ? "committed" : "skipped", ecologyCommit ? ecologyCommit.summary : "拍后生态未产生新快照", ecologyCommit?.data),
		stage("curtain", "独立谢幕格式", undefined, curtain ? "success" : "skipped", curtain ? "格式工件已生成" : "本拍没有额外格式", curtain ? { chars: curtain.length } : undefined),
		stage("outline-reconcile", "大纲自动校准", undefined, runtime?.outline?.status ?? (outlineCommit ? "committed" : outlineProposal?.status === "rejected" ? "rejected" : outlineProposal ? "pending" : "skipped"), runtime?.outline?.summary ?? (outlineCommit ? "校准结果已写入动态大纲" : outlineProposal?.status === "rejected" ? outlineProposal.summary : outlineProposal ? "校准提案等待确认" : "本拍未触发"), outlineProposal?.data),
		stage("memory-settlement", "记忆压缩与事件索引", undefined, memoryDiagnostic?.kind === "compacted" ? "success" : memoryDiagnostic?.kind === "failed" ? "failed" : memoryDiagnostic?.kind === "skipped" ? "skipped" : "pending", memoryDiagnostic?.kind === "compacted" ? `已压缩 ${number(memoryDiagnostic.turns)} 拍` : memoryDiagnostic?.kind === "failed" ? `记忆压缩失败：${text(memoryDiagnostic.error)}` : memoryDiagnostic?.kind === "skipped" ? "本拍未到压缩条件" : "记忆结算尚无留痕", safeFields(memoryDiagnostic, ["kind", "turns", "chars", "error"])),
	];
	return {
		version: 1,
		entryId: entry.id ?? `assistant-${index}`,
		narrativeChars: narrativeRaw.length,
		curtainChars: curtainRaw.length,
		timeline: counts,
		stages,
		...(performance ? { performance } : {}),
		artifacts: {
			...(prep ? { prep: { workflowStatus: prepStatus } } : {}),
			...(workflow ? { workflow: workflowStats } : {}),
			...(recordOf(details.rpContextPreflight) ? { contextPreflight: safeFields(recordOf(details.rpContextPreflight), ["status", "checks", "warnings", "confirmedOverflow", "inputChars", "estimatedInputTokens", "contextWindow", "reservedOutputTokens"]) } : {}),
			...(curtain ? { curtain, ...(curtainRaw.length > curtain.length ? { curtainTruncated: true } : {}) } : {}),
			...(patchAudit.length ? { patchAudit } : {}),
			commits,
		},
	};
}

function failedDebugDiagnostic(entry: BranchEntryLike): TurnDiagnosticView | undefined {
	const data = customData(entry);
	if (!data || text(data.finalText) || text(data.draft)) return undefined;
	const beatLog = Array.isArray(data.beatLog) ? data.beatLog : [];
	const rows = beatLog.map(recordOf).filter((row): row is Record<string, unknown> => !!row);
	const receivedText = rows.filter((row) => text(row.ev) === "text").reduce((total, row) => total + text(row.data, 100_000).length, 0);
	const activities = rows.filter((row) => text(row.ev) === "activity").map((row) => text(row.data)).filter(Boolean);
	const providerErrors = rows.filter((row) => text(row.ev) === "provider_error").map((row) => text(row.data)).filter(Boolean);
	const hasPrepFailure = activities.some((item) => /失败|超时|取消|无可用候选/.test(item));
	const stages: TurnDiagnosticStage[] = [
		stage("continuity", "文学连续性", undefined, hasPrepFailure ? "degraded" : "skipped", hasPrepFailure ? "拍前旁路失败或超时" : "本拍未产生工件"),
		stage("plot-adaptation", "生态剧情适配", undefined, hasPrepFailure ? "degraded" : "skipped", hasPrepFailure ? "拍前旁路失败或超时" : "本拍未运行"),
		stage("director", "Stitches 导演", undefined, hasPrepFailure ? "degraded" : "skipped", hasPrepFailure ? "拍前旁路失败或超时" : "本拍未运行"),
		stage("scene-conductor", "场面编排", undefined, "skipped", "主演未进入可用正文工作流"),
		stage("ecology-arrival", "生态抵达", undefined, hasPrepFailure ? "degraded" : "skipped", hasPrepFailure ? "拍前旁路失败或超时" : "本拍未运行"),
		stage("memory-recall", "剧情记忆召回", undefined, activities.some((item) => item.includes("记忆召回") && /失败|超时/.test(item)) ? "degraded" : "skipped", "本拍失败，未形成正文输入结算"),
		stage("writer", "主演分段演出", undefined, "failed", receivedText ? `已收到约 ${receivedText} 字流文本，但未形成可落树终态` : "未收到可用正文" , { receivedTextChars: receivedText, providerErrors: providerErrors.slice(0, 3) }),
		stage("ledger", "角色账本", undefined, "skipped", "失败拍不记账"),
		stage("world-facts", "拍后事实信封", undefined, "skipped", "失败拍不推进世界"),
		stage("world-proposal", "世界转移提案", undefined, "skipped", "失败拍不推进世界"),
		stage("world-audit", "世界转移审计", undefined, "skipped", "失败拍不推进世界"),
		stage("world-commit", "世界原子提交", undefined, "skipped", "失败拍不提交世界"),
		stage("ecology-aftermath", "生态 aftermath", undefined, "skipped", "失败拍不推进生态"),
		stage("curtain", "独立谢幕格式", undefined, "skipped", "失败拍没有谢幕工件"),
		stage("outline-reconcile", "大纲自动校准", undefined, "skipped", "失败拍不校准大纲"),
		stage("memory-settlement", "记忆压缩与事件索引", undefined, "skipped", "失败拍不结算记忆"),
	];
	const counts = rows.reduce((result, row) => {
		const kind = text(row.ev);
		if (kind === "thinking") result.thinking++;
		else if (kind === "tool") result.tools++;
		else if (kind === "text") result.text++;
		return result;
	}, { thinking: 0, tools: 0, text: 0 });
	return {
		version: 1,
		entryId: entry.id ?? "failed-turn",
		narrativeChars: 0,
		curtainChars: 0,
		timeline: counts,
		stages,
		artifacts: { workflow: { receivedTextChars: receivedText, providerErrors: providerErrors.slice(0, 3), activities: activities.slice(-8) }, commits: [] },
	};
}

export function diagnosticsFromBranch(branch: BranchEntryLike[], limit = MAX_TURNS, runtime: Record<string, TurnRuntimeDiagnostic> = {}): TurnDiagnosticsView {
	const turns: TurnDiagnosticView[] = [];
	const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TURNS, Math.floor(limit))) : 12;
	for (let i = branch.length - 1; i >= 0 && turns.length < safeLimit; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === "rp-text-debug") {
			const failed = failedDebugDiagnostic(entry);
			if (failed) turns.push(failed);
			continue;
		}
		if (entry.type !== "assistant" && entry.message?.role !== "assistant") continue;
		const details = recordOf(recordOf(entry.message)?.details);
		if (!details || !["rpWorkflow", "rpPrep", "rpTimeline", "rpNarrative", "rpCurtain"].some((key) => key in details)) continue;
		turns.push(diagnosticFor(branch, i, entry, entry.id ? runtime[entry.id] : undefined));
	}
	return { version: 1, turns };
}
