import type { CharacterCard, WorldState } from "../types.ts";
import type { BeatMsg, BranchEntryLike } from "./assemble.ts";
import { boundedHistory, clipPromptText } from "./prompt-budget.ts";

export const LITERARY_PROFILE_ENTRY_TYPE = "rp-literary-profile";

export interface LiteraryProfileData {
	version: 1;
	sourceLeafId: string;
	completedTurns: number;
	character?: string;
	persona?: string;
	warnings?: string[];
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export function literaryProfileFromBranch(branch: BranchEntryLike[]): LiteraryProfileData | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== LITERARY_PROFILE_ENTRY_TYPE) continue;
		const data = entry.data as Partial<LiteraryProfileData> | undefined;
		if (!data || data.version !== 1 || typeof data.sourceLeafId !== "string") continue;
		if (!Number.isInteger(data.completedTurns) || Number(data.completedTurns) < 0) continue;
		const character = text(data.character);
		const persona = text(data.persona);
		if (!character && !persona) continue;
		return {
			version: 1,
			sourceLeafId: data.sourceLeafId,
			completedTurns: Number(data.completedTurns),
			...(character ? { character } : {}),
			...(persona ? { persona } : {}),
			...(Array.isArray(data.warnings)
				? { warnings: data.warnings.filter((item): item is string => typeof item === "string") }
				: {}),
		};
	}
	return null;
}

export function countCompletedNarrativeTurns(branch: BranchEntryLike[]): number {
	return branch.filter(
		(entry) =>
			entry.type === "message" &&
			entry.message?.role === "assistant" &&
			entry.message.stopReason !== "aborted",
	).length;
}

export function shouldRefreshLiteraryProfile(branch: BranchEntryLike[], everyNTurns: number): boolean {
	const turns = countCompletedNarrativeTurns(branch);
	if (turns === 0) return false;
	const current = literaryProfileFromBranch(branch);
	if (!current) return true;
	const interval = Math.max(1, Math.round(everyNTurns));
	return turns - current.completedTurns >= interval;
}

const recentHistory = (history: BeatMsg[], limit: number): BeatMsg[] => history.slice(-limit);

export function buildCharacterProfilePrompt(input: {
	card: CharacterCard;
	state: WorldState;
	summary?: string;
	history: BeatMsg[];
	userName: string;
}): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你是文学角色扮演工作流的角色深度分析代理（Sogon）。你只做可修订的角色校准，不写正文、不续写剧情、不生成新的事件总结，也不修改世界状态。

事实优先级：最近实际剧情 > 当前世界状态与前情提要 > 角色卡 > 保守推断。不得编造证据，不得把候选推进写成已发生事实；证据不足时明确写“证据不足”。

输出依次包含：[角色大五人格画像]、[OOC风险与修正]、[依恋模式分析]、[爱的三角结构分析]、[防御机制分析]、[核心关系图式分析]、[情绪调节模式分析]、[角色补丁]、[状态贴片]、[关系进展]。重点给出当前亲密开合度、本轮亲密许可、推进节奏、推进上限和可观察升级信号。所有结论都只是下游写作参考，不得替用户决定思想、对白或重大选择。`,
		userText: JSON.stringify(
			{
				character: {
					name: input.card.name,
					description: input.card.description,
					personality: input.card.personality,
					scenario: input.card.scenario,
				},
				user_name: input.userName,
				current_state: input.state,
				prior_summary: input.summary ?? "",
				recent_history: boundedHistory(input.history, 24),
			},
			null,
			2,
		),
	};
}

export function buildPersonaProfilePrompt(input: {
	userPersona: string;
	userMessages: string[];
	summary?: string;
	recentStory: BeatMsg[];
	userName: string;
}): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你是文学角色扮演工作流的用户偏好分析代理（Sigon）。偏好证据只能来自用户自己的输入，剧情中的 assistant 文本只能帮助理解语境，绝不能作为用户偏好证据。你不写正文、不续写剧情、不重新总结事件。

使用 D.E.S.I.R.E. 六维作保守分析：Drive、Experience、Shortcut、Identity、Risk、Emotion。不得编造稳定偏好或心理事实；证据不足时明确写“证据不足”。用户当前明确要求永远高于历史画像。

严格输出三个块：[Matrix]、[WritingStyle]、[剧情建议]。WritingStyle 给出核心风格、氛围、节奏、叙事焦点和描写方式；剧情建议给出规避区、核心驱动力、候选方向和剧情奖励。所有内容只是可修订写作参考，不得替用户决定未表达的思想或重大选择。`,
		userText: JSON.stringify(
			{
				user_name: input.userName,
				declared_persona: input.userPersona,
				user_messages_only: input.userMessages.slice(-30).map((message) => clipPromptText(message, 4_000)),
				prior_summary_for_context_only: input.summary ?? "",
				recent_story_for_context_only: boundedHistory(input.recentStory, 16),
			},
			null,
			2,
		),
	};
}

export function normalizeLiteraryArtifact(value: unknown, maxChars: number): string | undefined {
	let result = text(value);
	if (!result) return undefined;
	const fenced = result.match(/^```(?:json|markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
	if (fenced) result = fenced[1].trim();
	if (!result) return undefined;
	return result.slice(0, Math.max(1, maxChars));
}
