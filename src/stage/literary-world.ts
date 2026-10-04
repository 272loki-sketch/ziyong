import type { WorldState } from "../types.ts";
import type { BeatMsg, BranchEntryLike } from "./assemble.ts";
import type { WorldSimulationManifest } from "./literary-world-profile.ts";

export const LITERARY_WORLD_ENTRY_TYPE = "rp-world-state";

export interface WorldEvent {
	id: string;
	name: string;
	type: "conflict" | "progress";
	level: number;
	stage: string;
	description: string;
}

export interface WorldFaction {
	id: string;
	name: string;
	scope: string;
	status: string;
	relation: string;
	goal: string;
}

export interface WorldWind {
	id: string;
	topic: string;
	type: "announcement" | "report" | "rumor" | "sentiment";
	level: number;
	content: string;
	scope: string;
	source: string;
}

export interface LiteraryWorldState {
	version: 1;
	round: number;
	digest: string;
	events: WorldEvent[];
	factions: WorldFaction[];
	winds: WorldWind[];
	trends: Array<{ id: string; name: string; scope: string; status: string; description: string }>;
	reputation: Record<string, string>;
	economy: { climate: string; signals: string[] };
	enemies: Array<{ id: string; name: string; reason: string; status: string }>;
	influenceChain: Array<{ trigger: string; impact: string; fallout: string }>;
	blackbox: {
		secretActions: Array<{ action: string; witnesses: string; trace: string }>;
		secretAssets: Array<{ name: string; exposure: string; status: string }>;
	};
}

export function defaultLiteraryWorldState(): LiteraryWorldState {
	return {
		version: 1,
		round: 0,
		digest: "世界尚未开始独立演化。",
		events: [],
		factions: [],
		winds: [],
		trends: [],
		reputation: {},
		economy: { climate: "平稳", signals: [] },
		enemies: [],
		influenceChain: [],
		blackbox: { secretActions: [], secretAssets: [] },
	};
}

export function literaryWorldFromBranch(branch: BranchEntryLike[]): LiteraryWorldState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== LITERARY_WORLD_ENTRY_TYPE) continue;
		if ((entry.data as { version?: unknown } | undefined)?.version === 2) {
			// 延迟导入会制造同步 API；v2 的兼容投影由调用方优先使用 modularWorldFromBranch。
			// 这里继续向前找旧 v1，只服务尚未迁移的旧调用点。
			continue;
		}
		const parsed = normalizeLiteraryWorldState(entry.data, defaultLiteraryWorldState());
		if (parsed) return parsed;
	}
	return defaultLiteraryWorldState();
}

const clean = (value: unknown, max = 300): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const boundedLevel = (value: unknown): number => {
	const n = Number(value);
	return Number.isFinite(n) ? Math.max(1, Math.min(4, Math.round(n))) : 1;
};

const list = <T>(value: unknown, parse: (item: Record<string, unknown>) => T | null, max: number): T[] | null => {
	if (!Array.isArray(value)) return null;
	return value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const parsed = parse(item as Record<string, unknown>);
		return parsed ? [parsed] : [];
	}).slice(0, max);
};

const id = (value: unknown, prefix: string, index: number): string => clean(value, 80) || `${prefix}_${index + 1}`;

function objectOf(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const source = value.trim();
	const candidates = [source, source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], source.match(/\{[\s\S]*\}/)?.[0]];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// Try the next bounded JSON candidate.
		}
	}
	return null;
}

