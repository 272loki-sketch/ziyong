import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { readJsonFile } from "../jsonio.ts";
import type { CharacterCard, LorebookEntry } from "../types.ts";
import type { RpPreset } from "../preset.ts";
import type { BranchEntryLike } from "./assemble.ts";
import { moduleKindForId, WORLD_MODULE_PACK_BY_KIND, type WorldModuleKind } from "./literary-world-modular.ts";

export const WORLD_MANIFEST_ENTRY_TYPE = "rp-world-manifest";

export type WorldProfileStatus = "draft" | "stable";
export type WorldModuleMode = "observe" | "active" | "suspended";
export type WorldModuleCadence = "every-beat" | "on-time-advance" | "on-trigger" | "per-day" | "per-arc" | "strategic-turn";

export interface WorldProfileEvidence {
	source: string;
	claim: string;
}

export interface WorldProfileModule {
	id: string;
	name: string;
	mode: WorldModuleMode;
	cadence: WorldModuleCadence;
	confidence: number;
	reason: string;
	stateFocus: string[];
	writerProjection: string;
	kind: WorldModuleKind;
	skillPack: string;
}

export interface CardWorldProfile {
	version: 1;
	cardKey: string;
	cardName: string;
	revision: number;
	analyzedTurns: number;
	status: WorldProfileStatus;
	sourceFingerprint: string;
	updatedAt: string;
	digest: string;
	labels: string[];
	primaryScale: "intimate" | "scene" | "local" | "institutional" | "regional" | "epic";
	defaultTimeStep: "moment" | "scene" | "hour" | "day" | "week" | "strategic-turn";
	worldActivity: "quiet" | "low" | "normal" | "active" | "epic";
	modules: WorldProfileModule[];
	disabledModules: string[];
	userRequirements: string[];
	optimizationNotes: string[];
	unresolvedQuestions: string[];
	evidence: WorldProfileEvidence[];
}

export interface WorldSimulationManifest {
	version: 1;
	cardKey: string;
	profileRevision: number;
	profileStatus: WorldProfileStatus;
	digest: string;
	primaryScale: CardWorldProfile["primaryScale"];
	defaultTimeStep: CardWorldProfile["defaultTimeStep"];
	worldActivity: CardWorldProfile["worldActivity"];
	modules: WorldProfileModule[];
	disabledModules: string[];
	userRequirements: string[];
	createdAt: string;
	/** 同一卡不同开场/世界书/预设组合的玩法槽；基础画像共享，分支 Manifest 保留具体玩法。 */
	playKey?: string;
}

const clean = (value: unknown, max = 300): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, maxItems = 20, maxChars = 300): string[] => Array.isArray(value)
	? value.map((item) => clean(item, maxChars)).filter(Boolean).slice(0, maxItems)
	: [];
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
	? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
	: [];
const confidence = (value: unknown): number => Math.max(0, Math.min(1, Number(value) || 0));

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

export function legacyWorldCardKey(cwd: string, cardPath: string): string {
	const absolute = isAbsolute(cardPath) ? normalize(cardPath) : normalize(join(cwd, cardPath));
	return createHash("sha1").update(absolute.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 12);
}

export function worldCardKey(cwd: string, cardPath: string, card?: CharacterCard): string {
	if (!card) return legacyWorldCardKey(cwd, cardPath);
	// 身份只取卡自身的稳定内容，不取预设、挂载书和开场选择；移动文件或迁移项目后仍能找到同一适配。
	const identity = { name: card.name, description: card.description, personality: card.personality, scenario: card.scenario, creatorNotes: card.creatorNotes, tags: card.tags, book: card.book };
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}

export function worldProfilePath(cwd: string, cardPath: string, card?: CharacterCard): string {
	return join(cwd, ".liyuan", "world", "cards", worldCardKey(cwd, cardPath, card), "profile.json");
}

