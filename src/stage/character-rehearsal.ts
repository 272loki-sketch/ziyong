import type { CharacterCard, LorebookEntry, WorldState } from "../types.ts";
import type { BeatMsg } from "./assemble.ts";
import { boundedHistory, boundedLore, clipPromptText } from "./prompt-budget.ts";

export interface CharacterRehearsal {
	name: string;
	role: "card-character" | "active-character";
	objective: string;
	currentEmotion: string;
	likelyActions: string[];
	dialogueIntent: string;
	possibleLines: string[];
	knowledgeBoundary: string[];
	misreadings: string[];
	wontDo: string[];
}

const MAX_ITEMS = 4;
const MAX_TEXT = 500;

function objectFrom(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const source = value.trim();
	const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const object = source.match(/\{[\s\S]*\}/);
	const candidates = [source, fenced ? fenced[1] : undefined, object ? object[0] : undefined];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch {}
	}
	return null;
}

function text(value: unknown, max = MAX_TEXT): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function strings(value: unknown, max = MAX_ITEMS): string[] { return Array.isArray(value) ? value.map((item) => text(item, 220)).filter(Boolean).slice(0, max) : []; }

export function buildCharacterRehearsalPrompt(input: {
	character: CharacterCard;
	role: "card-character" | "active-character";
	characterState?: WorldState["characters"][string];
	state: WorldState;
	userName: string;
	userText: string;
	recentHistory: BeatMsg[];
	lore: LorebookEntry[];
	summary?: string;
	plotAdaptation?: string;
}): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你是梨园正文生成前的“单角色排演 agent”。你只负责一个角色在当前拍的行为逻辑预演，不能写完整正文，不能替用户决定行动，不能修改世界状态，也不能替其他角色拍板。必须严格贴合角色卡和世界书；如果设定没有证据，明确写不确定，不要脑补成事实。\n\n请分析这个角色此刻的目标、情绪、主动动作、说话意图、可能说出的短句、知情边界、误读和绝不会做的事。possibleLines 只能是少量对白意图示例，不是要直接复制进正文的台词。只返回 JSON，不要 Markdown：{"objective":"","currentEmotion":"","likelyActions":[],"dialogueIntent":"","possibleLines":[],"knowledgeBoundary":[],"misreadings":[],"wontDo":[]}`, 
		userText: JSON.stringify({
			target_character: { name: input.character.name, role: input.role, description: clipPromptText(input.character.description, 7000), personality: clipPromptText(input.character.personality, 6000), scenario: clipPromptText(input.character.scenario, 4000), dialogue_examples: clipPromptText(input.character.mesExample, 3000) },
			current_character_state: input.characterState ?? null,
			current_world_state: input.state,
			user_name: input.userName,
			latest_user_input: clipPromptText(input.userText, 8000),
			recent_history: boundedHistory(input.recentHistory, 12, 30000),
			prior_summary: clipPromptText(input.summary, 6000),
			worldbook_entries: boundedLore(input.lore, 12, 18000),
			ecology_plot_adaptation_candidate_not_fact: clipPromptText(input.plotAdaptation, 6000),
		}, null, 2),
	};
}

export function parseCharacterRehearsal(value: unknown, name: string, role: CharacterRehearsal["role"]): CharacterRehearsal | undefined {
	const parsed = objectFrom(value);
	if (!parsed) return undefined;
	const result: CharacterRehearsal = {
		name,
		role,
		objective: text(parsed.objective),
		currentEmotion: text(parsed.currentEmotion),
		likelyActions: strings(parsed.likelyActions),
		dialogueIntent: text(parsed.dialogueIntent),
		possibleLines: strings(parsed.possibleLines),
		knowledgeBoundary: strings(parsed.knowledgeBoundary),
		misreadings: strings(parsed.misreadings),
		wontDo: strings(parsed.wontDo),
	};
	return result.objective || result.currentEmotion || result.likelyActions.length || result.dialogueIntent ? result : undefined;
}

export function formatCharacterRehearsals(items: CharacterRehearsal[]): string {
	if (!items.length) return "";
	return `【逐角色排演参考】\n以下是每个相关角色独立排演出的候选行为，不是事实、不是隐藏剧情，也不是必须照抄的正文。角色卡、当前正文和世界状态优先；不要替用户决定行动。\n${items.map((item) => [
		`## ${item.name}`,
		item.objective && `目标：${item.objective}`,
		item.currentEmotion && `情绪：${item.currentEmotion}`,
		item.likelyActions.length && `可能动作：${item.likelyActions.join("；")}`,
		item.dialogueIntent && `说话意图：${item.dialogueIntent}`,
		item.possibleLines.length && `可能说法（参考）：${item.possibleLines.join("；")}`,
		item.knowledgeBoundary.length && `知情边界：${item.knowledgeBoundary.join("；")}`,
		item.misreadings.length && `可能误读：${item.misreadings.join("；")}`,
		item.wontDo.length && `行为底线：${item.wontDo.join("；")}`,
	].filter(Boolean).join("\n")).join("\n\n")}`;
}
