import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { readJsonFile } from "../jsonio.ts";
import type { CharacterCard, LorebookEntry, WorldState } from "../types.ts";
import type { WebResearchItem } from "../tools/web-research.ts";
import type { BeatMsg, BranchEntryLike } from "./assemble.ts";
import { boundedHistory, boundedLore, clipPromptText } from "./prompt-budget.ts";

export const LITERARY_ECOLOGY_ENTRY_TYPE = "rp-ecology-state";

export interface EcologyPrototype {
	id: string;
	name: string;
	category: string;
	scale: "ambient" | "scene" | "arc";
	premise: string;
	requirements: string[];
	pressures: string[];
	developments: string[];
	tags: string[];
	sources: Array<{ title: string; url: string; note: string }>;
	patternKey: string;
	status: "active" | "deprecated";
	useCount: number;
}

export interface EcologyGlobalPool {
	version: 1;
	revision: number;
	updatedAt: string;
	digest: string;
	prototypes: EcologyPrototype[];
}

export interface EcologyCardTemplate {
	id: string;
	prototypeId: string;
	name: string;
	form: string;
	locations: string[];
	likelyActors: string[];
	constraints: string[];
	possibleDevelopments: string[];
	tags: string[];
	patternKey: string;
	status: "active" | "deprecated";
	useCount: number;
}

export interface EcologyCardPool {
	version: 1;
	cardKey: string;
	cardName: string;
	revision: number;
	updatedAt: string;
	digest: string;
	worldGrammar: string[];
	actorGrammar: string[];
	templates: EcologyCardTemplate[];
}

export interface EcologyActor {
	id: string;
	name: string;
	tier: "core" | "active" | "background";
	location: string;
	activity: string;
	shortGoal: string;
	longGoal: string;
	concern: string;
	commitments: string[];
	relations: string[];
	knowledge: string[];
	knowledgeLedger?: EcologyKnowledgeEntry[];
	nextAction: string;
	lastAdvancedRound?: number;
	nextDueRound?: number;
}

export type EcologyKnowledgeRoute = "witnessed" | "told" | "investigated" | "message" | "public-channel" | "inferred";

export interface EcologyKnowledgeEntry {
	id: string;
	subjectRef: string;
	summary: string;
	certainty: "confirmed" | "suspected";
	route: EcologyKnowledgeRoute;
	evidence: string;
	sourceRef: string;
	learnedRound: number;
	updatedRound: number;
}

export interface EcologyPublicSurface {
	publicity: "private" | "trace" | "public";
	trace: string;
	headline: string;
	summary: string;
	result: string;
	sourceType: "official" | "unofficial" | "mixed";
	claimStatus: "fact" | "mixed" | "rumor";
	audience: string[];
	scope: string;
}

/** Provenance anchor, not a deterministic proof of the quote's consent semantics. */
export interface EcologyUserCommitmentEvidence {
	source: "latest-user";
	sourceEntryId: string;
	occurrenceId: string;
	quote: string;
	/** UTF-16 offsets into the actual user entry; absent offsets require one unique exact match. */
	start?: number;
	end?: number;
}

export interface EcologyTransitionOptions {
	latestUserText?: string;
	latestUserEntryId?: string;
	/** The authoritative pre-turn snapshot. Never substitute an arrival/model candidate here. */
	committedState?: LiteraryEcologyState;
}

export interface EcologyOccurrence {
	id: string;
	name: string;
	kind: "ambient" | "activity" | "test" | "encounter" | "personal";
	status: "scheduled" | "active" | "resolved" | "expired";
	time: string;
	location: string;
	participants: string[];
	cause: string;
	development: string;
	visibility: "public" | "discoverable" | "secret";
	discovery: string;
	expires: string;
	withoutUser: string;
	userRole: "none" | "optional" | "committed";
	userCommitment?: EcologyUserCommitmentEvidence;
	prototypeId: string;
	templateId: string;
	patternKey: string;
	tone: "routine" | "light" | "dramatic";
	intrusion: "background" | "optional" | "foreground";
	createdRound: number;
	lastAdvancedRound: number;
	cooldownUntilRound: number;
	publicSurface?: EcologyPublicSurface;
	causedBy?: string[];
	communication?: EcologyCommunication;
}

export interface EcologyCommunication {
	senderRef: string;
	recipientRefs: string[];
	channel: string;
	state: "queued" | "in-transit" | "delivered" | "failed" | "cancelled";
	deliveryConstraint: string;
	contentClaim: string;
	sentRound: number;
	deliveredRound?: number;
}

export interface EcologyRecentUse { key: string; round: number }

export interface EcologySecret {
	id: string;
	subject: string;
	truth: string;
	knownBy: string[];
	traces: string[];
	revealCondition: string;
}

export interface LiteraryEcologyState {
	version: 1;
	round: number;
	digest: string;
	actors: EcologyActor[];
	occurrences: EcologyOccurrence[];
	locationStates: Array<{ location: string; state: string; activities: string[] }>;
	recentPatterns: string[];
	recentUses: EcologyRecentUse[];
	secrets: EcologySecret[];
	/** 本轮旁路失败但仍落了延续快照；用于审计，不改变生态事实。 */
	degraded?: { stage: "arrival" | "aftermath"; error: string };
	/** TS-generated diagnostics; never promote a model reference to an authority. */
	commitmentWarnings?: string[];
}

export interface EcologyWireView {
	round: number;
	digest: string;
	public: { actors: string[]; events: string[]; locations: string[] };
	discovered: { actors: string[]; events: string[] };
	propagation: Array<{ occurrenceId: string; eventName: string; publicity: "trace" | "public"; headline: string; summary: string; trace: string; result: string; sourceType: EcologyPublicSurface["sourceType"]; claimStatus: EcologyPublicSurface["claimStatus"]; audience: string[]; scope: string }>;
	spoilers: { actors: string[]; events: string[]; secrets: string[]; cognition: string[]; actorAdvances: string[] };
}