export function normalizeLiteraryWorldState(value: unknown, previous: LiteraryWorldState): LiteraryWorldState | null {
	const source = objectOf(value);
	if (!source) return null;
	const events = list(source.events, (item) => {
		const name = clean(item.name, 100);
		if (!name) return null;
		return {
			id: "",
			name,
			type: item.type === "progress" ? "progress" as const : "conflict" as const,
			level: boundedLevel(item.level),
			stage: clean(item.stage, 40),
			description: clean(item.description ?? item.desc),
		};
	}, 16);
	if (events) events.forEach((item, index) => { item.id = id((source.events as unknown[])[index] && ((source.events as Record<string, unknown>[])[index]?.id), "event", index); });
	const factions = list(source.factions, (item) => {
		const name = clean(item.name, 100);
		return name ? { id: "", name, scope: clean(item.scope), status: clean(item.status), relation: clean(item.relation), goal: clean(item.goal ?? item.currentGoal) } : null;
	}, 15);
	if (factions) factions.forEach((item, index) => { item.id = id((source.factions as Record<string, unknown>[])[index]?.id, "faction", index); });
	const winds = list(source.winds, (item) => {
		const topic = clean(item.topic, 100);
		if (!topic) return null;
		const allowed = new Set(["announcement", "report", "rumor", "sentiment"]);
		const type = allowed.has(String(item.type)) ? item.type as WorldWind["type"] : "report";
		return { id: "", topic, type, level: boundedLevel(item.level), content: clean(item.content), scope: clean(item.scope), source: clean(item.source) };
	}, 12);
	if (winds) winds.forEach((item, index) => { item.id = id((source.winds as Record<string, unknown>[])[index]?.id, "wind", index); });
	const trends = list(source.trends ?? source.worldTrends, (item) => {
		const name = clean(item.name, 100);
		return name ? { id: "", name, scope: clean(item.scope), status: clean(item.status), description: clean(item.description) } : null;
	}, 6);
	if (trends) trends.forEach((item, index) => { item.id = id(((source.trends ?? source.worldTrends) as Record<string, unknown>[])[index]?.id, "trend", index); });
	const enemies = list(source.enemies, (item) => {
		const name = clean(item.name, 100);
		return name ? { id: "", name, reason: clean(item.reason), status: clean(item.status) } : null;
	}, 8);
	if (enemies) enemies.forEach((item, index) => { item.id = id((source.enemies as Record<string, unknown>[])[index]?.id, "enemy", index); });
	const influenceChain = list(source.influenceChain, (item) => ({ trigger: clean(item.trigger), impact: clean(item.impact), fallout: clean(item.fallout) }), 12);
	const reputation = source.reputation && typeof source.reputation === "object" && !Array.isArray(source.reputation)
		? Object.fromEntries(Object.entries(source.reputation as Record<string, unknown>).flatMap(([key, val]) => clean(val) ? [[clean(key, 60), clean(val)]] : []).slice(0, 12))
		: previous.reputation;
	const economySource = source.economy && typeof source.economy === "object" && !Array.isArray(source.economy) ? source.economy as Record<string, unknown> : null;
	const blackboxSource = source.blackbox && typeof source.blackbox === "object" && !Array.isArray(source.blackbox) ? source.blackbox as Record<string, unknown> : null;
	const secretActions = blackboxSource ? list(blackboxSource.secretActions, (item) => ({ action: clean(item.action), witnesses: clean(item.witnesses), trace: clean(item.trace) }), 12) : null;
	const secretAssets = blackboxSource ? list(blackboxSource.secretAssets, (item) => ({ name: clean(item.name), exposure: clean(item.exposure), status: clean(item.status) }), 12) : null;
	return {
		version: 1,
		round: Math.max(previous.round + 1, Number.isFinite(Number(source.round)) ? Math.round(Number(source.round)) : 0),
		digest: clean(source.digest ?? source.world_digest, 1000) || previous.digest,
		events: events ?? previous.events,
		factions: factions ?? previous.factions,
		winds: winds ?? previous.winds,
		trends: trends ?? previous.trends,
		reputation,
		economy: economySource ? {
			climate: clean(economySource.climate, 80) || previous.economy.climate,
			signals: Array.isArray(economySource.signals) ? economySource.signals.map((item) => clean(item)).filter(Boolean).slice(0, 8) : previous.economy.signals,
		} : previous.economy,
		enemies: enemies ?? previous.enemies,
		influenceChain: influenceChain ?? previous.influenceChain,
		blackbox: {
			secretActions: secretActions ?? previous.blackbox.secretActions,
			secretAssets: secretAssets ?? previous.blackbox.secretAssets,
		},
	};
}

export function buildLiteraryWorldPrompt(input: {
	skillBody: string;
	world: LiteraryWorldState;
	rpState: WorldState;
	history: BeatMsg[];
	userText: string;
	narrativeText: string;
	charName: string;
	userName: string;
	manifest?: WorldSimulationManifest | null;
}): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你在执行梨园的后台世界工作流。工作流 Skill 是本任务规则的唯一权威；代码只提供输入与持久化，不替 Skill 决定世界如何演化。只返回一个合法 JSON 对象，不要输出 Markdown、解释或正文。\n\n# 工作流 Skill\n${input.skillBody}`,
		userText: JSON.stringify({
			participants: { character: input.charName, user: input.userName },
			card_adaptation: input.manifest ?? null,
			current_world: input.world,
			current_scene_state: input.rpState,
			recent_history: input.history.slice(-12),
			latest_turn: { user: input.userText, narrative: input.narrativeText },
		}, null, 2),
	};
}

export function formatLiteraryWorldInjection(world: LiteraryWorldState, maxChars = 5000): string | undefined {
	if (world.round <= 0) return undefined;
	const sections = [`轮次：${world.round}`, `摘要：${world.digest}`];
	const activeEvents = world.events.filter((item) => !/已消散|已完成|已失败/.test(item.stage));
	if (activeEvents.length) sections.push(`事件：${activeEvents.map((item) => `${item.name}（${item.stage || "进行中"}，Lv.${item.level}）：${item.description}`).join("；")}`);
	if (world.factions.length) sections.push(`势力：\n${world.factions.map((item) => `- ${item.name}：${item.status || "状态未明"}；对玩家${item.relation || "立场未明"}；目标：${item.goal || "未明"}`).join("\n")}`);
	const visibleWinds = world.winds.filter((item) => item.level >= 2);
	if (visibleWinds.length) sections.push(`公开信息：${visibleWinds.map((item) => `${item.content}（${item.scope || "范围未明"}）`).join("；")}`);
	if (world.trends.length) sections.push(`天下大势：${world.trends.filter((item) => item.status !== "已结束").map((item) => `${item.name}：${item.description}`).join("；")}`);
	if (Object.keys(world.reputation).length) sections.push(`社会评价：${Object.entries(world.reputation).map(([key, value]) => `${key}=${value}`).join("；")}`);
	if (world.economy.climate || world.economy.signals.length) sections.push(`经济：${world.economy.climate}${world.economy.signals.length ? `；${world.economy.signals.join("；")}` : ""}`);
	if (world.enemies.length) sections.push(`对立关系：${world.enemies.map((item) => `${item.name}（${item.status}）：${item.reason}`).join("；")}`);
	// 黑盒只约束信息边界，不向主演泄露其具体秘密。
	if (world.blackbox.secretActions.length || world.blackbox.secretAssets.length) sections.push("信息边界：存在尚未公开的行为或资产；未通过目击、痕迹或传播链公开前，场内角色不得凭空知晓。");
	return sections.join("\n").slice(0, Math.max(0, maxChars)) || undefined;
}
