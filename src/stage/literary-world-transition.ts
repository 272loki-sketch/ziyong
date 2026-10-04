import { createHash } from "node:crypto";

import type { WorldState } from "../types.ts";
import type { BeatMsg } from "./assemble.ts";
import type { LiteraryWorldState } from "./literary-world.ts";
import { moduleKindForId, normalizeGenericWorldModule, type GenericWorldModuleState, type ModularWorldState, type WorldKernelLink } from "./literary-world-modular.ts";
import type { WorldSimulationManifest } from "./literary-world-profile.ts";
import { boundedHistory, clipPromptText } from "./prompt-budget.ts";

export const WORLD_AUDIT_ENTRY_TYPE = "rp-world-audit";

export type BeatEvidenceSource = "latest-user" | "narrative" | "rp-state" | "prior-world" | "recent-history";
export type BeatFactActuality = "established" | "reported" | "intent" | "plan" | "hypothesis";
export type BeatFactVisibility = "public" | "limited" | "secret";
export type BeatFactAgency = "user-voluntary" | "user-involuntary" | "other" | "none";

export interface BeatEvidence {
	id: string;
	source: BeatEvidenceSource;
	locator: string;
	quote: string;
}

export interface BeatFact {
	id: string;
	kind: "action" | "event" | "state" | "knowledge" | "claim" | "trace" | "time-marker" | "milestone";
	subject: string;
	predicate: string;
	actuality: BeatFactActuality;
	visibility: BeatFactVisibility;
	agency: BeatFactAgency;
	evidenceIds: string[];
}

export interface BeatElapsedTime {
	kind: "none" | "bounded" | "unknown";
	unit: "moment" | "minute" | "hour" | "day" | "week" | "scene" | "strategic-turn";
	min: number;
	max: number;
	evidenceIds: string[];
}

export interface BeatFactEnvelope {
	version: 1;
	facts: BeatFact[];
	evidence: BeatEvidence[];
	elapsed: BeatElapsedTime;
	triggerFactIds: string[];
	uncertainties: string[];
}

export interface WorldTransitionChange {
	moduleId: string;
	paths: string[];
	factIds: string[];
	reason: string;
}

export interface WorldTransitionProposal {
	version: 1;
	baseRound: number;
	outcome: "stable" | "changed";
	elapsed: BeatElapsedTime;
	changes: WorldTransitionChange[];
	nextState: LiteraryWorldState;
}

export type WorldAuditCode = "unsupported-fact" | "user-action-invented" | "secret-leak" | "plan-promoted-to-fact" | "time-scale-violation" | "module-not-active" | "cadence-not-met" | "unlisted-change" | "causal-gap" | "state-regression" | "other";

export interface WorldTransitionAuditIssue {
	code: WorldAuditCode;
	severity: "warning" | "error";
	path?: string;
	factIds: string[];
	message: string;
}

export interface WorldTransitionAudit {
	version: 1;
	verdict: "approve" | "reject";
	issues: WorldTransitionAuditIssue[];
	summary: string;
}

export interface WorldTransitionAuditEntry {
	version: 1;
	status: "committed" | "rejected" | "fact-failed" | "proposal-failed" | "audit-failed";
	narrativeEntryId: string;
	baseRound: number;
	nextRound?: number;
	cardKey?: string;
	manifestRevision?: number;
	baseStateHash: string;
	envelopeHash?: string;
	proposalHash?: string;
	nextStateHash?: string;
	elapsed?: BeatElapsedTime;
	audit?: WorldTransitionAudit;
	errors: string[];
	createdAt: string;
}

export interface WorldModuleTransition {
	moduleId: string;
	baseRevision: number;
	factIds: string[];
	reason: string;
	nextModule: GenericWorldModuleState;
}

export interface ModularWorldTransitionProposal {
	version: 2;
	baseRound: number;
	baseStateHash: string;
	outcome: "stable" | "changed";
	elapsed: BeatElapsedTime;
	moduleChanges: WorldModuleTransition[];
	nextLinks: WorldKernelLink[];
	digest: string;
}

const clean = (value: unknown, max = 300): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
	? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
	: [];
const strings = (value: unknown, maxItems = 24, maxChars = 300): string[] => Array.isArray(value)
	? value.map((item) => clean(item, maxChars)).filter(Boolean).slice(0, maxItems)
	: [];
const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;

