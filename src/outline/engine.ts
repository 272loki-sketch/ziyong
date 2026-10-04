import { createHash, randomUUID } from "node:crypto";

import type { SideModelStep } from "../model-routing.ts";
import type { BranchEntryLike } from "../stage/assemble.ts";
import type { StageMaterials } from "../stage/materials.ts";
import { workflowSkill } from "../stage/skill-store.ts";
import type { WebResearchItem } from "../tools/web-research.ts";
import { buildOutlineAuditPrompt, buildOutlineChatPrompt } from "./prompts.ts";
import { projectOutline, projectCorpusResearchIndex, projectCorpusWorkspace, projectSelectedCorpusWorkspace } from "./projection.ts";
import { OutlineResearchStore, type OutlineResearchExtraction } from "./research.ts";
import { parseOutlineAudit, parseOutlineProposal } from "./runtime.ts";
import type { OutlineAudit, OutlineChatEntry, OutlineChatResult, OutlineDailyPlan, OutlineDiscussionFocus, OutlineProposal, OutlineProposalEntry, OutlineSceneAdvice, OutlineSource } from "./schema.ts";
import { OUTLINE_CHAT_ENTRY_TYPE, OUTLINE_CHAT_CLEAR_TYPE, OUTLINE_ENTRY_TYPE, OUTLINE_PROPOSAL_ENTRY_TYPE } from "./schema.ts";
import { outlineHistoryFromBranch } from "./state.ts";
import { pendingOutlineProposalsFromBranch } from "./store.ts";
import { validateOutlineProposal } from "./validation.ts";

export type OutlineMode = "manual" | "suggest" | "auto";
export type OutlineResearchMode = "off" | "manual" | "auto";
export interface OutlineSettings { mode: OutlineMode; researchMode: OutlineResearchMode }
export interface OutlineSessionManager {
	getBranch(): unknown[];
	getLeafId(): string | null;
	getSessionId(): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	flush(): void;
}
export interface OutlineContext {
	cardKey: string;
	card?: unknown;
	history?: unknown;
	rpState?: unknown;
	world?: unknown;
	ecology?: unknown;
	literaryProfiles?: unknown;
	directorArtifacts?: unknown;
}
export interface OutlineEngineDeps {
	cwd: string;
	getSessionManager: () => OutlineSessionManager;
	loadMaterials: () => StageMaterials;
	runSideModel: (step: SideModelStep, systemPrompt: string, userText: string, options?: { maxTokens?: number; signal?: AbortSignal; forceNonStreaming?: boolean; onDelta?: (event: { kind: "text"; delta: string } | { kind: "error"; text: string }) => void }) => Promise<string | { error: string }>;
	webResearch?: (queries: string[], maxResults: number, signal?: AbortSignal) => Promise<WebResearchItem[]>;
	getContext?: () => OutlineContext;
	onState?: (view: OutlineView) => void;
}
export interface OutlineView {
	state: ReturnType<typeof outlineHistoryFromBranch>["current"];
	projection: ReturnType<typeof projectOutline>;
	pending: ReturnType<typeof pendingOutlineProposalsFromBranch>;
	settings: OutlineSettings;
	invalidEntries: number;
	proposalRisks: Record<string, OutlinePendingRisk>;
	chats: OutlineChatEntry[];
}
export interface OutlinePendingRisk { highRisk: string[]; issues: OutlineAudit["issues"]; requiresConfirmation: boolean }
interface OutlineCapture { sessionId: string; leafId: string; state: OutlineView["state"]; trustedSources: OutlineSource[]; trustedSourceIds: Set<string> }

export interface OutlineResearchSourceRow { id: string; query: string; title: string; snippet: string; url: string }
export interface OutlineResearchSearch {
	/** 实际执行的脱敏检索式。 */
	queries: string[];
	/** 每个检索式的原始搜索结果（含 reject/error）。 */
	results: WebResearchItem[];
	/** 进提炼模型的去重来源行（带稳定 src-* id），供前端标注机制出处。 */
	sources: OutlineResearchSourceRow[];
	/** 本轮提炼出的机制（已入库）。 */
	extracted: OutlineResearchExtraction[];
}
export interface OutlineResearchSearchResult { view: ReturnType<OutlineResearchStore["view"]>; search: OutlineResearchSearch }

export class OutlineConflictError extends Error { statusCode = 409; }