const clean = (value: unknown, max = 300): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, maxItems = 12, maxChars = 240): string[] => Array.isArray(value)
	? value.map((item) => clean(item, maxChars)).filter(Boolean).slice(0, maxItems)
	: [];
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
	? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
	: [];
const stableId = (value: unknown, prefix: string, seed: string): string => clean(value, 80) || `${prefix}_${createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;

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

export function emptyEcologyGlobalPool(): EcologyGlobalPool {
	return { version: 1, revision: 0, updatedAt: "", digest: "通用叙事原型池尚未建立。", prototypes: [] };
}

export function emptyEcologyCardPool(cardKey = "", cardName = ""): EcologyCardPool {
	return { version: 1, cardKey, cardName, revision: 0, updatedAt: "", digest: "当前角色卡生态池尚未建立。", worldGrammar: [], actorGrammar: [], templates: [] };
}

export function defaultLiteraryEcologyState(): LiteraryEcologyState {
	return { version: 1, round: 0, digest: "人物与场所尚未开始独立运行。", actors: [], occurrences: [], locationStates: [], recentPatterns: [], recentUses: [], secrets: [] };
}

export function ecologyCardKey(cwd: string, cardPath: string): string {
	const absolute = isAbsolute(cardPath) ? normalize(cardPath) : normalize(join(cwd, cardPath));
	return createHash("sha1").update(absolute.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 12);
}

export function ecologyPoolPaths(cwd: string, cardPath: string): { global: string; card: string; cardKey: string } {
	const cardKey = ecologyCardKey(cwd, cardPath);
	const root = join(cwd, ".liyuan", "ecology");
	return { global: join(root, "global-pool.json"), card: join(root, "cards", `${cardKey}.json`), cardKey };
}

function loadJson(path: string): unknown {
	try { return existsSync(path) ? readJsonFile(path) : undefined; } catch { return undefined; }
}

function saveJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(temporary, path);
}

const semantic = (...parts: string[]): string => parts.join("|").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 500);
const mergeStrings = (a: string[], b: string[], max: number): string[] => [...new Set([...a, ...b])].slice(0, max);
const canonicalUrl = (raw: string): string => {
	try {
		const url = new URL(raw);
		if (!/^https?:$/.test(url.protocol)) return "";
		url.hash = "";
		for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|ref$|source$|spm$)/i.test(key)) url.searchParams.delete(key);
		return url.toString();
	} catch { return ""; }
};

function mergeByPattern<T extends { id: string; patternKey: string }>(previous: T[], incoming: T[], merge: (old: T, next: T) => T, max: number): T[] {
	const out = [...previous];
	for (const next of incoming) {
		const at = out.findIndex((old) => old.id === next.id || old.patternKey === next.patternKey);
		if (at >= 0) out[at] = merge(out[at]!, next);
		else out.push(next);
	}
	return out.slice(-max);
}

export function normalizeEcologyGlobalPool(value: unknown, previous = emptyEcologyGlobalPool()): EcologyGlobalPool | null {
	const source = objectOf(value);
	if (!source) return null;
	const prototypes = records(source.prototypes).map((item, index): EcologyPrototype | null => {
		const name = clean(item.name, 120);
		if (!name) return null;
		const scale = ["ambient", "scene", "arc"].includes(String(item.scale)) ? item.scale as EcologyPrototype["scale"] : "scene";
		const patternKey = clean(item.patternKey, 120) || createHash("sha1").update(semantic(clean(item.category), clean(item.premise), strings(item.pressures).join("|"))).digest("hex").slice(0, 16);
		return {
			id: stableId(item.id, "proto", `${name}:${index}`), name, category: clean(item.category, 80), scale,
			premise: clean(item.premise, 500), requirements: strings(item.requirements, 8), pressures: strings(item.pressures, 8),
			developments: strings(item.developments, 12), tags: strings(item.tags, 12, 60),
			sources: records(item.sources).map((row) => ({ title: clean(row.title, 160), url: canonicalUrl(clean(row.url, 500)), note: clean(row.note, 300) })).filter((row) => row.title && row.url).slice(0, 8),
			patternKey, status: item.status === "deprecated" ? "deprecated" : "active", useCount: Math.max(0, Number(item.useCount) || 0),
		};
	}).filter((item): item is EcologyPrototype => !!item).slice(0, 240);
	const merged = mergeByPattern(previous.prototypes, prototypes, (old, next) => ({ ...old, ...next, id: old.id, developments: mergeStrings(old.developments, next.developments, 12), tags: mergeStrings(old.tags, next.tags, 12), sources: [...new Map([...old.sources, ...next.sources].map((row) => [row.url, row])).values()].slice(0, 8), useCount: old.useCount }), 240);
	return {
		version: 1,
		revision: Math.max(previous.revision + 1, Number.isFinite(Number(source.revision)) ? Math.round(Number(source.revision)) : 0),
		updatedAt: new Date().toISOString(), digest: clean(source.digest, 1000) || previous.digest,
		prototypes: merged,
	};
}

export function normalizeEcologyCardPool(value: unknown, previous: EcologyCardPool): EcologyCardPool | null {
	const source = objectOf(value);
	if (!source) return null;
	const templates = records(source.templates).map((item, index): EcologyCardTemplate | null => {
		const name = clean(item.name, 120);
		if (!name) return null;
		const patternKey = clean(item.patternKey, 120) || createHash("sha1").update(semantic(clean(item.prototypeId), clean(item.form), strings(item.locations).join("|"))).digest("hex").slice(0, 16);
		return {
			id: stableId(item.id, "template", `${name}:${index}`), prototypeId: clean(item.prototypeId, 80), name,
			form: clean(item.form, 600), locations: strings(item.locations, 12, 100), likelyActors: strings(item.likelyActors, 16, 100),
			constraints: strings(item.constraints, 12), possibleDevelopments: strings(item.possibleDevelopments, 12), tags: strings(item.tags, 12, 60),
			patternKey, status: item.status === "deprecated" ? "deprecated" : "active", useCount: Math.max(0, Number(item.useCount) || 0),
		};
	}).filter((item): item is EcologyCardTemplate => !!item).slice(0, 180);
	const merged = mergeByPattern(previous.templates, templates, (old, next) => ({ ...old, ...next, id: old.id, constraints: mergeStrings(old.constraints, next.constraints, 12), possibleDevelopments: mergeStrings(old.possibleDevelopments, next.possibleDevelopments, 12), tags: mergeStrings(old.tags, next.tags, 12), useCount: old.useCount }), 180);
	return {
		version: 1, cardKey: previous.cardKey, cardName: previous.cardName,
		revision: Math.max(previous.revision + 1, Number.isFinite(Number(source.revision)) ? Math.round(Number(source.revision)) : 0),
		updatedAt: new Date().toISOString(), digest: clean(source.digest, 1000) || previous.digest,
		worldGrammar: strings(source.worldGrammar, 40, 300).length ? strings(source.worldGrammar, 40, 300) : previous.worldGrammar,
		actorGrammar: strings(source.actorGrammar, 40, 300).length ? strings(source.actorGrammar, 40, 300) : previous.actorGrammar,
		templates: merged,
	};
}

export function loadEcologyPools(cwd: string, cardPath: string, cardName: string): { global: EcologyGlobalPool; card: EcologyCardPool } {
	const paths = ecologyPoolPaths(cwd, cardPath);
	const global = normalizeEcologyGlobalPool(loadJson(paths.global), emptyEcologyGlobalPool()) ?? emptyEcologyGlobalPool();
	const baseCard = emptyEcologyCardPool(paths.cardKey, cardName);
	const card = normalizeEcologyCardPool(loadJson(paths.card), baseCard) ?? baseCard;
	return { global, card: { ...card, cardKey: paths.cardKey, cardName } };
}

export function saveEcologyPools(cwd: string, cardPath: string, pools: { global?: EcologyGlobalPool; card?: EcologyCardPool }): void {
	const paths = ecologyPoolPaths(cwd, cardPath);
	if (pools.global) saveJson(paths.global, pools.global);
	if (pools.card) saveJson(paths.card, pools.card);
}

function normalizeUserCommitment(value: unknown): EcologyUserCommitmentEvidence | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	if (source.source !== "latest-user" || typeof source.quote !== "string" || !source.quote.trim() || source.quote.length > 2_000
		|| typeof source.sourceEntryId !== "string" || !source.sourceEntryId || source.sourceEntryId.length > 160
		|| typeof source.occurrenceId !== "string" || !source.occurrenceId || source.occurrenceId.length > 80) return undefined;
	return {
		source: "latest-user", sourceEntryId: source.sourceEntryId, occurrenceId: source.occurrenceId, quote: source.quote,
		...(Object.hasOwn(source, "start") ? { start: source.start as number } : {}),
		...(Object.hasOwn(source, "end") ? { end: source.end as number } : {}),
	};
}

export function normalizeLiteraryEcologyState(value: unknown, previous: LiteraryEcologyState): LiteraryEcologyState | null {
	const source = objectOf(value);
	if (!source) return null;
	const actors = records(source.actors).map((item, index): EcologyActor | null => {
		const name = clean(item.name, 100); if (!name) return null;
		const tier = ["core", "active", "background"].includes(String(item.tier)) ? item.tier as EcologyActor["tier"] : "active";
		const id = stableId(item.id, "actor", `${name}:${index}`);
		const old = previous.actors.find((actor) => actor.id === id || actor.name === name);
		const text = (key: keyof EcologyActor, max = 300): string => Object.hasOwn(item, key) ? clean(item[key], max) : clean(old?.[key], max);
		const list = (key: "commitments" | "relations" | "knowledge", maxItems: number): string[] => Object.hasOwn(item, key) ? strings(item[key], maxItems) : old?.[key] ?? [];
		const knowledgeLedger = records(item.knowledgeLedger).map((entry, entryIndex): EcologyKnowledgeEntry | null => {
			const subjectRef = clean(entry.subjectRef, 160);
			const summary = clean(entry.summary, 500);
			if (!subjectRef || !summary) return null;
			const route = ["witnessed", "told", "investigated", "message", "public-channel", "inferred"].includes(String(entry.route)) ? entry.route as EcologyKnowledgeRoute : "inferred";
			const certainty = route === "inferred" || entry.certainty !== "confirmed" ? "suspected" : "confirmed";
			return {
				id: stableId(entry.id, "knowledge", `${id}:${subjectRef}:${entryIndex}`), subjectRef, summary, certainty, route,
				evidence: clean(entry.evidence, 300), sourceRef: clean(entry.sourceRef, 160),
				learnedRound: Math.max(0, Number(entry.learnedRound) || old?.knowledgeLedger?.find((row) => row.subjectRef === subjectRef)?.learnedRound || previous.round),
				updatedRound: Math.max(0, Number(entry.updatedRound) || previous.round),
			};
		}).filter((entry): entry is EcologyKnowledgeEntry => !!entry).slice(0, 32);
		return {
			id, name, tier, location: text("location", 120), activity: text("activity"), shortGoal: text("shortGoal"), longGoal: text("longGoal"), concern: text("concern"),
			commitments: list("commitments", 8), relations: list("relations", 12), knowledge: list("knowledge", 12),
			knowledgeLedger: Object.hasOwn(item, "knowledgeLedger") ? knowledgeLedger : old?.knowledgeLedger ?? [], nextAction: text("nextAction"),
			lastAdvancedRound: Math.max(0, Number(item.lastAdvancedRound) || old?.lastAdvancedRound || previous.round),
			nextDueRound: Math.max(0, Number(item.nextDueRound) || old?.nextDueRound || previous.round + (tier === "background" ? 4 : 1)),
		};
	}).filter((item): item is EcologyActor => !!item).slice(0, 60);
	const occurrences = records(source.occurrences).map((item, index): EcologyOccurrence | null => {
		const name = clean(item.name, 120); if (!name) return null;
		const candidateId = stableId(item.id, "event", `${name}:${index}`);
		const old = previous.occurrences.find((occurrence) => occurrence.id === candidateId || occurrence.patternKey === clean(item.patternKey, 120));
		const kind = ["ambient", "activity", "test", "encounter", "personal"].includes(String(item.kind)) ? item.kind as EcologyOccurrence["kind"] : old?.kind ?? "activity";
		const status = ["scheduled", "active", "resolved", "expired"].includes(String(item.status)) ? item.status as EcologyOccurrence["status"] : old?.status ?? "active";
		const visibility = ["public", "discoverable", "secret"].includes(String(item.visibility)) ? item.visibility as EcologyOccurrence["visibility"] : old?.visibility ?? "discoverable";
		const patternKey = clean(item.patternKey, 120) || createHash("sha1").update(semantic(kind, clean(item.cause), clean(item.location), strings(item.participants).sort().join("|"))).digest("hex").slice(0, 16);
		const tone = ["routine", "light", "dramatic"].includes(String(item.tone)) ? item.tone as EcologyOccurrence["tone"] : old?.tone ?? "routine";
		const intrusion = ["background", "optional", "foreground"].includes(String(item.intrusion)) ? item.intrusion as EcologyOccurrence["intrusion"] : old?.intrusion ?? "background";
		const userRole = ["none", "optional", "committed"].includes(String(item.userRole)) ? item.userRole as EcologyOccurrence["userRole"] : old?.userRole ?? "optional";
		const userCommitment = Object.hasOwn(item, "userCommitment") ? normalizeUserCommitment(item.userCommitment) : old?.userCommitment;
		const oldText = (key: keyof EcologyOccurrence, max = 300): string => Object.hasOwn(item, key) ? clean(item[key], max) : clean(old?.[key], max);
		const oldList = (key: "participants" | "causedBy", maxItems: number): string[] => Object.hasOwn(item, key) ? strings(item[key], maxItems, 100) : old?.[key] ?? [];
		const publicSource = item.publicSurface && typeof item.publicSurface === "object" && !Array.isArray(item.publicSurface) ? item.publicSurface as Record<string, unknown> : null;
		const publicity = publicSource && ["private", "trace", "public"].includes(String(publicSource.publicity)) ? publicSource.publicity as EcologyPublicSurface["publicity"] : null;
		const publicSurface = publicity ? {
			publicity, trace: publicity === "private" ? "" : clean(publicSource?.trace),
			headline: publicity === "public" ? clean(publicSource?.headline, 160) : "", summary: publicity === "public" ? clean(publicSource?.summary, 500) : "",
			result: publicity === "public" ? clean(publicSource?.result, 500) : "",
			sourceType: ["official", "unofficial", "mixed"].includes(String(publicSource?.sourceType)) ? publicSource?.sourceType as EcologyPublicSurface["sourceType"] : "unofficial",
			claimStatus: ["fact", "mixed", "rumor"].includes(String(publicSource?.claimStatus)) ? publicSource?.claimStatus as EcologyPublicSurface["claimStatus"] : "mixed",
			audience: strings(publicSource?.audience, 12, 100), scope: clean(publicSource?.scope, 160),
		} satisfies EcologyPublicSurface : Object.hasOwn(item, "publicSurface") ? undefined : old?.publicSurface;
		const communicationSource = item.communication && typeof item.communication === "object" && !Array.isArray(item.communication) ? item.communication as Record<string, unknown> : null;
		const communicationState = communicationSource && ["queued", "in-transit", "delivered", "failed", "cancelled"].includes(String(communicationSource.state)) ? communicationSource.state as EcologyCommunication["state"] : null;
		const communicationCandidate = communicationState ? {
			senderRef: clean(communicationSource?.senderRef, 100), recipientRefs: strings(communicationSource?.recipientRefs, 16, 100), channel: clean(communicationSource?.channel, 100), state: communicationState,
			deliveryConstraint: clean(communicationSource?.deliveryConstraint), contentClaim: clean(communicationSource?.contentClaim, 500), sentRound: Math.max(0, Number(communicationSource?.sentRound) || previous.round),
			...(communicationState === "delivered" ? { deliveredRound: Math.max(0, Number(communicationSource?.deliveredRound) || previous.round) } : {}),
		} satisfies EcologyCommunication : Object.hasOwn(item, "communication") ? undefined : old?.communication;
		// 新的人物通讯缺任一端点时按普通事件处理，避免一个残缺可选结构拖垮整份生态候选。
		// 已提交通讯仍由旧值继承，不能借增量缺字段绕过终态与送达门禁。
		const communication = communicationCandidate && (kind === "ambient" || (communicationCandidate.senderRef && communicationCandidate.recipientRefs.length))
			? communicationCandidate
			: old?.communication;
		return { id: candidateId, name, kind, status, time: oldText("time", 120), location: oldText("location", 120), participants: oldList("participants", 16), cause: oldText("cause"), development: oldText("development", 600), visibility, discovery: oldText("discovery"), expires: oldText("expires", 120), withoutUser: oldText("withoutUser"), userRole, ...(userCommitment ? { userCommitment } : {}), prototypeId: oldText("prototypeId", 80), templateId: oldText("templateId", 80), patternKey, tone, intrusion, createdRound: Math.max(0, Number(item.createdRound) || old?.createdRound || previous.round), lastAdvancedRound: Math.max(0, Number(item.lastAdvancedRound) || old?.lastAdvancedRound || previous.round), cooldownUntilRound: Math.max(0, Number(item.cooldownUntilRound) || old?.cooldownUntilRound || 0), ...(publicSurface ? { publicSurface } : {}), causedBy: oldList("causedBy", 12), ...(communication ? { communication } : {}) };
	}).filter((item): item is EcologyOccurrence => !!item).slice(0, 80);
	const locationStates = records(source.locationStates).map((item) => ({ location: clean(item.location, 120), state: clean(item.state), activities: strings(item.activities, 12) })).filter((item) => item.location).slice(0, 30);
	const secrets = records(source.secrets).map((item, index) => ({ id: stableId(item.id, "secret", `${clean(item.subject)}:${index}`), subject: clean(item.subject, 120), truth: clean(item.truth, 600), knownBy: strings(item.knownBy, 16, 100), traces: strings(item.traces, 12), revealCondition: clean(item.revealCondition) })).filter((item) => item.subject || item.truth).slice(0, 40);
	const cooled = occurrences.filter((next) => {
		const old = previous.occurrences.find((item) => item.id === next.id || item.patternKey === next.patternKey);
		if (!old) return !previous.recentUses.some((use) => use.key === next.patternKey && use.round + 4 > previous.round);
		return old.status === "active" || old.status === "scheduled" || old.cooldownUntilRound <= previous.round;
	});
	const mergedOccurrences = mergeByPattern(previous.occurrences, cooled, (old, next) => {
		if (["resolved", "expired"].includes(old.status)) return old;
		return { ...old, ...next, id: old.id, createdRound: old.createdRound };
	}, 80);
	const recentUses = records(source.recentUses).map((item) => ({ key: clean(item.key, 160), round: Math.max(0, Number(item.round) || previous.round) })).filter((item) => item.key).slice(-80);
	return { version: 1, round: previous.round, digest: clean(source.digest, 1000) || previous.digest, actors: actors.length ? actors : previous.actors, occurrences: mergedOccurrences, locationStates: locationStates.length ? locationStates : previous.locationStates, recentPatterns: strings(source.recentPatterns, 20, 120), recentUses: recentUses.length ? recentUses : previous.recentUses, secrets: secrets.length ? secrets : previous.secrets, ...(previous.commitmentWarnings?.length ? { commitmentWarnings: [...previous.commitmentWarnings] } : {}) };
}

export function commitLiteraryEcologyRound(state: LiteraryEcologyState, previousRound: number): LiteraryEcologyState {
	const round = previousRound + 1;
	const activeKeys = state.occurrences.filter((item) => item.status === "active" || item.status === "scheduled").map((item) => item.patternKey);
	return { ...state, round, recentUses: [...state.recentUses, ...activeKeys.map((key) => ({ key, round }))].slice(-80) };
}

export function dueEcologyActors(state: LiteraryEcologyState, maximum = 8): Array<{ id: string; reason: "due" | "starvation-guard" }> {
	return [...state.actors]
		.sort((a, b) => (a.nextDueRound ?? state.round) - (b.nextDueRound ?? state.round) || (a.lastAdvancedRound ?? state.round) - (b.lastAdvancedRound ?? state.round) || a.id.localeCompare(b.id))
		.filter((actor) => (actor.nextDueRound ?? state.round) <= state.round || state.round - (actor.lastAdvancedRound ?? state.round) >= (actor.tier === "background" ? 4 : 2))
		.slice(0, Math.max(0, maximum))
		.map((actor) => ({ id: actor.id, reason: state.round - (actor.lastAdvancedRound ?? state.round) >= (actor.tier === "background" ? 4 : 2) ? "starvation-guard" : "due" }));
}

function checkedUserCommitment(occurrence: EcologyOccurrence, options: EcologyTransitionOptions): EcologyUserCommitmentEvidence | undefined {
	const evidence = occurrence.userCommitment;
	const text = options.latestUserText;
	if (!evidence || !options.latestUserEntryId || typeof text !== "string" || evidence.source !== "latest-user"
		|| evidence.sourceEntryId !== options.latestUserEntryId || evidence.occurrenceId !== occurrence.id
		|| !evidence.quote.trim() || evidence.quote.length > 2_000) return undefined;
	let start: number;
	if (evidence.start !== undefined || evidence.end !== undefined) {
		if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end)) return undefined;
		start = evidence.start!;
		if (start < 0 || evidence.end! <= start || evidence.end! > text.length || text.slice(start, evidence.end) !== evidence.quote) return undefined;
	} else {
		start = text.indexOf(evidence.quote);
		if (start < 0 || text.indexOf(evidence.quote, start + 1) >= 0) return undefined;
	}
	return { source: "latest-user", sourceEntryId: options.latestUserEntryId, occurrenceId: occurrence.id, quote: evidence.quote, start, end: start + evidence.quote.length };
}

/**
 * Validates structural constraints and sanitizes user commitment fields in `next` in place.
 * Warnings are non-fatal: an unsupported new commitment becomes optional, not an invented choice.
 * Exact quotation proves provenance/association only; consent semantics remain the Skill's duty.
 */
export function validateEcologyTransition(previous: LiteraryEcologyState, next: LiteraryEcologyState, _worldSignals: Array<{ ref?: { domain?: string; moduleId?: string; recordId?: string }; visibility?: string }> = [], options: EcologyTransitionOptions = {}): string[] {
	const authoritative = options.committedState ?? previous;
	const warnings = [...(previous.commitmentWarnings ?? [])];
	// Normalization may inherit old/terminal records by reference. Never mutate the authoritative snapshot.
	next.occurrences = next.occurrences.map((occurrence) => ({ ...occurrence }));
	for (const occurrence of next.occurrences) {
		const old = authoritative.occurrences.find((item) => item.id === occurrence.id);
		if (old?.userRole === "committed") {
			occurrence.userRole = "committed";
			if (old.userCommitment) occurrence.userCommitment = { ...old.userCommitment };
			else delete occurrence.userCommitment;
			continue;
		}
		if (occurrence.userRole !== "committed") continue;
		const evidence = checkedUserCommitment(occurrence, options);
		if (evidence) occurrence.userCommitment = evidence;
		else {
			occurrence.userRole = "optional";
			delete occurrence.userCommitment;
			warnings.push(`事件 ${occurrence.id} 的新用户承诺缺少匹配的本拍用户原文锚点，已降为 optional；引文匹配也不等于语义承诺证明。`);
		}
	}
	if (warnings.length) next.commitmentWarnings = [...new Set(warnings)].slice(-12);
	else delete next.commitmentWarnings;
	const errors: string[] = [];
	const occurrences = new Map(next.occurrences.map((item) => [item.id, item]));
	const secrets = new Set(next.secrets.map((item) => item.id));
	for (const old of previous.occurrences) {
		const current = next.occurrences.find((item) => item.id === old.id || item.patternKey === old.patternKey);
		if (current && ["resolved", "expired"].includes(old.status) && current.status !== old.status) errors.push(`终态事件 ${old.id} 不得从 ${old.status} 重开`);
	}
	for (const occurrence of next.occurrences) {
		// 大型校园/公共事件可引用未进入当前 actor 工作集的人物。
		// 参与者集合可能大于当前 actor 工作集；状态一致性由具体更新和认知门禁检查，
		// 不要求每个公共/已完成事件都物化全部参与人物。
		if (occurrence.communication) {
			// ambient/公共广播（校历、公告、OAA、环境通告）等不需要具体发收人；
			// 只有人物间直接通讯才要求明确的 sender/recipient。
			// 已通过的旧通讯若曾带发收人，仍要求保留（防倒退漂移）。
			const personal = occurrence.kind !== "ambient";
			const hadSender = previous.occurrences.find((item) => item.id === occurrence.id)?.communication?.senderRef;
			const hadRecipient = previous.occurrences.find((item) => item.id === occurrence.id)?.communication?.recipientRefs?.length;
			if (personal || hadSender) {
				if (!occurrence.communication.senderRef) errors.push(`通讯 ${occurrence.id} 缺少发送者`);
			}
			if (personal || hadRecipient) {
				if (!occurrence.communication.recipientRefs.length) errors.push(`通讯 ${occurrence.id} 缺少收件人`);
			}
		}
		const old = previous.occurrences.find((item) => item.id === occurrence.id);
		if (old?.communication && occurrence.communication) {
			const terminal = ["delivered", "failed", "cancelled"];
			if (terminal.includes(old.communication.state) && occurrence.communication.state !== old.communication.state) errors.push(`通讯 ${occurrence.id} 已处于终态 ${old.communication.state}，不得倒退`);
		}
	}
	for (const actor of next.actors) for (const entry of actor.knowledgeLedger ?? []) {
		const oldEntry = previous.actors.find((item) => item.id === actor.id)?.knowledgeLedger?.find((item) => item.id === entry.id);
		if (oldEntry && JSON.stringify(oldEntry) === JSON.stringify(entry)) continue;
		const localRefMissing = entry.subjectRef.startsWith("occurrence:")
			? !occurrences.has(entry.subjectRef.slice(11))
			: entry.subjectRef.startsWith("secret:")
				? !secrets.has(entry.subjectRef.slice(7))
				: false;
		// world/lore 引用可能尚未物化进本拍最多 30 条跨域信号；只对本生态可完整验证的引用 fail closed。
		if (localRefMissing && entry.route !== "public-channel") errors.push(`人物 ${actor.id} 的认知 ${entry.id} 引用了不存在的对象`);
		if (["told", "investigated", "message", "public-channel"].includes(entry.route) && !entry.sourceRef) errors.push(`人物 ${actor.id} 的认知 ${entry.id} 缺少来源引用`);
		if (entry.route === "message") {
			const source = entry.sourceRef.startsWith("occurrence:") ? occurrences.get(entry.sourceRef.slice(11)) : undefined;
			if (source?.communication?.state !== "delivered" || !source.communication.recipientRefs.some((id) => id === actor.id || id === actor.name)) errors.push(`人物 ${actor.id} 不能从未送达通讯获得认知`);
		}
		if (entry.route === "public-channel") {
			const source = entry.sourceRef.startsWith("occurrence:") ? occurrences.get(entry.sourceRef.slice(11)) : undefined;
			// public-channel 的具体接触证据由 evidence/sourceRef 留痕。外部公告、OAA、广播等
			// 不要求在当前 ecology 工作集中复制一份公开 occurrence；只有显式引用本域事件时才校验公开面。
			if (entry.sourceRef.startsWith("occurrence:") && (!source?.publicSurface || source.publicSurface.publicity !== "public")) errors.push(`人物 ${actor.id} 的公开渠道认知没有公开来源`);
		}
	}
	return [...new Set(errors)];
}

export function degradedLiteraryEcologyRound(state: LiteraryEcologyState, previousRound: number, stage: "arrival" | "aftermath", error: string): LiteraryEcologyState {
	return { ...commitLiteraryEcologyRound(state, previousRound), degraded: { stage, error: error.slice(0, 500) } };
}

export function applyEcologyUsage(pools: { global: EcologyGlobalPool; card: EcologyCardPool }, state: LiteraryEcologyState): { global: EcologyGlobalPool; card: EcologyCardPool } {
	const prototypeIds = new Set(state.occurrences.map((item) => item.prototypeId).filter(Boolean));
	const templateIds = new Set(state.occurrences.map((item) => item.templateId).filter(Boolean));
	return {
		global: { ...pools.global, prototypes: pools.global.prototypes.map((item) => prototypeIds.has(item.id) ? { ...item, useCount: item.useCount + 1 } : item) },
		card: { ...pools.card, templates: pools.card.templates.map((item) => templateIds.has(item.id) ? { ...item, useCount: item.useCount + 1 } : item) },
	};
}

export function literaryEcologyFromBranch(branch: BranchEntryLike[]): LiteraryEcologyState {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === LITERARY_ECOLOGY_ENTRY_TYPE) {
			const raw = entry.data as { round?: unknown; commitmentWarnings?: unknown } | undefined;
			const parsed = normalizeLiteraryEcologyState(entry.data, { ...defaultLiteraryEcologyState(), round: Math.max(0, Number(raw?.round) || 0) });
			if (parsed) return { ...parsed, ...(strings(raw?.commitmentWarnings, 12, 300).length ? { commitmentWarnings: strings(raw?.commitmentWarnings, 12, 300) } : {}) };
		}
	}
	return defaultLiteraryEcologyState();
}

export function ecologySearchQueries(value: unknown): string[] {
	const source = objectOf(value);
	return [...new Set(strings(source?.queries, 12, 160).filter((query) => query.length >= 2))];
}

function redactLiteral(value: string, secret: string): string {
	const needle = secret.trim();
	if (!needle) return value;
	return value.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), "用户角色");
}

/** 给检索规划模型的剧情线索：保留地点/活动主题，但绝不发送用户栏姓名。 */
export function ecologySearchSceneCue(input: { userText: string; userName?: string; state: WorldState }): { latestAction: string; time: string; location: string } {
	const redact = (value: string): string => redactLiteral(value, input.userName ?? "").replace(/\s+/g, " ").trim();
	return {
		latestAction: redact(input.userText).slice(0, 1200),
		time: redact(input.state.time).slice(0, 120),
		location: redact(input.state.location).slice(0, 200),
	};
}

function skillPrompt(task: string, skillBody: string): string {
	return `你在执行梨园的${task}工作流。Skill 是规则唯一权威，代码只负责输入、解析与持久化。严格只返回 Skill 要求的合法 JSON，不输出 Markdown、解释或角色扮演正文。\n\n# 工作流 Skill\n${skillBody}`;
}