function objectOf(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const source = value.trim();
	for (const candidate of [source, source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], source.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {}
	}
	return null;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

export function worldTransitionHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizeElapsed(value: unknown): BeatElapsedTime | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	const kind = ["none", "bounded", "unknown"].includes(String(source.kind)) ? source.kind as BeatElapsedTime["kind"] : "unknown";
	const unit = ["moment", "minute", "hour", "day", "week", "scene", "strategic-turn"].includes(String(source.unit)) ? source.unit as BeatElapsedTime["unit"] : "scene";
	const min = Math.max(0, finite(source.min));
	const max = Math.max(0, finite(source.max));
	if (kind === "none") return { kind, unit: "moment", min: 0, max: 0, evidenceIds: strings(source.evidenceIds, 12, 80) };
	if (kind === "unknown") return { kind, unit, min: 0, max: 0, evidenceIds: strings(source.evidenceIds, 12, 80) };
	if (min > max) return null;
	return { kind, unit, min, max, evidenceIds: strings(source.evidenceIds, 12, 80) };
}

export function normalizeBeatFactEnvelope(value: unknown, sources: { userText: string; narrativeText: string }): { envelope?: BeatFactEnvelope; errors: string[] } {
	const source = objectOf(value);
	if (!source) return { errors: ["输出不是 JSON 对象"] };
	const errors: string[] = [];
	const evidenceIds = new Set<string>();
	const evidence = records(source.evidence).flatMap((item): BeatEvidence[] => {
		const id = clean(item.id, 80);
		const evidenceSource = clean(item.source, 40) as BeatEvidenceSource;
		if (!id || evidenceIds.has(id) || !["latest-user", "narrative", "rp-state", "prior-world", "recent-history"].includes(evidenceSource)) return [];
		const quote = clean(item.quote, 240);
		if (["latest-user", "narrative"].includes(evidenceSource) && !quote) {
			errors.push(`证据 ${id} 缺少原文引文`);
			return [];
		}
		const normalizeQuote = (text: string) => text.normalize("NFKC").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, "").replace(/[，。！？；：、,.!?;:]/g, "").toLowerCase();
		const sourceText = evidenceSource === "latest-user" ? sources.userText : evidenceSource === "narrative" ? sources.narrativeText : "";
		if (sourceText && !sourceText.includes(quote) && !normalizeQuote(sourceText).includes(normalizeQuote(quote))) {
			const normalizedSource = normalizeQuote(sourceText);
			const normalizedQuote = normalizeQuote(quote);
			const grams = new Set(Array.from({ length: Math.max(0, normalizedQuote.length - 2) }, (_, i) => normalizedQuote.slice(i, i + 3)));
			const overlap = grams.size ? [...grams].filter((gram) => normalizedSource.includes(gram)).length / grams.size : 0;
			if (overlap >= 0.2) {
				// 模型常会把原文引文做轻微同义改写。保留这条候选证据并记录不确定性，
				// 不让软性引文误差连带丢弃事实/时间；最终世界提案仍经过独立审计。
				errors.push(`证据 ${id} 的引文不在对应原文（轻微改写，已保留为候选证据）`);
			} else {
				errors.push(`证据 ${id} 的引文不在对应原文`);
				return [];
			}
		}
		evidenceIds.add(id);
		return [{ id, source: evidenceSource, locator: clean(item.locator, 160), quote }];
	}).slice(0, 48);
	const factIds = new Set<string>();
	const facts = records(source.facts).flatMap((item): BeatFact[] => {
		const id = clean(item.id, 80);
		if (!id || factIds.has(id)) return [];
		const refs = strings(item.evidenceIds, 12, 80);
		if (!refs.length || refs.some((ref) => !evidenceIds.has(ref))) { errors.push(`事实 ${id} 引用了不存在的证据`); return []; }
		const actuality = ["established", "reported", "intent", "plan", "hypothesis"].includes(String(item.actuality)) ? item.actuality as BeatFactActuality : "hypothesis";
		const agency = ["user-voluntary", "user-involuntary", "other", "none"].includes(String(item.agency)) ? item.agency as BeatFactAgency : "none";
		if (agency === "user-voluntary" && actuality === "established" && !refs.some((ref) => evidence.find((row) => row.id === ref)?.source === "latest-user")) {
			errors.push(`用户自愿行动 ${id} 没有用户输入证据`);
			return [];
		}
		factIds.add(id);
		return [{
			id,
			kind: ["action", "event", "state", "knowledge", "claim", "trace", "time-marker", "milestone"].includes(String(item.kind)) ? item.kind as BeatFact["kind"] : "state",
			subject: clean(item.subject, 160),
			predicate: clean(item.predicate, 600),
			actuality,
			visibility: ["public", "limited", "secret"].includes(String(item.visibility)) ? item.visibility as BeatFactVisibility : "limited",
			agency,
			evidenceIds: refs,
		}];
	}).slice(0, 32);
	const elapsed = normalizeElapsed(source.elapsed);
	if (!elapsed) errors.push("经过时间结构无效");
	else if (elapsed.evidenceIds.some((id) => !evidenceIds.has(id))) errors.push("经过时间引用了不存在的证据");
	const triggerFactIds = strings(source.triggerFactIds, 24, 80).filter((id) => {
		const fact = facts.find((item) => item.id === id);
		if (!fact) { errors.push(`触发引用的事实 ${id} 未通过证据校验，已从触发清单移除`); return false; }
		if (["intent", "plan", "hypothesis"].includes(fact.actuality)) { errors.push(`未发生的事实 ${id} 不能作为世界触发`); return false; }
		return true;
	});
	// 单条坏证据只丢该事实；其余可验证事实仍可进入世界链。只有没有任何可验证事实、
	// 或 elapsed/trigger 自身结构不合法时才整体拒绝，避免模型对引文做轻微标点改写就让整拍停摆。
	const fatal = !elapsed || errors.some((error) => error.startsWith("经过时间")) || (records(source.facts).length > 0 && facts.length === 0);
	return fatal ? { errors } : { envelope: { version: 1, facts, evidence, elapsed, triggerFactIds, uncertainties: [...strings(source.uncertainties, 12, 500), ...errors].slice(0, 20) }, errors: [] };
}