const SETTINGS_TYPE = "rp-outline-settings";
const parseObject = (text: string): Record<string, unknown> | null => {
	for (const candidate of [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try { const value = JSON.parse(candidate); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
	}
	return null;
};
const proposalHash = (proposal: OutlineProposal): string => createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
const DISCUSSION_FOCUS = new Set<OutlineDiscussionFocus>(["open", "next-beat", "dialogue", "character", "diagnose", "daily"]);
const cleanText = (value: unknown, max = 1200): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const cleanList = (value: unknown, maxItems = 8, maxChars = 500): string[] => Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, maxChars)] : []).slice(0, maxItems) : [];
function boundContext(value: unknown, budget: { left: number }, depth = 0): unknown {
	if (budget.left <= 0) return "（上下文已裁剪）";
	if (typeof value === "string") { const text = value.slice(0, Math.min(2000, budget.left)); budget.left -= text.length; return text; }
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 4) return "（嵌套内容已裁剪）";
	if (Array.isArray(value)) return value.slice(-24).map((item) => boundContext(item, budget, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (budget.left <= 0) break;
			out[key] = boundContext(item, budget, depth + 1);
		}
		return out;
	}
	return undefined;
}
const conversationTargetsOf = (value: unknown): Array<{ character: string; reason: string; openingTopic: string; risk: string }> => Array.isArray(value) ? value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const target = { character: cleanText(row.character, 160), reason: cleanText(row.reason), openingTopic: cleanText(row.openingTopic), risk: cleanText(row.risk) };
		return target.character && target.reason && target.openingTopic ? [target] : [];
	}).slice(0, 4) : [];
const sceneAdviceOf = (value: unknown): OutlineSceneAdvice | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const advice = {
		recommendedBeat: cleanText(row.recommendedBeat), openingMove: cleanText(row.openingMove),
		playerObjective: cleanText(row.playerObjective), naturalReason: cleanText(row.naturalReason), intendedConsequence: cleanText(row.intendedConsequence),
		characterMoves: cleanList(row.characterMoves), conversationTargets: conversationTargetsOf(row.conversationTargets), dialogueCues: cleanList(row.dialogueCues),
		pressure: cleanText(row.pressure), playerSpace: cleanText(row.playerSpace), stopPoint: cleanText(row.stopPoint), alternatives: cleanList(row.alternatives, 4),
		mixedRoute: cleanText(row.mixedRoute),
	};
	return Object.values(advice).some((item) => Array.isArray(item) ? item.length > 0 : !!item) ? advice : undefined;
};
const dailyPlanOf = (value: unknown): OutlineDailyPlan | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const plan: OutlineDailyPlan = {
		title: cleanText(row.title, 180), genre: cleanText(row.genre, 100), duration: cleanText(row.duration, 100), location: cleanText(row.location, 180),
		participants: cleanList(row.participants, 6, 120), initiator: cleanText(row.initiator, 180), surfaceActivity: cleanText(row.surfaceActivity), privateIntent: cleanText(row.privateIntent),
		sweetBeats: cleanList(row.sweetBeats, 6), friction: cleanText(row.friction), misunderstanding: cleanText(row.misunderstanding), characterBoundaries: cleanList(row.characterBoundaries, 8),
		relationshipChange: cleanText(row.relationshipChange), playerChoices: cleanList(row.playerChoices, 6), stopPoint: cleanText(row.stopPoint), followUpSeeds: cleanList(row.followUpSeeds, 6), researchRefs: cleanList(row.researchRefs, 12, 100),
		entryCondition: cleanText(row.entryCondition), continuityHook: cleanText(row.continuityHook), whyNow: cleanText(row.whyNow),
		intensity: row.intensity === "light" || row.intensity === "medium" || row.intensity === "strong" ? row.intensity : "medium",
		initiativeType: cleanText(row.initiativeType, 120), pressureType: cleanText(row.pressureType, 120), choiceType: cleanText(row.choiceType, 120), relationshipEffect: cleanText(row.relationshipEffect, 180),
	};
	return plan.title && plan.location && plan.participants.length >= 2 && plan.initiator && plan.surfaceActivity && plan.privateIntent && plan.sweetBeats.length && (plan.friction || plan.misunderstanding) && plan.characterBoundaries.length && plan.relationshipChange && plan.playerChoices.length >= 2 && plan.stopPoint && plan.entryCondition && plan.continuityHook && plan.whyNow && plan.initiativeType && plan.pressureType && plan.choiceType && plan.relationshipEffect ? plan : undefined;
};
const dailyPlansOf = (value: unknown): OutlineDailyPlan[] => Array.isArray(value)
	? value.flatMap((item) => dailyPlanOf(item) ?? []).slice(0, 3)
	: [];
const dailyPlansDistinct = (plans: OutlineDailyPlan[]): boolean => plans.length === 3 && plans.every((plan, index) => plans.slice(index + 1).every((other) => [plan.initiativeType === other.initiativeType, plan.pressureType === other.pressureType, plan.choiceType === other.choiceType, plan.relationshipEffect === other.relationshipEffect].filter(Boolean).length < 2));