export function buildEcologySearchPlanPrompt(skillBody: string, input: { global: EcologyGlobalPool; card: CharacterCard; state: WorldState; userText: string; userName?: string }): { systemPrompt: string; userText: string } {
	return { systemPrompt: skillPrompt("通用叙事原型检索规划", skillBody), userText: JSON.stringify({ phase: "plan_queries", current_scene_cue: ecologySearchSceneCue(input), existing_pool_digest: input.global.digest, existing_categories: [...new Set(input.global.prototypes.map((item) => item.category))], existing_tags: input.global.prototypes.flatMap((item) => item.tags).slice(-80), safe_genre_tags: input.card.tags.slice(0, 20), allowed_dimensions: ["当前地点相关活动", "当前行动相关素材", "日常活动", "人物职业与私人生活", "公共场所运行", "制度与轻量考验", "群体协作", "环境变化", "关系扰动", "可错过机会", "现实学校或社区活动", "叙事结构分析"] }, null, 2) };
}

export function buildEcologyGlobalPrompt(skillBody: string, input: { global: EcologyGlobalPool; research: WebResearchItem[]; card: CharacterCard; userText: string }): { systemPrompt: string; userText: string } {
	const working = [...input.global.prototypes].sort((a, b) => Number(a.status === "active") - Number(b.status === "active") || a.useCount - b.useCount).slice(0, 60);
	return { systemPrompt: skillPrompt("通用叙事原型池", skillBody), userText: JSON.stringify({ phase: "merge_research", pool_digest: input.global.digest, pool_revision: input.global.revision, prototype_working_set: working, research_results: input.research, current_genre_hint: { name: input.card.name, scenario: input.card.scenario, tags: input.card.tags } }, null, 2) };
}