const allowedWorldPaths = new Set(["digest", "events", "factions", "winds", "trends", "reputation", "economy", "enemies", "influenceChain", "blackbox.secretActions", "blackbox.secretAssets"]);

export function changedWorldPaths(previous: LiteraryWorldState, next: LiteraryWorldState): string[] {
	const paths = ["digest", "events", "factions", "winds", "trends", "reputation", "economy", "enemies", "influenceChain"] as const;
	const out = paths.filter((path) => worldTransitionHash(previous[path]) !== worldTransitionHash(next[path]));
	if (worldTransitionHash(previous.blackbox.secretActions) !== worldTransitionHash(next.blackbox.secretActions)) out.push("blackbox.secretActions" as never);
	if (worldTransitionHash(previous.blackbox.secretAssets) !== worldTransitionHash(next.blackbox.secretAssets)) out.push("blackbox.secretAssets" as never);
	return out as string[];
}

export function normalizeWorldTransitionProposal(value: unknown, previous: LiteraryWorldState, envelope: BeatFactEnvelope, manifest: WorldSimulationManifest | null, normalizeState: (value: unknown, previous: LiteraryWorldState) => LiteraryWorldState | null): { proposal?: WorldTransitionProposal; errors: string[]; warnings: string[] } {
	const source = objectOf(value);
	if (!source) return { errors: ["提案不是 JSON 对象"], warnings: [] };
	const errors: string[] = [];
	const warnings: string[] = [];
	if (Math.round(finite(source.baseRound, -1)) !== previous.round) errors.push("提案基线轮次已过期");
	const nextState = normalizeState(source.nextState, previous);
	if (!nextState) return { errors: [...errors, "下一世界快照不可解析"], warnings };
	nextState.round = previous.round + 1;
	const activeModules = new Map((manifest?.modules ?? []).filter((module) => module.mode === "active").map((module) => [module.id, module]));
	const legacyModule = manifest ? undefined : { id: "legacy-world", cadence: "every-beat" as const };
	const factIds = new Set(envelope.facts.map((fact) => fact.id));
	const changes = records(source.changes).flatMap((item): WorldTransitionChange[] => {
		const moduleId = clean(item.moduleId, 80);
		const paths = strings(item.paths, 16, 80).filter((path) => allowedWorldPaths.has(path));
		const refs = strings(item.factIds, 16, 80);
		if (!moduleId || !paths.length || !refs.length) return [];
		if (manifest && !activeModules.has(moduleId)) errors.push(`模块 ${moduleId} 未激活`);
		if (!manifest && moduleId !== legacyModule?.id) errors.push(`旧会话未声明模块，只允许 legacy-world`);
		if (refs.some((id) => !factIds.has(id))) errors.push(`模块 ${moduleId} 引用了不存在的事实`);
		const module = activeModules.get(moduleId);
		if (module?.cadence === "on-time-advance" && envelope.elapsed.kind === "none") errors.push(`模块 ${moduleId} 未满足时间推进频率`);
		if (module?.cadence === "on-trigger" && !refs.some((id) => envelope.triggerFactIds.includes(id))) errors.push(`模块 ${moduleId} 未满足触发频率`);
		if (module?.cadence === "per-day" && !(envelope.elapsed.kind === "bounded" && ["day", "week"].includes(envelope.elapsed.unit))) errors.push(`模块 ${moduleId} 未满足日级频率`);
		if (module?.cadence === "strategic-turn" && envelope.elapsed.unit !== "strategic-turn") errors.push(`模块 ${moduleId} 未满足战略回合频率`);
		if (module?.cadence === "per-arc" && !refs.some((id) => envelope.facts.find((fact) => fact.id === id)?.kind === "milestone")) errors.push(`模块 ${moduleId} 未满足篇章里程碑频率`);
		return [{ moduleId, paths, factIds: refs, reason: clean(item.reason, 600) }];
	}).slice(0, 24);
	const actual = changedWorldPaths(previous, nextState);
	const declared = new Set(changes.flatMap((change) => change.paths));
	for (const path of actual) if (!declared.has(path)) errors.push(`实际变化 ${path} 未在 changes 声明`);
	const outcome = source.outcome === "stable" ? "stable" : "changed";
	if (outcome === "stable" && actual.some((path) => path !== "digest")) errors.push("稳定提案修改了世界事实");
	for (const change of changes) if (!change.paths.some((path) => actual.includes(path))) warnings.push(`模块 ${change.moduleId} 声明了未发生的变化`);
	return errors.length ? { errors, warnings } : { proposal: { version: 1, baseRound: previous.round, outcome, elapsed: envelope.elapsed, changes, nextState }, errors: [], warnings };
}

