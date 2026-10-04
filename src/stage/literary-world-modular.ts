import type { BranchEntryLike } from "./assemble.ts";
import type { LiteraryWorldState } from "./literary-world.ts";
import type { WorldSimulationManifest } from "./literary-world-profile.ts";

export type WorldModuleKind = "institution" | "social" | "infrastructure" | "rules" | "objective" | "mystery" | "strategy" | "survival" | "environment" | "custom" | "legacy";
export type WorldRecordFacet = "event" | "faction" | "wind" | "trend" | "reputation" | "economy" | "enemy" | "influence" | "secret-action" | "secret-asset" | "actor" | "location" | "resource" | "clock" | "track" | "clue" | "rule" | "objective" | "custom";
export type WorldVisibility = "public" | "discoverable" | "secret";
export type WorldAttribute = string | number | boolean | null | string[];

export interface WorldDomainRef {
	domain: "world" | "ecology" | "rp-state";
	moduleId?: string;
	recordId: string;
}

export interface WorldModuleRecord {
	id: string;
	facet: WorldRecordFacet;
	label: string;
	status: string;
	summary: string;
	visibility: WorldVisibility;
	attributes: Record<string, WorldAttribute>;
	originRefs: WorldDomainRef[];
	updatedRound: number;
}

export interface GenericWorldModuleState {
	id: string;
	kind: WorldModuleKind;
	revision: number;
	summary: string;
	records: WorldModuleRecord[];
}

export interface WorldKernelLink {
	id: string;
	from: WorldDomainRef;
	to: WorldDomainRef;
	relation: string;
	factIds: string[];
}

export interface ModularWorldState {
	version: 2;
	round: number;
	digest: string;
	kernel: {
		cardKey?: string;
		manifestRevision?: number;
		lastAuditHash?: string;
		links: WorldKernelLink[];
	};
	modules: Record<string, GenericWorldModuleState>;
}

export interface ModularWorldWireModule {
	id: string;
	name: string;
	kind: WorldModuleKind;
	revision: number;
	summary: string;
	publicRecords: WorldModuleRecord[];
	discoverableRecords: WorldModuleRecord[];
	secretCount: number;
}

export interface ModularWorldWireView {
	version: 2;
	round: number;
	digest: string;
	modules: ModularWorldWireModule[];
}

const MODULE_KIND_BY_ID: Record<string, WorldModuleKind> = {
	"institution-calendar": "institution",
	"public-information": "social", "reputation-social": "social", "relationship-dynamics": "social", "household-routine": "social",
	"infrastructure-city": "infrastructure", "economy-market": "infrastructure",
	"cultivation-system": "rules", "magic-system": "rules", "technology-system": "rules", "mechanics-resolution": "rules", "combat-tactical": "rules",
	"quest-objective": "objective", "mystery-evidence": "mystery",
	"organization-strategy": "strategy", "war-front": "strategy",
	"survival-pressure": "survival", "regional-environment": "environment",
};

export const WORLD_MODULE_PACK_BY_KIND: Record<WorldModuleKind, string> = {
	institution: "institution", social: "social", infrastructure: "infrastructure", rules: "rules", objective: "objective",
	mystery: "mystery", strategy: "strategy", survival: "survival", environment: "environment", custom: "custom", legacy: "legacy",
};

export function moduleKindForId(id: string): WorldModuleKind {
	return MODULE_KIND_BY_ID[id] ?? (id.startsWith("legacy-") ? "legacy" : "custom");
}

const clean = (value: unknown, max = 300): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
const strings = (value: unknown, max = 20, chars = 200): string[] => Array.isArray(value) ? value.map((item) => clean(item, chars)).filter(Boolean).slice(0, max) : [];

function refOf(value: unknown): WorldDomainRef | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	const domain = ["world", "ecology", "rp-state"].includes(String(source.domain)) ? source.domain as WorldDomainRef["domain"] : null;
	const recordId = clean(source.recordId, 100);
	return domain && recordId ? { domain, ...(clean(source.moduleId, 80) ? { moduleId: clean(source.moduleId, 80) } : {}), recordId } : null;
}