export class OutlineEngine {
	#deps: OutlineEngineDeps;
	#research: OutlineResearchStore;
	#commit = Promise.resolve();
	#abort = new AbortController();
	constructor(deps: OutlineEngineDeps) { this.#deps = deps; this.#research = new OutlineResearchStore(deps.cwd); }

	cancel(): void { this.#abort.abort(); this.#abort = new AbortController(); }

	getView(): OutlineView {
		const branch = this.#branch();
		const history = outlineHistoryFromBranch(branch);
		const pending = pendingOutlineProposalsFromBranch(branch), trustedSourceIds = new Set(this.#trustedSources(branch).map((source) => source.id));
		const proposalRisks = Object.fromEntries(pending.map(({ entry }) => {
			const result = validateOutlineProposal(history.current, entry.proposal, { trustedSourceIds });
			return [entry.proposal.id, { highRisk: result.highRisk, issues: result.audit.issues, requiresConfirmation: result.highRisk.length > 0 }];
		}));
		return { state: history.current, projection: projectOutline(history.current, "public"), pending, settings: this.#settings(branch), invalidEntries: history.invalidEntries, proposalRisks, chats: this.#chats(branch) };
	}

	history(): ReturnType<typeof outlineHistoryFromBranch> { return outlineHistoryFromBranch(this.#branch()); }

	async chat(message: string, options: { research?: boolean; focus?: OutlineDiscussionFocus; onDelta?: (event: { kind: "text"; delta: string } | { kind: "error"; text: string }) => void } = {}): Promise<OutlineChatResult & { options?: unknown[]; proposalHash?: string }> {
		const wish = message.trim();
		if (!wish) throw new Error("缺少 message");
		const base = this.#capture();
		if (options.research) { await this.research(wish); this.#guard(base); }
		const materials = this.#deps.loadMaterials();
		const skill = workflowSkill(materials.skillFiles, "outline-chat");
		if (!skill) throw new Error("缺少 workflow: outline-chat 的 Skill");
		const focus = options.focus && DISCUSSION_FOCUS.has(options.focus) ? options.focus : "open";
		const request = { requestId: randomUUID(), message: wish, mode: "manual" as const, baseRevision: base.state.revision, baseHash: base.state.hash, selectedNodeIds: [], research: [], focus };
		const researchWorkspace = await this.#researchForChat(base, focus, wish);
		this.#guard(base);
		const prompt = buildOutlineChatPrompt(skill.body, { request, outline: base.state, context: this.#modelContext(base.leafId, focus, wish, researchWorkspace) });
		let raw = await this.#call("outlineChat", prompt.systemPrompt, prompt.userText, 12288, options.onDelta);
		this.#guard(base);
		let parsed = parseObject(raw);
		if (focus === "daily" && (!parsed || !dailyPlansDistinct(dailyPlansOf(parsed.dailyPlans)))) {
			raw = await this.#call("outlineChat", prompt.systemPrompt, `${prompt.userText}\n\n上次输出未通过门禁：必须返回完整且设计指纹不同的 3 张 dailyPlans。请重新只返回完整 JSON。`, 12288);
			this.#guard(base);
			parsed = parseObject(raw);
		}
		if (!parsed) {
			const detail = raw.trim().slice(0, 600);
			throw new Error(detail ? `编剧室输出不可解析（${raw.trim().length} 字）：${detail}` : "编剧室输出为空");
		}
		const proposal = this.#proposal(parsed.proposal, "chat", base);
		const answer = String(parsed.answer ?? parsed.reply ?? "").trim();
		const responseOptions = Array.isArray(parsed.options) ? parsed.options.slice(0, 6) : [];
		const sceneAdvice = sceneAdviceOf(parsed.sceneAdvice), dailyPlans = focus === "daily" ? dailyPlansOf(parsed.dailyPlans) : [];
		if (focus === "daily" && !dailyPlansDistinct(dailyPlans)) throw new Error(`日常剧情卡未通过数量、完整度或差异门禁（有效 ${dailyPlans.length}/3）`);
		const dailyPlan = dailyPlanOf(parsed.dailyPlan) ?? dailyPlans[0];
		const warnings = cleanList(parsed.warnings, 8, 500);
		const usedResearchIds = new Set<string>([
			...dailyPlans.flatMap((plan) => plan.researchRefs),
			...(dailyPlan?.researchRefs ?? []),
			...(Array.isArray(parsed.options) ? parsed.options.flatMap((item) => item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).researchRefs) ? cleanList((item as Record<string, unknown>).researchRefs, 12, 100) : []) : []),
		]);
		if (usedResearchIds.size) await this.#research.recordUsage(usedResearchIds, "usedByDirector");
		const sm = this.#deps.getSessionManager();
		sm.appendCustomEntry(OUTLINE_CHAT_ENTRY_TYPE, { version: 1, requestId: request.requestId, baseLeafId: base.leafId, focus, user: wish.slice(0, 4000), answer: answer.slice(0, 8000), options: responseOptions, warnings, ...(sceneAdvice ? { sceneAdvice } : {}), ...(dailyPlan ? { dailyPlan } : {}), ...(dailyPlans.length ? { dailyPlans } : {}), createdAt: new Date().toISOString() } satisfies OutlineChatEntry);
		sm.flush();
		if (proposal) this.#storePending(proposal);
		else this.#emit();
		return { requestId: request.requestId, reply: answer, focus, ...(responseOptions.length ? { options: responseOptions } : {}), ...(sceneAdvice ? { sceneAdvice } : {}), ...(dailyPlan ? { dailyPlan } : {}), ...(dailyPlans.length ? { dailyPlans } : {}), ...(proposal ? { proposal, proposalHash: proposal.proposalHash } : {}), warnings };
	}

	clearChats(): void {
		const sm = this.#deps.getSessionManager();
		sm.appendCustomEntry(OUTLINE_CHAT_CLEAR_TYPE, { clearedAt: new Date().toISOString() });
		sm.flush();
		this.#emit();
	}

	async bootstrap(experienceWish = ""): Promise<OutlineProposal> {
		const base = this.#capture();
		if (this.getView().settings.researchMode === "auto") { await this.research(experienceWish || "当前题材的长线结构、人物弧线、伏笔与常见失败模式"); this.#guard(base); }
		return this.#generate("outline-bootstrap", "outlineBootstrap", "bootstrap", experienceWish);
	}

	async reconcile(leafId?: string): Promise<{ proposal?: OutlineProposal; committed?: boolean; stable?: boolean }> {
		const settings = this.getView().settings;
		const base = this.#capture();
		if (leafId && base.leafId !== leafId) throw new OutlineConflictError("leaf revision conflict");
		if (settings.researchMode === "auto") { await this.research("当前篇章的长线结构、人物弧线、伏笔回收与常见失败模式"); this.#guard(base); }
		const proposal = await this.#generate("outline-reconcile", "outlineReconcile", "reconcile", "", false);
		const checked = validateOutlineProposal(base.state, proposal, { trustedSourceIds: base.trustedSourceIds });
		if (checked.nextState?.hash === base.state.hash) return { stable: true };
		if (settings.mode === "auto") {
			const automatic = validateOutlineProposal(base.state, { ...proposal, mode: "automatic" }, { trustedSourceIds: base.trustedSourceIds });
			if (automatic.audit.verdict === "approve") { await this.#commitProposal({ ...proposal, mode: "automatic" }, false); return { proposal, committed: true }; }
		}
		this.#storePending(proposal);
		return { proposal, committed: false };
	}

	async confirm(id: string, hash: string): Promise<{ state: OutlineView["state"]; audit: OutlineAudit }> {
		const pending = this.getView().pending.find((row) => row.entry.proposal.id === id);
		if (!pending) throw new Error("待确认 proposal 不存在");
		if (!hash || hash !== pending.entry.proposalHash) throw new OutlineConflictError("proposal hash conflict");
		return this.#commitProposal(pending.entry.proposal, true);
	}

	reject(id: string, reason = "用户拒绝"): void {
		const pending = this.getView().pending.find((row) => row.entry.proposal.id === id);
		if (!pending) throw new Error("待确认 proposal 不存在");
		const sm = this.#deps.getSessionManager();
		sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, { ...pending.entry, status: "rejected", reason, createdAt: new Date().toISOString() } satisfies OutlineProposalEntry);
		sm.flush(); this.#emit();
	}

	settings(next?: Partial<OutlineSettings>): OutlineSettings {
		if (!next) return this.getView().settings;
		const current = this.getView().settings;
		const value: OutlineSettings = { mode: ["manual", "suggest", "auto"].includes(String(next.mode)) ? next.mode! : current.mode, researchMode: ["off", "manual", "auto"].includes(String(next.researchMode)) ? next.researchMode! : current.researchMode };
		const sm = this.#deps.getSessionManager(); sm.appendCustomEntry(SETTINGS_TYPE, value); sm.flush(); this.#emit(); return value;
	}

	researchView(): ReturnType<OutlineResearchStore["view"]> { return this.#research.view(this.#deps.getContext?.().cardKey ?? this.#deps.loadMaterials().config.card); }

	/** 小说消化完成入库（CorpusEngine onReady 钩子）。 */
	async digestReady(document: import("./corpus.ts").CorpusDocument, digest: import("./corpus.ts").CorpusDigest, extracted: OutlineResearchExtraction[]): Promise<import("./research.ts").OutlineResearchView["documents"]> {
		return this.#research.mergeCorpus(document.cardKey, document, digest, extracted);
	}

	/** 删除文档后清理只被该文档引用的机制条目（CorpusEngine onRemoved 钩子）。 */
	removeCorpus(docId: string): Promise<number> { return this.#research.removeCorpus(docId); }

	async research(topic = ""): Promise<ReturnType<OutlineResearchStore["view"]>> { return (await this.#researchRun(topic)).view; }

	/** 带本次搜索详情的版本：导演室「研究搜索」页展示搜到的来源与本轮提炼结果。 */
	async researchSearch(topic = ""): Promise<OutlineResearchSearchResult> { return this.#researchRun(topic); }

	async #researchRun(topic = ""): Promise<OutlineResearchSearchResult> {
		if (!this.#deps.webResearch) throw new Error("当前环境没有启用联网研究");
		const context = this.#deps.getContext?.();
		const queries = this.#safeQueries(topic, context);
		const rows = await this.#deps.webResearch(queries, 5, this.#abort.signal);
		const materials = this.#deps.loadMaterials(), skill = workflowSkill(materials.skillFiles ?? [], "outline-research");
		let extracted: OutlineResearchExtraction[] = [];
		const sources: OutlineResearchSourceRow[] = [];
		if (skill) {
			const sourceRows = rows.flatMap((item) => (item.results ?? []).map((result) => {
				let url = ""; try { url = new URL(result.url).toString(); } catch { return null; }
				return { id: `src-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`, query: item.query, title: result.title.slice(0, 180), snippet: result.snippet.slice(0, 600), url };
			}).filter((row): row is NonNullable<typeof row> => !!row)).slice(0, 30);
			sources.push(...sourceRows);
			if (sourceRows.length) {
				let raw: string | { error: string };
				try { raw = await this.#call("outlineResearch", skill.body, JSON.stringify({ task: "outline-research", sources: sourceRows }, null, 2), 8192); }
				catch (error) { console.error(`[research] 提炼调用失败（保留来源）：${error instanceof Error ? error.message : String(error)}`); raw = { error: String(error) }; }
				const parsed = typeof raw === "string" ? parseObject(raw) : null;
				if (Array.isArray(parsed?.mechanisms)) extracted = parsed.mechanisms.flatMap((item): OutlineResearchExtraction[] => {
					if (!item || typeof item !== "object" || Array.isArray(item)) return [];
					const row = item as Record<string, unknown>;
					if (typeof row.mechanism !== "string" || typeof row.appliesWhen !== "string" || typeof row.failureWarning !== "string" || !Array.isArray(row.sourceIds) || !row.sourceIds.every((id) => typeof id === "string")) return [];
					return [{ mechanism: row.mechanism, appliesWhen: row.appliesWhen, failureWarning: row.failureWarning, sourceIds: row.sourceIds }];
				});
			}
		}
		const view = await this.#research.merge(context?.cardKey ?? materials.config.card, rows, extracted);
		if (sources.length) {
			this.#research.appendSearchLog({
				id: `search-${randomUUID().slice(0, 8)}`,
				createdAt: new Date().toISOString(),
				topic: topic.trim().slice(0, 200),
				queries,
				sources,
				extracted,
			});
		}
		return { view, search: { queries, results: rows, sources, extracted } };
	}

	/** 研究搜索历史（导演室「研究搜索」保留回看）。 */
	researchSearchLogs(): ReturnType<OutlineResearchStore["searchHistory"]> { return this.#research.searchHistory(); }

	/** 对某条保留的搜索结果再次提炼（来源已留存，不重新联网）。 */
	async researchRetrySearchExtraction(logId: string): Promise<OutlineResearchSearchResult> {
		const log = this.#research.searchHistory().find((row) => row.id === logId);
		if (!log) throw new Error("搜索历史不存在");
		if (!log.sources.length) throw new Error("该搜索记录没有保留来源，无法再次提炼");
		const materials = this.#deps.loadMaterials(), skill = workflowSkill(materials.skillFiles ?? [], "outline-research");
		if (!skill) throw new Error("缺少 workflow: outline-research 的 Skill");
		const context = this.#deps.getContext?.();
		const rows: WebResearchItem[] = log.queries.map((query) => ({ query, results: log.sources.filter((s) => s.query === query).map(({ title, url, snippet }) => ({ title, url, snippet })) })).filter((row) => (row.results?.length ?? 0) > 0);
		let extracted: OutlineResearchExtraction[] = [];
		if (log.sources.length) {
			let raw: string | { error: string };
			try { raw = await this.#call("outlineResearch", skill.body, JSON.stringify({ task: "outline-research", sources: log.sources }, null, 2), 8192); }
			catch (error) { console.error(`[research] 再次提炼失败（保留来源）：${error instanceof Error ? error.message : String(error)}`); raw = { error: String(error) }; }
			const parsed = typeof raw === "string" ? parseObject(raw) : null;
			if (Array.isArray(parsed?.mechanisms)) extracted = parsed.mechanisms.flatMap((item): OutlineResearchExtraction[] => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return [];
				const row = item as Record<string, unknown>;
				if (typeof row.mechanism !== "string" || typeof row.appliesWhen !== "string" || typeof row.failureWarning !== "string" || !Array.isArray(row.sourceIds) || !row.sourceIds.every((id) => typeof id === "string")) return [];
				return [{ mechanism: row.mechanism, appliesWhen: row.appliesWhen, failureWarning: row.failureWarning, sourceIds: row.sourceIds }];
			});
		}
		if (extracted.length) await this.#research.merge(context?.cardKey ?? materials.config.card, rows, extracted);
		const updated = this.#research.updateSearchLogExtracted(logId, extracted);
		const view = this.#research.view(context?.cardKey ?? materials.config.card);
		return { view, search: { queries: log.queries, results: rows, sources: log.sources, extracted: updated?.extracted ?? extracted } };
	}

	async #generate(workflow: "outline-bootstrap" | "outline-reconcile", step: SideModelStep, kind: "bootstrap" | "reconcile", wish: string, store = true): Promise<OutlineProposal> {
		const base = this.#capture(), materials = this.#deps.loadMaterials(), skill = workflowSkill(materials.skillFiles, workflow);
		if (!skill) throw new Error(`缺少 workflow: ${workflow} 的 Skill`);
		const raw = await this.#call(step, skill.body, JSON.stringify({ task: workflow, baseLeafId: base.leafId, current_outline: base.state, experience_wish: wish, context: this.#modelContext(base.leafId, "open", wish) }, null, 2), 16384);
		this.#guard(base);
		const proposal = this.#proposal(parseObject(raw), kind, base);
		if (!proposal) throw new Error(`${workflow} 输出没有可解析 proposal`);
		if (store) this.#storePending(proposal);
		return proposal;
	}

	#proposal(value: unknown, kind: OutlineProposal["kind"], base: OutlineCapture): OutlineProposal | null {
		const parsed = parseOutlineProposal(value, { modelInput: true });
		if (!parsed || parsed.kind !== kind || parsed.baseRevision !== base.state.revision || parsed.baseHash !== base.state.hash || parsed.baseLeafId !== base.leafId) return null;
		const referenced = new Set((parsed.patch.collections ?? []).flatMap((row) => (row.upsert ?? []).flatMap((node) => [...node.sourceRefs, ...(row.collection === "foreshadowing" ? (node as { evidenceRefs?: string[] }).evidenceRefs ?? [] : [])])));
		const injected = base.trustedSources.filter((source) => referenced.has(source.id) && !base.state.sources.some((old) => old.id === source.id));
		const proposal: OutlineProposal = { ...parsed, patch: { ...parsed.patch, ...(injected.length ? { addSources: [...(parsed.patch.addSources ?? []), ...injected] } : {}) }, createdAt: new Date().toISOString() };
		proposal.proposalHash = proposalHash(proposal);
		return proposal;
	}

	async #commitProposal(proposal: OutlineProposal, confirmed: boolean): Promise<{ state: OutlineView["state"]; audit: OutlineAudit }> {
		let output!: { state: OutlineView["state"]; audit: OutlineAudit };
		const task = this.#commit.then(async () => {
			const base = this.#capture();
			const pendingMarker = this.#pendingMarker(proposal.id);
			const baseLeafStillInBranch = this.#branch().some((row) => row.id === proposal.baseLeafId);
			if (base.state.revision !== proposal.baseRevision || base.state.hash !== proposal.baseHash || !baseLeafStillInBranch || (confirmed && !pendingMarker)) throw new OutlineConflictError("outline revision conflict");
			if (this.#storyAdvancedAfter(pendingMarker?.entryId ?? proposal.baseLeafId!)) throw new OutlineConflictError("提案生成后剧情已继续，请基于当前剧情重新讨论");
			const confirmation = confirmed && proposal.proposalHash && proposal.baseLeafId ? { proposalHash: proposal.proposalHash, baseLeafId: proposal.baseLeafId } : undefined;
			const deterministic = validateOutlineProposal(base.state, confirmed ? proposal : { ...proposal, mode: "automatic" }, { trustedSourceIds: base.trustedSourceIds, ...(confirmation ? { confirmation } : {}) });
			if (!deterministic.nextState) throw new Error(deterministic.audit.summary);
			let audit = deterministic.audit;
			const skill = workflowSkill(this.#deps.loadMaterials().skillFiles, "outline-audit");
			if (skill) {
				const prompt = buildOutlineAuditPrompt(skill.body, { outline: base.state, proposal, deterministicIssues: deterministic.audit.issues, execution: { requestedMode: confirmed ? "manual" : "automatic", confirmed, confirmedProposalHash: confirmed ? proposal.proposalHash : null, confirmedBaseLeafId: confirmed ? proposal.baseLeafId : null, pendingMarkerMatched: confirmed ? !!pendingMarker : false } });
				const parsed = parseOutlineAudit(parseObject(await this.#call("outlineAudit", prompt.systemPrompt, prompt.userText, 4096)));
				if (!parsed) throw new Error("大纲审计输出无效");
				audit = parsed;
				if (audit.verdict !== "approve") {
					this.#guard(base);
					const sm = this.#deps.getSessionManager();
					sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, { version: 1, proposal, proposalHash: proposal.proposalHash, audit, status: "rejected", reason: audit.summary, createdAt: new Date().toISOString() } satisfies OutlineProposalEntry);
					sm.flush(); this.#emit();
					throw new Error(audit.summary || "大纲审计拒绝提案");
				}
			}
			this.#guard(base);
			const sm = this.#deps.getSessionManager();
			// Write the approved proposal first, but do not claim it committed before the state append succeeds.
			const entry: OutlineProposalEntry = { version: 1, proposal, proposalHash: proposal.proposalHash, audit, status: "approved", committedRevision: deterministic.nextState.revision, committedHash: deterministic.nextState.hash, createdAt: new Date().toISOString() };
			sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, entry);
			sm.appendCustomEntry(OUTLINE_ENTRY_TYPE, deterministic.nextState);
			sm.flush(); output = { state: deterministic.nextState, audit }; this.#emit();
		});
		this.#commit = task.then(() => undefined, () => undefined); await task; return output;
	}

	#storePending(proposal: OutlineProposal): void { const sm = this.#deps.getSessionManager(); sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, { version: 1, proposal, proposalHash: proposal.proposalHash, status: "pending", createdAt: new Date().toISOString() } satisfies OutlineProposalEntry); sm.flush(); this.#emit(); }
	#capture(): OutlineCapture { const sm = this.#deps.getSessionManager(), leafId = sm.getLeafId(); if (!leafId) throw new Error("当前会话没有分支叶"); const branch = sm.getBranch() as BranchEntryLike[], trustedSources = this.#trustedSources(branch); return { sessionId: sm.getSessionId(), leafId, state: outlineHistoryFromBranch(branch).current, trustedSources, trustedSourceIds: new Set(trustedSources.map((source) => source.id)) }; }
	#guard(base: OutlineCapture): void { const now = this.#capture(); if (now.sessionId !== base.sessionId || now.leafId !== base.leafId || now.state.revision !== base.state.revision || now.state.hash !== base.state.hash) throw new OutlineConflictError("outline revision conflict"); }
	#branch(): BranchEntryLike[] { return this.#deps.getSessionManager().getBranch() as BranchEntryLike[]; }
	#pendingMarker(id: string): { entryId: string } | undefined { return pendingOutlineProposalsFromBranch(this.#branch()).find((row) => row.entry.proposal.id === id); }
	#storyAdvancedAfter(baseLeafId: string): boolean {
		const branch = this.#branch(), at = branch.findIndex((row) => row.id === baseLeafId);
		if (at < 0) return true;
		return branch.slice(at + 1).some((row) => {
			if (row.type === "user" || row.type === "assistant" || row.message?.role === "user" || row.message?.role === "assistant") return true;
			return row.type === "custom" && ![OUTLINE_CHAT_ENTRY_TYPE, OUTLINE_CHAT_CLEAR_TYPE, OUTLINE_PROPOSAL_ENTRY_TYPE, SETTINGS_TYPE].includes(String(row.customType));
		});
	}
	#chats(branch: BranchEntryLike[]): OutlineChatEntry[] {
		let lastClear = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i].type === "custom" && branch[i].customType === OUTLINE_CHAT_CLEAR_TYPE) { lastClear = i; break; }
		}
		return branch.flatMap((row, i): OutlineChatEntry[] => {
			if (i <= lastClear) return [];
			if (row.type !== "custom" || row.customType !== OUTLINE_CHAT_ENTRY_TYPE || !row.data || typeof row.data !== "object" || Array.isArray(row.data)) return [];
			const raw = row.data as Partial<OutlineChatEntry>;
			if (raw.version !== 1 || typeof raw.requestId !== "string" || typeof raw.baseLeafId !== "string" || typeof raw.user !== "string" || typeof raw.answer !== "string" || !DISCUSSION_FOCUS.has(raw.focus as OutlineDiscussionFocus)) return [];
			return [{ version: 1, requestId: raw.requestId, baseLeafId: raw.baseLeafId, focus: raw.focus as OutlineDiscussionFocus, user: raw.user.slice(0, 4000), answer: raw.answer.slice(0, 8000), options: Array.isArray(raw.options) ? raw.options.slice(0, 6) : [], warnings: cleanList(raw.warnings, 8, 500), ...(raw.sceneAdvice ? { sceneAdvice: sceneAdviceOf(raw.sceneAdvice) } : {}), ...(raw.dailyPlan ? { dailyPlan: dailyPlanOf(raw.dailyPlan) } : {}), ...(Array.isArray(raw.dailyPlans) ? { dailyPlans: dailyPlansOf(raw.dailyPlans) } : {}), createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "" }];
		}).slice(-80);
	}
	#settings(branch: BranchEntryLike[]): OutlineSettings { for (let i = branch.length - 1; i >= 0; i--) { const row = branch[i]; if (row.type === "custom" && row.customType === SETTINGS_TYPE && row.data && typeof row.data === "object") { const data = row.data as Partial<OutlineSettings>; return { mode: ["manual", "suggest", "auto"].includes(String(data.mode)) ? data.mode! : "manual", researchMode: ["off", "manual", "auto"].includes(String(data.researchMode)) ? data.researchMode! : "off" }; } } return { mode: "manual", researchMode: "off" }; }
	#modelContext(leafId: string, focus: OutlineDiscussionFocus = "open", query = "", researchWorkspace = projectCorpusWorkspace(this.#research.view(this.#deps.getContext?.()?.cardKey ?? this.#deps.loadMaterials().config.card), { maxDocs: 3, maxAssets: 8, focus, query })): unknown {
		const context = this.#deps.getContext?.() ?? { cardKey: this.#deps.loadMaterials().config.card };
		const budget = { left: 70_000 };
		return {
			baseLeafId: leafId,
			cardKey: context.cardKey,
			card: boundContext(context.card, budget),
			history: boundContext(context.history, budget),
			rpState: boundContext(context.rpState, budget),
			world: boundContext(context.world, budget),
			ecology: boundContext(context.ecology, budget),
			literaryProfiles: boundContext(context.literaryProfiles, budget),
			directorArtifacts: boundContext(context.directorArtifacts, budget),
			trustedEvidenceRegistry: this.#trustedSources(this.#branch()).map(({ id, kind, title, locator }) => ({ id, kind, title, locator })),
			researchWorkspace,
		};
	}
	async #researchForChat(base: OutlineCapture, focus: OutlineDiscussionFocus, query: string): Promise<ReturnType<typeof projectCorpusWorkspace>> {
		const context = this.#deps.getContext?.() ?? { cardKey: this.#deps.loadMaterials().config.card };
		const view = this.#research.view(context.cardKey);
		const fallback = projectCorpusWorkspace(view, { maxDocs: 3, maxAssets: 8, focus, query });
		const index = projectCorpusResearchIndex(view);
		if (!index.documents.length && !index.items.length) return fallback;
		const materials = this.#deps.loadMaterials();
		const skill = workflowSkill(materials.skillFiles ?? [], "outline-corpus-research");
		if (!skill) return fallback;
		const budget = { left: 24_000 };
		const storyContext = this.#deps.getContext?.() ?? { cardKey: context.cardKey };
		const userText = JSON.stringify({
			task: "outline-corpus-research",
			request: { focus, query },
			current_outline: projectOutline(base.state, "director"),
			story: {
				history: boundContext(storyContext.history, budget),
				rpState: boundContext(storyContext.rpState, budget),
				world: boundContext(storyContext.world, budget),
				ecology: boundContext(storyContext.ecology, budget),
				literaryProfiles: boundContext(storyContext.literaryProfiles, budget),
			},
			researchIndex: index,
		}, null, 2);
		try {
			const parsed = parseObject(await this.#call("outlineCorpusResearch", skill.body, userText, 8192));
			const selections = Array.isArray(parsed?.selections) ? parsed.selections : [];
			const ids = new Set<string>();
			const known = new Set([...index.documents, ...index.items].map((row) => row.id));
			for (const raw of selections) {
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
				const id = typeof (raw as Record<string, unknown>).id === "string" ? (raw as Record<string, string>).id : "";
				if (known.has(id)) ids.add(id);
				if (ids.size >= 12) break;
			}
			if (ids.size) await this.#research.recordUsage(ids, "selected");
			return ids.size ? projectSelectedCorpusWorkspace(view, ids, { maxItems: 12 }) : { documents: [], mechanisms: [], assets: [], dailyPatterns: [] };
		} catch {
			return fallback;
		}
	}
	#trustedSources(branch: BranchEntryLike[]): OutlineSource[] { return branch.flatMap((row): OutlineSource[] => { const id = typeof row.id === "string" && row.id ? `branch:${row.id}` : ""; if (!id) return []; const kind: OutlineSource["kind"] | null = row.type === "assistant" || row.message?.role === "assistant" || ["rp-greeting", "rp-edited-reply"].includes(String(row.customType)) ? "narrative" : row.type === "user" || row.message?.role === "user" ? "user" : row.customType === "rp-state" ? "rp-state" : row.customType === "rp-world-state" || row.customType === "rp-ecology-state" ? "world" : null; return kind ? [{ id, kind, title: `${kind} ${row.id}`, locator: String(row.id), note: "由当前分支引擎注册的已提交证据" }] : []; }); }
	#safeQueries(topic: string, context?: OutlineContext): string[] {
		const source = topic.trim().toLowerCase();
		const abstractTopic = [
			/关系|感情|恋爱|慢热|争风吃醋|吃醋|嫉妒|追求|告白|迷弟/.test(source) ? "关系推进与人物主动性" : "",
			/悬疑|谜|伏笔|秘密|反转/.test(source) ? "悬疑伏笔与公平回收" : "",
			/校园|学院|考试|班级|竞争|联盟/.test(source) ? "校园竞争与联盟博弈" : "",
			/人物|人设|角色|弧线/.test(source) ? "人物弧线与角色主动性" : "",
			/日常|生活/.test(source) ? "日常场景与关系变化" : "",
		].filter(Boolean).join(" ") || "人物关系与叙事结构";
		// 原始主题必须保留；分类词只用于扩展检索语境，不能把用户主题替换成泛化问题。
		const subject = `${topic.trim().slice(0, 100)} ${abstractTopic}`.trim();
		const tags = [`${subject} 叙事压力 选择 后果`, `${subject} 书评 影评 节奏 失败原因`, `${subject} 可复用结构 负面案例`];
		const forbidden = [this.#deps.loadMaterials().card.name, this.#deps.loadMaterials().config.userName, context?.cardKey ?? ""].filter((x): x is string => typeof x === "string" && x.length >= 2);
		return tags.map((query) => forbidden.reduce((safe, secret) => safe.replaceAll(secret, " "), query).replace(/\s+/g, " ").trim()).filter(Boolean);
	}
	async #call(step: SideModelStep, system: string, user: string, maxTokens: number, onDelta?: (event: { kind: "text"; delta: string } | { kind: "error"; text: string }) => void): Promise<string> { const result = await this.#deps.runSideModel(step, system, user, { maxTokens, signal: this.#abort.signal, forceNonStreaming: true, ...(onDelta ? { onDelta } : {}) }); if (typeof result !== "string") throw new Error(result.error); return result; }
	#emit(): void { this.#deps.onState?.(this.getView()); }
}