export function dueWorldModules(manifest: WorldSimulationManifest | null, envelope: BeatFactEnvelope) {
	return (manifest?.modules ?? []).filter((module) => {
		if (module.mode !== "active") return false;
		if (module.cadence === "every-beat") return true;
		if (module.cadence === "on-time-advance") return envelope.elapsed.kind === "bounded" && envelope.elapsed.max > 0;
		if (module.cadence === "on-trigger") return envelope.triggerFactIds.length > 0;
		if (module.cadence === "per-day") return envelope.elapsed.kind === "bounded" && ["day", "week"].includes(envelope.elapsed.unit);
		if (module.cadence === "strategic-turn") return envelope.elapsed.unit === "strategic-turn";
		return envelope.facts.some((fact) => fact.kind === "milestone" && fact.actuality === "established");
	});
}

function normalizeLinks(value: unknown): WorldKernelLink[] {
	const ref = (raw: unknown) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const source = raw as Record<string, unknown>, domain = String(source.domain), recordId = clean(source.recordId, 100);
		return ["world", "ecology", "rp-state"].includes(domain) && recordId ? { domain: domain as "world" | "ecology" | "rp-state", ...(clean(source.moduleId, 80) ? { moduleId: clean(source.moduleId, 80) } : {}), recordId } : null;
	};
	return records(value).flatMap((item): WorldKernelLink[] => {
		const from = ref(item.from), to = ref(item.to), id = clean(item.id, 100);
		return from && to && id ? [{ id, from, to, relation: clean(item.relation, 200), factIds: strings(item.factIds, 16, 80) }] : [];
	}).slice(0, 120);
}

