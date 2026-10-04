import type { LorebookEntry, WorldState } from "../types.ts";
import type { BeatMsg } from "./assemble.ts";
import { boundedHistory, boundedLore, clipPromptText } from "./prompt-budget.ts";

export interface LiteraryContinuity {
	version: 1;
	positions?: string[];
	ongoingActions?: string[];
	knowledgeBoundaries?: string[];
	promisesAndDeadlines?: string[];
	unresolvedPlayerChoices?: string[];
	uncertainties?: string[];
}

const MAX_ITEMS = 4;
const MAX_ITEM_CHARS = 180;
const CONTINUITY_FIELDS = [
	"positions",
	"ongoingActions",
	"knowledgeBoundaries",
	"promisesAndDeadlines",
	"unresolvedPlayerChoices",
	"uncertainties",
] as const;

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
			// Models sometimes wrap otherwise valid JSON in prose or a fence.
		}
	}
	return null;
};

const items = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const result = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim().slice(0, MAX_ITEM_CHARS))
		.filter(Boolean)
		.slice(0, MAX_ITEMS);
	return result.length ? result : undefined;
};

export function buildLiteraryContinuityPrompt(input: {
	state: WorldState;
	history: BeatMsg[];
	summary?: string;
	activatedLore: LorebookEntry[];
	userText: string;
	charName: string;
	userName: string;
}): { systemPrompt: string; userText: string } {
	return {
		systemPrompt: `你是文学角色扮演工作流的轻量连续性助理。你不重述或改写 rp-state，不写正文、对白、导演 beat 或状态补丁，只补充当前状态容易遗漏的连续性约束。

只记录有输入证据支持、且对下一拍有用的 positions、ongoingActions、knowledgeBoundaries、promisesAndDeadlines、unresolvedPlayerChoices、uncertainties。不得推断玩家未表达的思想、决定或动作。候选、推测和不确定项绝不成为事实；证据冲突时放入 uncertainties，而非自行裁决。

严格只返回 JSON：{"positions":[],"ongoingActions":[],"knowledgeBoundaries":[],"promisesAndDeadlines":[],"unresolvedPlayerChoices":[],"uncertainties":[]}。每项应短而具体，每个数组最多四项；没有可靠补充时返回空数组。`,
		userText: JSON.stringify(
			{
				participants: { character: input.charName, user: input.userName },
				current_rp_state_reference_only: input.state,
				prior_summary: input.summary ?? "",
				recent_history: boundedHistory(input.history, 20),
				latest_user_input: clipPromptText(input.userText, 8_000),
				activated_lore_reference_only: boundedLore(input.activatedLore, 6),
			},
			null,
			2,
		),
	};
}

export function parseLiteraryContinuity(value: unknown): LiteraryContinuity | undefined {
	const parsed = parseObject(value);
	if (!parsed) return undefined;
	const result: LiteraryContinuity = { version: 1 };
	for (const field of CONTINUITY_FIELDS) {
		const parsedItems = items(parsed[field]);
		if (parsedItems) result[field] = parsedItems;
	}
	return Object.keys(result).length > 1 ? result : undefined;
}

export function formatLiteraryContinuity(continuity: LiteraryContinuity): string {
	const labels: Record<(typeof CONTINUITY_FIELDS)[number], string> = {
		positions: "位置",
		ongoingActions: "进行中",
		knowledgeBoundaries: "知情边界",
		promisesAndDeadlines: "承诺与期限",
		unresolvedPlayerChoices: "待玩家选择",
		uncertainties: "不确定项",
	};
	const lines = CONTINUITY_FIELDS.flatMap((field) =>
		continuity[field]?.length ? [`${labels[field]}：${continuity[field]!.join("；")}`] : [],
	);
	return lines.length ? `[连续性补充（候选不等于事实）]\n${lines.join("\n")}` : "";
}

const TRANSITION_SIGNAL = /(?:转眼|随后|片刻后|稍后|与此同时|另一边|次日|翌日|第二天|几天后|数日后|后来|回到|抵达|到达|离开|出发|换场|场景切换|时间跳转|meanwhile|later|next day|arriv(?:e|ed|ing)|leave|left)/i;

export function shouldRunContinuity(input: {
	state: WorldState;
	history: BeatMsg[];
	summary?: string;
	userText: string;
}): boolean {
	if (Object.keys(input.state.characters ?? {}).length > 1) return true;
	if (input.summary?.trim()) return true;
	const recentText = [...input.history.slice(-4).map((message) => message.text), input.userText].join("\n");
	return TRANSITION_SIGNAL.test(recentText);
}