export function buildEcologyCardPrompt(skillBody: string, input: { global: EcologyGlobalPool; cardPool: EcologyCardPool; card: CharacterCard; lore: LorebookEntry[]; state: WorldState; history: BeatMsg[] }): { systemPrompt: string; userText: string } {
	const prototypes = input.global.prototypes.filter((item) => item.status === "active").sort((a, b) => a.useCount - b.useCount).slice(0, 60);
	const templates = input.cardPool.templates.filter((item) => item.status === "active").sort((a, b) => a.useCount - b.useCount).slice(0, 50);
	return { systemPrompt: skillPrompt("角色卡生态适配池", skillBody), userText: JSON.stringify({ current_card_pool: { ...input.cardPool, templates }, global_prototypes: prototypes, character_card: { name: input.card.name, description: clipPromptText(input.card.description, 8_000), personality: clipPromptText(input.card.personality, 5_000), scenario: clipPromptText(input.card.scenario, 5_000), tags: input.card.tags.slice(0, 30) }, world_lore: boundedLore(input.lore, 30, 28_000), current_state: input.state, recent_history: boundedHistory(input.history, 12, 36_000) }, null, 2) };
}

export function buildEcologyRuntimePrompt(skillBody: string, input: { phase: "arrival" | "aftermath"; ecology: LiteraryEcologyState; global: EcologyGlobalPool; cardPool: EcologyCardPool; lore?: LorebookEntry[]; state: WorldState; history: BeatMsg[]; userText: string; userEntryId?: string; narrativeText?: string; worldSignals?: unknown[] }): { systemPrompt: string; userText: string } {
	const templates = input.cardPool.templates.filter((item) => item.status === "active").sort((a, b) => a.useCount - b.useCount).slice(0, 40);
	return { systemPrompt: skillPrompt("人物与场所生态运行", skillBody), userText: JSON.stringify({ phase: input.phase, current_ecology: input.ecology, due_actors: dueEcologyActors(input.ecology), global_pool_digest: input.global.digest, card_ecology: { ...input.cardPool, templates }, world_lore: boundedLore(input.lore ?? [], 40, 24_000), current_scene_state: input.state, world_constraints: input.worldSignals ?? [], recent_history: boundedHistory(input.history, 16), latest_turn: { user: clipPromptText(input.userText, 8_000), user_entry_id: input.userEntryId ?? null, narrative: clipPromptText(input.narrativeText, 20_000) } }, null, 2) };
}