export function normalizeModularWorldProposal(value: unknown, previous: ModularWorldState, envelope: BeatFactEnvelope, manifest: WorldSimulationManifest | null): { proposal?: ModularWorldTransitionProposal; errors: string[]; warnings: string[] } {
	const source = objectOf(value); if (!source) return { errors: ["模块提案不是 JSON 对象"], warnings: [] };
	const errors: string[] = [], warnings: string[] = [];
	if (!Number.isSafeInteger(source.baseRound) || source.baseRound !== previous.round) errors.push("提案基线轮次已过期");
	if (clean(source.baseStateHash, 100) !== worldTransitionHash(previous)) errors.push("提案基线哈希不匹配");
	const due = new Map(dueWorldModules(manifest, envelope).map((module) => [module.id, module]));
	const facts = new Map(envelope.facts.map((fact) => [fact.id, fact]));
	const seen = new Set<string>();
	const moduleChanges = records(source.moduleChanges).flatMap((item): WorldModuleTransition[] => {
		const moduleId = clean(item.moduleId, 80); if (!moduleId || seen.has(moduleId)) return [];
		seen.add(moduleId);
		const declared = manifest?.modules.find((module) => module.id === moduleId);
		if (!declared || !due.has(moduleId)) { errors.push(`模块 ${moduleId} 本拍未到期或未激活`); return []; }
		const refs = strings(item.factIds, 20, 80);
		if (!refs.length || refs.some((id) => !facts.has(id))) { errors.push(`模块 ${moduleId} 引用了无效事实`); return []; }
		if (refs.some((id) => ["intent", "plan", "hypothesis"].includes(facts.get(id)!.actuality))) { errors.push(`模块 ${moduleId} 使用了未发生事实`); return []; }
		const previousModule = previous.modules[moduleId];
		const baseRevision = Number(item.baseRevision);
		if (!Number.isSafeInteger(baseRevision) || baseRevision !== (previousModule?.revision ?? 0)) errors.push(`模块 ${moduleId} revision 已过期`);
		const kind = declared.kind ?? moduleKindForId(moduleId);
		const nextModule = normalizeGenericWorldModule(item.nextModule, previousModule, { id: moduleId, kind }, previous.round + 1);
		if (!nextModule) { errors.push(`模块 ${moduleId} 状态不可解析`); return []; }
		nextModule.revision = (previousModule?.revision ?? 0) + 1;
		return [{ moduleId, baseRevision, factIds: refs, reason: clean(item.reason, 600), nextModule }];
	}).slice(0, 16);
	const nextLinks = normalizeLinks(source.nextLinks);
	const outcome = source.outcome === "stable" ? "stable" : "changed";
	if (outcome === "stable" && (moduleChanges.length || worldTransitionHash(nextLinks) !== worldTransitionHash(previous.kernel.links))) errors.push("稳定提案修改了模块或因果链接");
	if (outcome === "changed" && !moduleChanges.length && worldTransitionHash(nextLinks) === worldTransitionHash(previous.kernel.links)) warnings.push("changed 提案没有实际模块变化");
	return errors.length ? { errors, warnings } : { proposal: { version: 2, baseRound: previous.round, baseStateHash: worldTransitionHash(previous), outcome, elapsed: envelope.elapsed, moduleChanges, nextLinks, digest: clean(source.digest, 1200) || previous.digest }, errors: [], warnings };
}

export function commitModularWorldTransition(previous: ModularWorldState, proposal: ModularWorldTransitionProposal, auditHash: string, manifest: WorldSimulationManifest | null): ModularWorldState {
	const modules = { ...previous.modules };
	for (const change of proposal.moduleChanges) modules[change.moduleId] = change.nextModule;
	return { version: 2, round: previous.round + 1, digest: proposal.digest, kernel: { ...(manifest ? { cardKey: manifest.cardKey, manifestRevision: manifest.profileRevision } : {}), lastAuditHash: auditHash, links: proposal.nextLinks }, modules };
}

export function normalizeWorldTransitionAudit(value: unknown, envelope: BeatFactEnvelope): { audit?: WorldTransitionAudit; errors: string[] } {
	const source = objectOf(value);
	if (!source) return { errors: ["审计不是 JSON 对象"] };
	const factIds = new Set(envelope.facts.map((fact) => fact.id));
	const errors: string[] = [];
	const allowedCodes = new Set<WorldAuditCode>(["unsupported-fact", "user-action-invented", "secret-leak", "plan-promoted-to-fact", "time-scale-violation", "module-not-active", "cadence-not-met", "unlisted-change", "causal-gap", "state-regression", "other"]);
	const issues = records(source.issues).map((item): WorldTransitionAuditIssue => {
		const refs = strings(item.factIds, 16, 80);
		if (refs.some((id) => !factIds.has(id))) errors.push("审计引用了不存在的事实");
		return { code: allowedCodes.has(String(item.code) as WorldAuditCode) ? String(item.code) as WorldAuditCode : "other", severity: item.severity === "error" ? "error" : "warning", ...(clean(item.path, 100) ? { path: clean(item.path, 100) } : {}), factIds: refs, message: clean(item.message, 600) };
	}).slice(0, 24);
	const verdict = source.verdict === "approve" ? "approve" : "reject";
	if (verdict === "approve" && issues.some((issue) => issue.severity === "error")) errors.push("审计通过却包含错误项");
	return errors.length ? { errors } : { audit: { version: 1, verdict, issues, summary: clean(source.summary, 1000) }, errors: [] };
}

