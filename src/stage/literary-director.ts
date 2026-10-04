import type { LorebookEntry, WorldState } from "../types.ts";
import type { BeatMsg } from "./assemble.ts";
import type { LiteraryProfileData } from "./literary-profile.ts";
import type { LiteraryContinuity } from "./literary-continuity.ts";
import { boundedHistory, boundedLore, clipPromptText } from "./prompt-budget.ts";

export interface CharacterInitiative {
	character: string;
	motive: string;
	immediateIntent: string;
	limit: string;
}

export interface LiteraryDirection {
	version: 1;
	scenePressure?: string;
	characterInitiatives?: CharacterInitiative[];
	personalThreads?: string[];
	offstageThreads?: string[];
	candidateBeats?: string[];
	withheldInformation?: string[];
	relationshipLimit?: string;
	playerStop?: string;
	/** 每拍固定生成的写作控制：只约束表现，不是剧情事实。 */
	sceneMode?: string;
	subtext?: string;
	rhythm?: string;
	dialogueRatio?: number;
	sensoryFocus?: string[];
	avoid?: string[];
}

const MAX_ITEMS = 3;
const MAX_ITEM_CHARS = 180;

const items = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const result = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim().slice(0, MAX_ITEM_CHARS))
		.filter(Boolean)
		.slice(0, MAX_ITEMS);
	return result.length ? result : undefined;
};

const text = (value: unknown): string => typeof value === "string" ? value.trim().slice(0, MAX_ITEM_CHARS) : "";

const initiatives = (value: unknown): CharacterInitiative[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const result = value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		const initiative = {
			character: text(record.character),
			motive: text(record.motive),
			immediateIntent: text(record.immediateIntent),
			limit: text(record.limit),
		};
		return Object.values(initiative).some(Boolean) ? [initiative] : [];
	}).slice(0, MAX_ITEMS);
	return result.length ? result : undefined;
};

export function buildLiteraryDirectorPrompt(input: {
	state: WorldState;
	history: BeatMsg[];
	summary?: string;
	literaryProfile?: LiteraryProfileData | null;
	continuity?: LiteraryContinuity | null;
	ecology?: string;
	plotAdaptation?: string;
	research?: unknown;
	outline?: unknown;
	activatedLore: LorebookEntry[];
	userText: string;
	charName: string;
	userName: string;
	characterIdentityIndex?: string;
}): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你是梨园文学工作流唯一的拍前导演。你只给主演一块简短、受限的 Stitches 风格方向，不写正文、对白、状态补丁、输出格式或事件顺序，也不复述输入。

判断场景压力、各角色的动机/即时意图/行动上限、个人线、幕后线、可选拍点、应暂扣的信息、关系推进上限，以及涉及玩家行动、思想、对白或重大选择前的停点。每一拍还必须给出 sceneMode、subtext、rhythm、dialogueRatio、sensoryFocus、avoid，供主演控制现场感、节奏和反八股；这些是写作约束，不是正文内容。

continuity 仅是连续性约束，research 仅是参考材料。不得创造新事实，不得把 candidateBeats 或其他候选写成已发生历史，不得替玩家选择。具体发生什么和怎么写均由下游主演决定。

单拍边界是硬约束：默认只推进最新用户输入所在的当前场景和眼前一次互动。用户只说一句话、做一个动作或补充当前场景时，candidateBeats 只能覆盖对方即时反应、一次必要交互与把话递回玩家；不得擅自跳到稍后、放学、夜晚、次日，不得把交流会、夜跑、复盘、入睡等后续日程塞进同一拍。只有用户明确要求时间跳转、概述一段时期或当前场景已自然结束，才允许跨场景。最新输入若复述或细化上拍中的瞬间，视为从当前分支叶继续，不得重演已经发生的后续。