export function formatLiteraryEcologyInjection(ecology: LiteraryEcologyState, maxChars = 6000): string | undefined {
	if (ecology.round <= 0) return undefined;
	const publicEvents = ecology.occurrences.filter((item) => item.visibility === "public" && ["scheduled", "active"].includes(item.status));
	const discoverable = ecology.occurrences.filter((item) => item.visibility === "discoverable" && ["scheduled", "active"].includes(item.status));
	const visibleActors = ecology.actors.filter((item) => item.tier !== "background" && item.location);
	const lines = [`生态轮次：${ecology.round}`, `概况：${ecology.digest}`];
	if (ecology.locationStates.length) lines.push(`场所正在运行：${ecology.locationStates.map((item) => `${item.location}：${item.state}${item.activities.length ? `（${item.activities.join("、")}）` : ""}`).join("；")}`);
	if (publicEvents.length) lines.push(`公开可知：${publicEvents.map((item) => `${item.name}@${item.location}：${item.development}`).join("；")}`);
	const publicTraces = ecology.occurrences.filter((item) => item.publicSurface && item.publicSurface.publicity !== "private");
	if (publicTraces.length) lines.push(`社会传播面：${publicTraces.map((item) => item.publicSurface!.publicity === "trace" ? `${item.name}：${item.publicSurface!.trace}` : `${item.publicSurface!.headline || item.name}：${item.publicSurface!.summary || item.publicSurface!.trace}`).join("；")}`);
	if (discoverable.length) lines.push(`可经合理接触发现：${discoverable.map((item) => `${item.name}@${item.location}；发现条件：${item.discovery || "进入场所或接触参与者"}`).join("；")}`);
	if (visibleActors.length) lines.push(`人物此刻：${visibleActors.map((item) => `${item.name}@${item.location}，正在${item.activity || "处理自己的事情"}`).join("；")}`);
	if (ecology.secrets.length || ecology.occurrences.some((item) => item.visibility === "secret")) lines.push("信息边界：生态中存在用户角色尚不知道的行动、动机或事件；不得让角色凭系统全知直接泄露，只能按目击、交谈、痕迹和传播自然显露。");
	return lines.join("\n").slice(0, maxChars) || undefined;
}