export function worldProfileFingerprint(input: {
	card: CharacterCard;
	entries: LorebookEntry[];
	preset: RpPreset | null;
	greetingIndex?: number;
}): string {
	const material = {
		card: input.card,
		lore: input.entries.map((entry) => ({ source: entry.source, title: entry.comment, keys: entry.keys, content: entry.content })),
		preset: input.preset ? {
			name: input.preset.name,
			blocks: input.preset.blocks.filter((block) => block.enabled).map((block) => ({ name: block.name, channel: block.channel, content: block.content })),
		} : null,
		greetingIndex: input.greetingIndex ?? 0,
	};
	return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function worldPlayKey(sourceFingerprint: string): string {
	return sourceFingerprint.slice(0, 16);
}

export function defaultCardWorldProfile(cwd: string, cardPath: string, cardName: string, sourceFingerprint = "", card?: CharacterCard): CardWorldProfile {
	return {
		version: 1,
		cardKey: worldCardKey(cwd, cardPath, card),
		cardName,
		revision: 0,
		analyzedTurns: 0,
		status: "draft",
		sourceFingerprint,
		updatedAt: "",
		digest: "当前角色卡尚未建立独立世界适配。",
		labels: [],
		primaryScale: "scene",
		defaultTimeStep: "scene",
		worldActivity: "normal",
		modules: [],
		disabledModules: [],
		userRequirements: [],
		optimizationNotes: [],
		unresolvedQuestions: [],
		evidence: [],
	};
}

export function normalizeCardWorldProfile(
	value: unknown,
	base: CardWorldProfile,
	opts?: { preserveStatus?: boolean; sourceFingerprint?: string; analyzedTurns?: number },
): CardWorldProfile | null {
	let source = objectOf(value);
	if (!source) return null;
	// 有些推理模型会把交付包在 profile/result/data 下；只接受单层对象包裹，避免为了
	// provider 文风差异让完整画像不可用。
	const wrapped = [source.profile, source.result, source.data].find((item) => item && typeof item === "object" && !Array.isArray(item));
	if (wrapped && !source.modules && !source.digest) source = wrapped as Record<string, unknown>;
	const analyzedTurnsSource = Number(source.analyzedTurns);
	const analyzedTurns = opts?.analyzedTurns ?? (Number.isFinite(analyzedTurnsSource) ? analyzedTurnsSource : base.analyzedTurns);
	const allowedModes = new Set<WorldModuleMode>(["observe", "active", "suspended"]);
	const allowedCadences = new Set<WorldModuleCadence>(["every-beat", "on-time-advance", "on-trigger", "per-day", "per-arc", "strategic-turn"]);
	const allowedSkillPacks = new Set(Object.values(WORLD_MODULE_PACK_BY_KIND));
	const seen = new Set<string>();
	const modules = records(source.modules).flatMap((item): WorldProfileModule[] => {
		const id = clean(item.id, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
		if (!id || seen.has(id)) return [];
		seen.add(id);
		const rawMode = clean(item.mode, 30) as WorldModuleMode;
		const rawCadence = clean(item.cadence, 40) as WorldModuleCadence;
		const kind = ["institution", "social", "infrastructure", "rules", "objective", "mystery", "strategy", "survival", "environment", "custom", "legacy"].includes(String(item.kind)) ? item.kind as WorldModuleKind : moduleKindForId(id);
		const requestedPack = clean(item.skillPack, 80);
		return [{
			id,
			name: clean(item.name, 100) || id,
			mode: allowedModes.has(rawMode) ? rawMode : "observe",
			cadence: allowedCadences.has(rawCadence) ? rawCadence : "on-trigger",
			confidence: confidence(item.confidence),
			reason: clean(item.reason, 600),
			stateFocus: strings(item.stateFocus, 16, 160),
			writerProjection: clean(item.writerProjection, 600),
			kind,
			skillPack: allowedSkillPacks.has(requestedPack) ? requestedPack : WORLD_MODULE_PACK_BY_KIND[kind],
		}];
	}).slice(0, 16);
	const scales = new Set(["intimate", "scene", "local", "institutional", "regional", "epic"]);
	const steps = new Set(["moment", "scene", "hour", "day", "week", "strategic-turn"]);
	const activities = new Set(["quiet", "low", "normal", "active", "epic"]);
	return {
		version: 1,
		cardKey: base.cardKey,
		cardName: base.cardName,
		revision: Math.max(base.revision + 1, Math.round(Number(source.revision) || 0)),
		analyzedTurns: Math.max(0, Math.round(analyzedTurns)),
		status: opts?.preserveStatus ? base.status : source.status === "stable" ? "stable" : "draft",
		sourceFingerprint: opts?.sourceFingerprint ?? (clean(source.sourceFingerprint, 100) || base.sourceFingerprint),
		updatedAt: new Date().toISOString(),
		digest: clean(source.digest, 1200) || base.digest,
		labels: strings(source.labels, 12, 80),
		primaryScale: scales.has(String(source.primaryScale)) ? source.primaryScale as CardWorldProfile["primaryScale"] : base.primaryScale,
		defaultTimeStep: steps.has(String(source.defaultTimeStep)) ? source.defaultTimeStep as CardWorldProfile["defaultTimeStep"] : base.defaultTimeStep,
		worldActivity: activities.has(String(source.worldActivity)) ? source.worldActivity as CardWorldProfile["worldActivity"] : base.worldActivity,
		modules,
		disabledModules: strings(source.disabledModules, 32, 80),
		userRequirements: [...new Set([...base.userRequirements, ...strings(source.userRequirements, 40, 500)])].slice(0, 40),
		optimizationNotes: strings(source.optimizationNotes, 40, 500).length ? strings(source.optimizationNotes, 40, 500) : base.optimizationNotes,
		unresolvedQuestions: strings(source.unresolvedQuestions, 20, 500),
		evidence: records(source.evidence).map((item) => ({ source: clean(item.source, 160), claim: clean(item.claim, 500) })).filter((item) => item.source && item.claim).slice(0, 40),
	};
}

export function loadCardWorldProfile(cwd: string, cardPath: string, cardName: string, sourceFingerprint = "", card?: CharacterCard): CardWorldProfile | null {
	const path = worldProfilePath(cwd, cardPath, card);
	const legacyPath = worldProfilePath(cwd, cardPath);
	const sourcePath = existsSync(path) ? path : legacyPath;
	if (!existsSync(sourcePath)) return null;
	try {
		const base = defaultCardWorldProfile(cwd, cardPath, cardName, sourceFingerprint, card);
		const parsed = normalizeCardWorldProfile(readJsonFile(sourcePath), { ...base, revision: -1 }, { sourceFingerprint: undefined });
		return parsed ? { ...parsed, revision: Math.max(0, parsed.revision) } : null;
	} catch {
		return null;
	}
}

export function saveCardWorldProfile(cwd: string, cardPath: string, profile: CardWorldProfile, card?: CharacterCard): void {
	const path = worldProfilePath(cwd, cardPath, card);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(profile, null, "\t")}\n`, "utf8");
	renameSync(temporary, path);
}

export function manifestFromProfile(profile: CardWorldProfile): WorldSimulationManifest {
	const disabled = new Set(profile.disabledModules);
	return {
		version: 1,
		cardKey: profile.cardKey,
		profileRevision: profile.revision,
		profileStatus: profile.status,
		digest: profile.digest,
		primaryScale: profile.primaryScale,
		defaultTimeStep: profile.defaultTimeStep,
		worldActivity: profile.worldActivity,
		modules: profile.modules.filter((module) => !disabled.has(module.id)),
		disabledModules: [...disabled],
		userRequirements: profile.userRequirements,
		createdAt: new Date().toISOString(),
		playKey: worldPlayKey(profile.sourceFingerprint),
	};
}

export function worldManifestFromBranch(branch: BranchEntryLike[], cardKey?: string): WorldSimulationManifest | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== WORLD_MANIFEST_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as WorldSimulationManifest;
		if (data.version !== 1 || (cardKey && data.cardKey !== cardKey) || !Array.isArray(data.modules)) continue;
		return data;
	}
	return null;
}

export function profileNeedsAnalysis(profile: CardWorldProfile | null, sourceFingerprint: string, completedTurns = 0, reviewEveryTurns = 8): boolean {
	if (!profile) return true;
	if (profile.status === "stable") return false;
	if (profile.sourceFingerprint !== sourceFingerprint) return true;
	return completedTurns >= profile.analyzedTurns + Math.max(1, reviewEveryTurns);
}

export function buildWorldProfilePrompt(input: {
	skillBody: string;
	card: CharacterCard;
	entries: LorebookEntry[];
	preset: RpPreset | null;
	greetingIndex?: number;
	previous?: CardWorldProfile | null;
	recentHistory?: Array<{ role: string; text: string }>;
}): { systemPrompt: string; userText: string } {
	const selectedGreeting = input.greetingIndex && input.greetingIndex > 0
		? input.card.alternateGreetings[input.greetingIndex - 1] ?? input.card.firstMes
		: input.card.firstMes;
	return {
		systemPrompt: `你在为梨园建立一张角色卡长期复用的独立世界适配画像。Skill 是分析与适配规则的唯一权威；代码只负责输入、解析、版本和持久化。只返回一个合法 JSON 对象，不输出 Markdown、解释、思考过程或 profile/result 包装。顶层必须直接含 digest、labels、primaryScale、defaultTimeStep、worldActivity、modules、disabledModules、userRequirements、optimizationNotes、unresolvedQuestions、evidence。\n\n# 工作流 Skill\n${input.skillBody}`,
		userText: JSON.stringify({
			character_card: {
				name: input.card.name,
				description: input.card.description.slice(0, 8000),
				personality: input.card.personality.slice(0, 5000),
				scenario: input.card.scenario.slice(0, 5000),
				creatorNotes: input.card.creatorNotes.slice(0, 3000),
				tags: input.card.tags.slice(0, 30),
			},
			selected_greeting: selectedGreeting,
			world_lore: input.entries.slice(0, 40).map((entry) => ({ source: entry.source, title: entry.comment || entry.keys[0], content: entry.content.slice(0, 2000) })),
			preset: input.preset ? { name: input.preset.name, enabledBlockNames: input.preset.blocks.filter((block) => block.enabled).map((block) => block.name) } : null,
			previous_profile: input.previous ?? null,
			recent_play: (input.recentHistory?.slice(-8) ?? []).map((item) => ({ role: item.role, text: item.text.slice(0, 2000) })),
		}, null, 2),
	};
}