function attributeOf(value: unknown): Record<string, WorldAttribute> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const entries: Array<[string, WorldAttribute]> = [];
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const k = clean(key, 80); if (!k) continue;
		if (Array.isArray(item)) entries.push([k, strings(item, 16, 300)]);
		else if (item === null || typeof item === "number" || typeof item === "boolean") entries.push([k, item]);
		else entries.push([k, clean(item, 500)]);
		if (entries.length >= 24) break;
	}
	return Object.fromEntries(entries);
}

export function normalizeGenericWorldModule(value: unknown, previous: GenericWorldModuleState | undefined, expected: { id: string; kind: WorldModuleKind }, round: number): GenericWorldModuleState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	if (clean(source.id, 80) !== expected.id) return null;
	if (source.kind !== undefined && source.kind !== expected.kind) return null;
	const seen = new Set<string>();
	const facets = new Set<WorldRecordFacet>(["event", "faction", "wind", "trend", "reputation", "economy", "enemy", "influence", "secret-action", "secret-asset", "actor", "location", "resource", "clock", "track", "clue", "rule", "objective", "custom"]);
	const rows = records(source.records).flatMap((item): WorldModuleRecord[] => {
		const id = clean(item.id, 100); if (!id || seen.has(id)) return [];
		seen.add(id);
		const facet = facets.has(String(item.facet) as WorldRecordFacet) ? String(item.facet) as WorldRecordFacet : "custom";
		const visibility = ["public", "discoverable", "secret"].includes(String(item.visibility)) ? item.visibility as WorldVisibility : "discoverable";
		return [{ id, facet, label: clean(item.label, 140) || id, status: clean(item.status, 120), summary: clean(item.summary, 800), visibility, attributes: attributeOf(item.attributes), originRefs: records(item.originRefs).map(refOf).filter((ref): ref is WorldDomainRef => !!ref).slice(0, 16), updatedRound: Math.max(0, Math.round(Number(item.updatedRound) || round)) }];
	}).slice(0, 80);
	return { id: expected.id, kind: expected.kind, revision: previous?.revision ?? Math.max(0, Math.round(Number(source.revision) || 0)), summary: clean(source.summary, 1000) || previous?.summary || "", records: rows };
}

export function defaultModularWorldState(manifest?: WorldSimulationManifest | null): ModularWorldState {
	return { version: 2, round: 0, digest: "世界尚未开始模块化演化。", kernel: { ...(manifest ? { cardKey: manifest.cardKey, manifestRevision: manifest.profileRevision } : {}), links: [] }, modules: {} };
}

const legacyRecord = (id: string, facet: WorldRecordFacet, label: string, status: string, summary: string, attributes: Record<string, WorldAttribute> = {}, visibility: WorldVisibility = "public"): WorldModuleRecord => ({ id, facet, label, status, summary, visibility, attributes, originRefs: [], updatedRound: 0 });