严格只返回 JSON：{"scenePressure":"...","characterInitiatives":[{"character":"...","motive":"...","immediateIntent":"...","limit":"..."}],"personalThreads":[],"offstageThreads":[],"candidateBeats":[],"withheldInformation":[],"relationshipLimit":"...","playerStop":"...","sceneMode":"...","subtext":"...","rhythm":"slow|medium|fast","dialogueRatio":0.6,"sensoryFocus":[],"avoid":[]}。所有数组最多三项；dialogueRatio 为 0 到 1；不适用时使用空字符串或空数组。`,
		userText: JSON.stringify(
			{
				participants: { character: input.charName, user: input.userName },
				current_state: input.state,
				prior_summary: input.summary ?? "",
				recent_history: boundedHistory(input.history, 20),
				latest_user_input: clipPromptText(input.userText, 8_000),
				activated_lore: boundedLore(input.activatedLore, 6),
				character_identity_reference: input.characterIdentityIndex ?? null,
				literary_profile: input.literaryProfile ?? null,
				continuity_constraints: input.continuity ?? null,
				research_reference_only: input.research ?? null,
				committed_outline_candidate_not_fact: input.outline ?? null,
			living_ecology: input.ecology ?? null,
			ecology_plot_adaptation_candidate_not_fact: input.plotAdaptation ?? null,
			},
			null,
			2,
		),
	};
}

const parseObject = (value: unknown): Record<string, unknown> | null => {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const source = value.trim();
	const candidates = [source, source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], source.match(/\{[\s\S]*\}/)?.[0]];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// Try the next bounded JSON candidate.
		}
	}
	return null;
};

export function parseLiteraryDirection(value: unknown): LiteraryDirection | undefined {
	const parsed = parseObject(value);
	if (!parsed) return undefined;
	let characterInitiatives = initiatives(parsed.characterInitiatives);
	if (!characterInitiatives) {
		const legacy = items(parsed.characterInitiative);
		characterInitiatives = legacy?.map((motive) => ({ character: "", motive, immediateIntent: "", limit: "" }));
	}
	const scenePressure = text(parsed.scenePressure);
	const sceneMode = text(parsed.sceneMode);
	const subtext = text(parsed.subtext);
	const rhythm = text(parsed.rhythm);
	const dialogueRatio = typeof parsed.dialogueRatio === "number" && Number.isFinite(parsed.dialogueRatio) ? Math.max(0, Math.min(1, parsed.dialogueRatio)) : undefined;
	const sensoryFocus = items(parsed.sensoryFocus);
	const avoid = items(parsed.avoid);
	const personalThreads = items(parsed.personalThreads);
	const offstageThreads = items(parsed.offstageThreads);
	const candidateBeats = items(parsed.candidateBeats);
	const withheldInformation = items(parsed.withheldInformation);
	const relationshipLimit = text(parsed.relationshipLimit);
	const playerStop = text(parsed.playerStop);
	if (!scenePressure && !characterInitiatives && !personalThreads && !offstageThreads && !candidateBeats && !withheldInformation && !relationshipLimit && !playerStop && !sceneMode && !subtext && !rhythm && dialogueRatio === undefined && !sensoryFocus && !avoid) return undefined;
	return {
		version: 1,
		...(scenePressure ? { scenePressure } : {}),
		...(characterInitiatives ? { characterInitiatives } : {}),
		...(personalThreads ? { personalThreads } : {}),
		...(offstageThreads ? { offstageThreads } : {}),
		...(candidateBeats ? { candidateBeats } : {}),
		...(withheldInformation ? { withheldInformation } : {}),
		...(relationshipLimit ? { relationshipLimit } : {}),
		...(playerStop ? { playerStop } : {}),
		...(sceneMode ? { sceneMode } : {}),
		...(subtext ? { subtext } : {}),
		...(rhythm ? { rhythm } : {}),
		...(dialogueRatio !== undefined ? { dialogueRatio } : {}),
		...(sensoryFocus ? { sensoryFocus } : {}),
		...(avoid ? { avoid } : {}),
	};
}

export function formatLiteraryDirection(direction: LiteraryDirection): string {
	const lines: string[] = [];
	if (direction.scenePressure) lines.push(`场景压力：${direction.scenePressure}`);
	if (direction.characterInitiatives?.length) lines.push(`角色主动性：\n${direction.characterInitiatives.map((item) => `- ${item.character || "未指定角色"}｜动机：${item.motive || "-"}｜即时意图：${item.immediateIntent || "-"}｜上限：${item.limit || "-"}`).join("\n")}`);
	if (direction.personalThreads?.length) lines.push(`个人线：${direction.personalThreads.join("；")}`);
	if (direction.offstageThreads?.length) lines.push(`幕后线：${direction.offstageThreads.join("；")}`);
	if (direction.candidateBeats?.length) lines.push(`候选拍点（非事实）：${direction.candidateBeats.join("；")}`);
	if (direction.withheldInformation?.length) lines.push(`暂扣信息：${direction.withheldInformation.join("；")}`);
	if (direction.relationshipLimit) lines.push(`关系上限：${direction.relationshipLimit}`);
	if (direction.playerStop) lines.push(`玩家停点：${direction.playerStop}`);
	if (direction.sceneMode) lines.push(`场景模式：${direction.sceneMode}`);
	if (direction.subtext) lines.push(`潜台词：${direction.subtext}`);
	if (direction.rhythm) lines.push(`节奏：${direction.rhythm}`);
	if (direction.dialogueRatio !== undefined) lines.push(`对白比例：${direction.dialogueRatio}`);
	if (direction.sensoryFocus?.length) lines.push(`感官焦点：${direction.sensoryFocus.join("；")}`);
	if (direction.avoid?.length) lines.push(`反八股约束：${direction.avoid.join("；")}`);
	return lines.length ? `[拍前导演]\n${lines.join("\n")}` : "";
}