export function buildBeatFactPrompt(skillBody: string, input: { userText: string; narrativeText: string; rpState: WorldState; world: LiteraryWorldState; history: BeatMsg[]; manifest: WorldSimulationManifest | null }): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你在执行梨园的拍后事实信封工作流。Skill 是事实与信息边界规则的唯一权威；只提取，不推演。只返回合法 JSON。\n\n# 工作流 Skill\n${skillBody}`,
		userText: JSON.stringify({ latest_user: clipPromptText(input.userText, 8_000), frozen_narrative: clipPromptText(input.narrativeText, 24_000), final_rp_state: input.rpState, prior_world: input.world, card_adaptation: input.manifest, recent_history: boundedHistory(input.history, 12) }, null, 2),
	};
}

export function buildWorldProposalPrompt(skillBody: string, input: { envelope: BeatFactEnvelope; world: LiteraryWorldState | ModularWorldState; rpState: WorldState; manifest: WorldSimulationManifest | null; dueModuleIds?: string[]; moduleSkillBodies?: Array<{ name: string; body: string }>; ecologySignals?: unknown[] }): { systemPrompt: string; userText: string } {
	const due = new Set(input.dueModuleIds ?? []);
	const adaptation = input.manifest ? { ...input.manifest, modules: input.manifest.modules.filter((module) => due.has(module.id)) } : null;
	return {
		systemPrompt: `你在执行梨园的后台世界转移提案。世界 Skill 与本拍模块 Skill 是演化规则唯一权威。事实信封是本拍事实准入边界；每项变化必须引用 factIds。只返回合法 JSON，不输出正文或解释。\n\n# 世界工作流 Skill\n${skillBody}\n\n${(input.moduleSkillBodies ?? []).map((item) => `# 模块 Skill：${item.name}\n${item.body}`).join("\n\n")}`,
		userText: JSON.stringify({ base_state_hash: worldTransitionHash(input.world), current_world: input.world, final_rp_state: input.rpState, card_adaptation: adaptation, due_module_ids: [...due], ecology_signals: input.ecologySignals ?? [], fact_envelope: input.envelope }, null, 2),
	};
}

export function buildWorldAuditPrompt(skillBody: string, input: { envelope: BeatFactEnvelope; proposal: WorldTransitionProposal | ModularWorldTransitionProposal; world: LiteraryWorldState | ModularWorldState; rpState: WorldState; manifest: WorldSimulationManifest | null; preflightWarnings: string[] }): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你在执行梨园的世界转移独立审计。只审计，不修改提案，不补写世界事实。Skill 是语义审计规则唯一权威；只返回合法 JSON。\n\n# 工作流 Skill\n${skillBody}`,
		userText: JSON.stringify({ current_world: input.world, final_rp_state: input.rpState, card_adaptation: input.manifest, fact_envelope: input.envelope, transition_proposal: input.proposal, deterministic_warnings: input.preflightWarnings }, null, 2),
	};
}

export function worldAuditEntry(input: Omit<WorldTransitionAuditEntry, "version" | "createdAt">): WorldTransitionAuditEntry {
	return { version: 1, ...input, createdAt: new Date().toISOString() };
}

export interface WorldAuditWireView {
	status: WorldTransitionAuditEntry["status"];
	baseRound: number;
	nextRound?: number;
	summary: string;
	warnings: string[];
	elapsed?: BeatElapsedTime;
}

export function worldAuditFromBranch(branch: Array<{ type?: string; customType?: string; data?: unknown }>): WorldAuditWireView | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== WORLD_AUDIT_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as WorldTransitionAuditEntry;
		if (data.version !== 1 || !["committed", "rejected", "fact-failed", "proposal-failed", "audit-failed"].includes(data.status)) continue;
		return {
			status: data.status,
			baseRound: Math.max(0, Number(data.baseRound) || 0),
			...(Number.isFinite(Number(data.nextRound)) ? { nextRound: Number(data.nextRound) } : {}),
			summary: clean(data.audit?.summary, 1000) || (data.status === "committed" ? "世界变化已通过独立审计。" : "本拍世界变化未提交，保留上一快照。"),
			warnings: (data.audit?.issues ?? []).filter((issue) => issue.severity === "warning").map((issue) => clean(issue.message, 300)).filter(Boolean).slice(0, 8),
			...(data.elapsed ? { elapsed: data.elapsed } : {}),
		};
	}
	return null;
}