export function migrateLiteraryWorldV1(state: LiteraryWorldState): ModularWorldState {
	const modules: Record<string, GenericWorldModuleState> = {};
	const add = (id: string, summary: string, records: WorldModuleRecord[]) => { if (records.length) modules[id] = { id, kind: "legacy", revision: 0, summary, records }; };
	add("legacy-events", "旧版事件与影响链", [
		...state.events.map((item) => legacyRecord(item.id, "event", item.name, item.stage, item.description, { type: item.type, level: item.level })),
		...state.influenceChain.map((item, i) => legacyRecord(`influence_${i + 1}`, "influence", item.trigger, "", item.impact, { fallout: item.fallout })),
	]);
	add("legacy-organizations", "旧版势力与对立关系", [
		...state.factions.map((item) => legacyRecord(item.id, "faction", item.name, item.status, item.goal, { scope: item.scope, relation: item.relation })),
		...state.enemies.map((item) => legacyRecord(item.id, "enemy", item.name, item.status, item.reason)),
	]);
	add("legacy-information", "旧版风声与声誉", [
		...state.winds.map((item) => legacyRecord(item.id, "wind", item.topic, item.type, item.content, { level: item.level, scope: item.scope, source: item.source })),
		...Object.entries(state.reputation).map(([name, value]) => legacyRecord(`reputation_${name}`, "reputation", name, "", value)),
	]);
	add("legacy-macro", "旧版大势与经济", [
		...state.trends.map((item) => legacyRecord(item.id, "trend", item.name, item.status, item.description, { scope: item.scope })),
		legacyRecord("economy", "economy", "经济", state.economy.climate, state.economy.signals.join("；")),
	]);
	add("legacy-secrets", "旧版幕后信息", [
		...state.blackbox.secretActions.map((item, i) => legacyRecord(`secret_action_${i + 1}`, "secret-action", item.action, "", item.trace, { witnesses: item.witnesses }, "secret")),
		...state.blackbox.secretAssets.map((item, i) => legacyRecord(`secret_asset_${i + 1}`, "secret-asset", item.name, item.status, item.exposure, {}, "secret")),
	]);
	return { version: 2, round: state.round, digest: state.digest, kernel: { links: [] }, modules };
}

export function normalizeModularWorldState(value: unknown, manifest?: WorldSimulationManifest | null): ModularWorldState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const source = value as Record<string, unknown>;
	if (source.version !== 2) return null;
	const round = Math.max(0, Math.round(Number(source.round) || 0));
	const modulesSource = source.modules && typeof source.modules === "object" && !Array.isArray(source.modules) ? source.modules as Record<string, unknown> : {};
	const modules: Record<string, GenericWorldModuleState> = {};
	for (const [id, raw] of Object.entries(modulesSource).slice(0, 16)) {
		const expectedKind = manifest?.modules.find((item) => item.id === id)?.kind ?? moduleKindForId(id);
		const parsed = normalizeGenericWorldModule(raw, undefined, { id, kind: expectedKind }, round);
		if (parsed) modules[id] = parsed;
	}
	const kernelSource = source.kernel && typeof source.kernel === "object" && !Array.isArray(source.kernel) ? source.kernel as Record<string, unknown> : {};
	const links = records(kernelSource.links).flatMap((item): WorldKernelLink[] => {
		const id = clean(item.id, 100), from = refOf(item.from), to = refOf(item.to);
		return id && from && to ? [{ id, from, to, relation: clean(item.relation, 200), factIds: strings(item.factIds, 16, 80) }] : [];
	}).slice(0, 120);
	return { version: 2, round, digest: clean(source.digest, 1200) || "世界保持稳定。", kernel: { ...(clean(kernelSource.cardKey, 100) ? { cardKey: clean(kernelSource.cardKey, 100) } : {}), ...(Number.isFinite(Number(kernelSource.manifestRevision)) ? { manifestRevision: Number(kernelSource.manifestRevision) } : {}), ...(clean(kernelSource.lastAuditHash, 100) ? { lastAuditHash: clean(kernelSource.lastAuditHash, 100) } : {}), links }, modules };
}

export function modularWorldFromBranch(branch: BranchEntryLike[], manifest?: WorldSimulationManifest | null): ModularWorldState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== "rp-world-state") continue;
		const raw = entry.data as { version?: unknown } | undefined;
		if (raw?.version === 2) return normalizeModularWorldState(entry.data, manifest) ?? defaultModularWorldState(manifest);
		if (raw?.version === 1) return migrateLiteraryWorldV1(entry.data as LiteraryWorldState);
	}
	return defaultModularWorldState(manifest);
}

const num = (value: WorldAttribute | undefined, fallback = 1) => typeof value === "number" ? value : Number(value) || fallback;
const str = (value: WorldAttribute | undefined) => typeof value === "string" ? value : "";