export function ecologyWireView(ecology: LiteraryEcologyState): EcologyWireView {
	const eventText = (item: EcologyOccurrence) => `${item.name}｜${item.status}｜${item.time || "时间未定"}｜${item.location || "地点未定"}｜${item.development}`;
	return {
		round: ecology.round, digest: ecology.digest,
		public: {
			actors: ecology.actors.filter((item) => item.tier !== "background").map((item) => `${item.name}｜${item.location || "地点未知"}｜${item.activity || "行动未明"}`),
			events: ecology.occurrences.filter((item) => item.visibility === "public").map(eventText),
			locations: ecology.locationStates.map((item) => `${item.location}｜${item.state}${item.activities.length ? `｜${item.activities.join("、")}` : ""}`),
		},
		discovered: {
			actors: ecology.actors.filter((item) => item.tier === "background").map((item) => `${item.name}｜${item.location || "地点未知"}｜${item.activity || "行动未明"}`),
			events: ecology.occurrences.filter((item) => item.visibility === "discoverable").map(eventText),
		},
		propagation: ecology.occurrences.flatMap((item) => item.publicSurface && item.publicSurface.publicity !== "private" ? [{ occurrenceId: item.id, eventName: item.name, publicity: item.publicSurface.publicity, headline: item.publicSurface.headline, summary: item.publicSurface.summary, trace: item.publicSurface.trace, result: item.publicSurface.result, sourceType: item.publicSurface.sourceType, claimStatus: item.publicSurface.claimStatus, audience: item.publicSurface.audience, scope: item.publicSurface.scope }] : []),
		spoilers: {
			actors: ecology.actors.map((item) => `${item.name}｜短期目标：${item.shortGoal || "-"}｜长期目标：${item.longGoal || "-"}｜下一步：${item.nextAction || "-"}`),
			events: ecology.occurrences.filter((item) => item.visibility === "secret").map(eventText),
			secrets: ecology.secrets.map((item) => `${item.subject}｜${item.truth}｜知情者：${item.knownBy.join("、") || "无人"}｜揭露条件：${item.revealCondition || "未定"}`),
			cognition: ecology.actors.flatMap((actor) => (actor.knowledgeLedger ?? []).map((entry) => `${actor.name}｜${entry.certainty === "confirmed" ? "确认" : "怀疑"}｜${entry.summary}｜来源：${entry.route}${entry.evidence ? `（${entry.evidence}）` : ""}`)),
			actorAdvances: ecology.actors.filter((actor) => actor.lastAdvancedRound === ecology.round).map((actor) => `${actor.name}｜本轮已推进｜下一步：${actor.nextAction || "维持当前生活"}｜下次检查：第 ${actor.nextDueRound ?? ecology.round + 1} 轮`),
		},
	};
}