export function projectLiteraryWorldV1(state: ModularWorldState): LiteraryWorldState {
	const all = Object.values(state.modules).flatMap((module) => module.records);
	return {
		version: 1, round: state.round, digest: state.digest,
		events: all.filter((r) => r.facet === "event").slice(0, 16).map((r) => ({ id: r.id, name: r.label, type: r.attributes.type === "progress" ? "progress" : "conflict", level: Math.max(1, Math.min(4, num(r.attributes.level))), stage: r.status, description: r.summary })),
		factions: all.filter((r) => r.facet === "faction").slice(0, 15).map((r) => ({ id: r.id, name: r.label, scope: str(r.attributes.scope), status: r.status, relation: str(r.attributes.relation), goal: r.summary })),
		winds: all.filter((r) => r.facet === "wind").slice(0, 12).map((r) => ({ id: r.id, topic: r.label, type: ["announcement", "report", "rumor", "sentiment"].includes(r.status) ? r.status as "announcement" | "report" | "rumor" | "sentiment" : "report", level: Math.max(1, Math.min(4, num(r.attributes.level))), content: r.summary, scope: str(r.attributes.scope), source: str(r.attributes.source) })),
		trends: all.filter((r) => r.facet === "trend").slice(0, 6).map((r) => ({ id: r.id, name: r.label, scope: str(r.attributes.scope), status: r.status, description: r.summary })),
		reputation: Object.fromEntries(all.filter((r) => r.facet === "reputation").slice(0, 12).map((r) => [r.label, r.summary])),
		economy: { climate: all.find((r) => r.facet === "economy")?.status || "平稳", signals: all.filter((r) => r.facet === "economy").map((r) => r.summary).filter(Boolean).slice(0, 8) },
		enemies: all.filter((r) => r.facet === "enemy").slice(0, 8).map((r) => ({ id: r.id, name: r.label, reason: r.summary, status: r.status })),
		influenceChain: all.filter((r) => r.facet === "influence").slice(0, 12).map((r) => ({ trigger: r.label, impact: r.summary, fallout: str(r.attributes.fallout) })),
		blackbox: {
			secretActions: all.filter((r) => r.facet === "secret-action").slice(0, 12).map((r) => ({ action: r.label, witnesses: str(r.attributes.witnesses), trace: r.summary })),
			secretAssets: all.filter((r) => r.facet === "secret-asset").slice(0, 12).map((r) => ({ name: r.label, exposure: r.summary, status: r.status })),
		},
	};
}

export function modularWorldWireView(state: ModularWorldState, manifest?: WorldSimulationManifest | null): ModularWorldWireView {
	const names = new Map((manifest?.modules ?? []).map((module) => [module.id, module.name]));
	const order = new Map((manifest?.modules ?? []).map((module, index) => [module.id, index]));
	return { version: 2, round: state.round, digest: state.digest, modules: Object.values(state.modules).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999)).map((module) => ({ id: module.id, name: names.get(module.id) ?? module.id, kind: module.kind, revision: module.revision, summary: module.summary, publicRecords: module.records.filter((r) => r.visibility === "public"), discoverableRecords: module.records.filter((r) => r.visibility === "discoverable"), secretCount: module.records.filter((r) => r.visibility === "secret").length })) };
}

export function formatModularWorldInjection(state: ModularWorldState, manifest?: WorldSimulationManifest | null, maxChars = 6000): string | undefined {
	if (state.round <= 0) return undefined;
	const view = modularWorldWireView(state, manifest);
	const lines = [`轮次：${state.round}`, `摘要：${state.digest}`];
	for (const module of view.modules) {
		const visible = [...module.publicRecords, ...module.discoverableRecords];
		if (visible.length) lines.push(`${module.name}：${visible.map((r) => `${r.label}（${r.status || "持续中"}）：${r.summary}`).join("；")}`);
		if (module.secretCount) lines.push(`${module.name}信息边界：存在 ${module.secretCount} 条未公开记录，未通过合理渠道发现前不得让角色知晓。`);
	}
	return lines.join("\n").slice(0, maxChars) || undefined;
}
