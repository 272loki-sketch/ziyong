import type { CharacterCard, LorebookEntry } from "../types.ts";
import type { RpPreset } from "../preset.ts";

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}\n……（已截断 ${text.length - max} 字）`;
const FORMAT_RE = /<\/?(?:StatusPlaceHolderImpl|StatusBlock|state\d+|user_now_status|comprehensive_now_status|NPC_status|NPC_perspective|calendar|Small_theater|options|chat|image|imageTag)\b|状态栏|日历|小剧场|行动选项|FinalOutputFormat|NovelAI|nai4/i;
const KNOWN_PAIR_TAGS = ["StatusBlock", "user_now_status", "comprehensive_now_status", "NPC_status", "NPC_perspective", "calendar", "Small_theater", "options", "chat", "image", "imageTag"] as const;
const NATIVE_TAGS = new Set(["calendar"]);

export interface CurtainFormatPlan {
	/** 当前卡明确声明、且仍需模型生成正文内容的成对标签。 */
	modelTags: string[];
	/** 由梨园权威状态确定性投影，模型不得重算。 */
	nativeTags: string[];
	/** 卡正则声明的自闭合前端入口，由代码补齐而非让模型猜。 */
	deterministicTags: string[];
	/** 已知但当前卡未声明的格式，禁止从别卡或 Skill 示例串入。 */
	forbiddenTags: string[];
}

export interface CurtainRerollMaterials {
	card: { name: string; systemPrompt?: string; postHistoryInstructions?: string; mesExample?: string };
	formatPlan: CurtainFormatPlan;
	formatHints: string[];
	presetBlocks: Array<{ name: string; content: string }>;
	loreFormats: Array<{ title: string; content: string }>;
}

const tagNamesOf = (text: string): string[] => {
	const found = new Set<string>();
	for (const tag of KNOWN_PAIR_TAGS) {
		if (new RegExp(`<\\/?${tag}\\b`, "i").test(text)) found.add(tag);
	}
	if (/<\/?state\d+\b/i.test(text)) found.add("stateN");
	return [...found];
};

const deterministicTagOf = (hint: string): string | null => {
	const match = hint.match(/<([A-Za-z_][\w:-]*)\s*\/>/);
	return match?.[1] ?? null;
};

function buildFormatPlan(statusBarFormats: string[], formatTexts: string[]): CurtainFormatPlan {
	const declared = new Set(formatTexts.flatMap(tagNamesOf));
	const deterministicTags = [...new Set(statusBarFormats.map(deterministicTagOf).filter((tag): tag is string => !!tag))];
	const nativeTags = [...declared].filter((tag) => NATIVE_TAGS.has(tag));
	const modelTags = [...declared].filter((tag) => !NATIVE_TAGS.has(tag));
	for (const hint of statusBarFormats) {
		for (const tag of tagNamesOf(hint)) if (!modelTags.includes(tag)) modelTags.unshift(tag);
	}
	const selected = new Set([...modelTags, ...nativeTags, ...deterministicTags]);
	const forbiddenTags = [...KNOWN_PAIR_TAGS, "stateN"].filter((tag) => !selected.has(tag));
	return { modelTags, nativeTags, deterministicTags, forbiddenTags };
}

/**
 * 谢幕模型只负责创意格式正文；卡前端入口和原生日历由代码收口。
 * 这也是跨卡隔离的最后一道门：未在当前格式计划中的已知标签不会落树。
 */
export function finalizeCurtainText(text: string, plan: CurtainFormatPlan): string {
	let out = text.trim();
	const blocksFor = (tag: string): string[] => {
		if (tag === "stateN") return [...out.matchAll(/<state\d+\b[^>]*>[\s\S]*?<\/state\d+\s*>/gi)].map((match) => match[0].trim());
		const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return [...out.matchAll(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`, "gi"))].map((match) => match[0].trim());
	};
	const stripPair = (tag: string) => {
		const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`, "gi"), "");
	};
	for (const tag of [...plan.nativeTags, ...plan.forbiddenTags]) {
		if (tag === "stateN") out = out.replace(/<state\d+\b[^>]*>[\s\S]*?<\/state\d+\s*>/gi, "");
		else stripPair(tag);
	}
	// 旧插件变量永不属于梨园谢幕，避免另起一套状态权威。
	for (const tag of ["UpdateVariable", "JSONPatch", "Analysis"]) stripPair(tag);
	for (const tag of plan.deterministicTags) {
		const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`<${escaped}\\s*\\/>`, "gi"), "");
	}
	// 每种模型格式只落最后一份完整块。这样谢幕前抢跑和正式谢幕重复时，
	// 正式交付覆盖抢跑；正式轮只补缺项时，抢跑块仍不会丢失。
	const modelBlocks = plan.modelTags.flatMap((tag) => blocksFor(tag).slice(-1));
	const deterministic = plan.deterministicTags.map((tag) => `<${tag}/>`).join("\n");
	return [deterministic, ...modelBlocks].filter(Boolean).join("\n\n");
}

/** 状态栏重Roll只读格式定义；绝不再把 1.9MB rawCard / 1.2MB character_book 整包送模。 */
export function buildCurtainRerollMaterials(input: { card: CharacterCard; entries?: LorebookEntry[]; preset: RpPreset | null; statusBarFormats: string[] }): CurtainRerollMaterials {
	const { card, preset } = input;
	const loreFormats: CurtainRerollMaterials["loreFormats"] = [];
	const formatTexts: string[] = [];
	let loreChars = 0;
	for (const entry of input.entries ?? card.book) {
		if (!entry.enabled || !FORMAT_RE.test(`${entry.comment}\n${entry.content}`)) continue;
		formatTexts.push(`${entry.comment}\n${entry.content}`);
		// 日历已迁到 rp-state + 世界/生态的确定性投影。旧规则只保留作皮肤资料，不能再交给模型逐日编造。
		const tags = tagNamesOf(entry.content);
		const onlyNative = tags.length > 0 && tags.every((tag) => NATIVE_TAGS.has(tag));
		const untaggedCalendarRule = tags.length === 0 && /日历|calendar/i.test(`${entry.comment}\n${entry.content}`);
		if (onlyNative || untaggedCalendarRule) continue;
		const content = clip(entry.content, 6000);
		if (loreChars + content.length > 24_000) continue;
		loreChars += content.length;
		loreFormats.push({ title: entry.comment || entry.keys[0] || `uid${entry.uid}`, content });
	}
	const presetBlocks: CurtainRerollMaterials["presetBlocks"] = [];
	let presetChars = 0;
	for (const block of preset?.blocks ?? []) {
		if (!block.enabled || !FORMAT_RE.test(`${block.name}\n${block.content}`)) continue;
		formatTexts.push(`${block.name}\n${block.content}`);
		const content = clip(block.content, 5000);
		if (presetChars + content.length > 20_000) continue;
		presetChars += content.length;
		presetBlocks.push({ name: block.name || block.id, content });
	}
	return {
		card: {
			name: card.name,
			...(card.systemPrompt.trim() ? { systemPrompt: clip(card.systemPrompt, 4000) } : {}),
			...(card.postHistoryInstructions.trim() ? { postHistoryInstructions: clip(card.postHistoryInstructions, 4000) } : {}),
			...(card.mesExample.trim() && FORMAT_RE.test(card.mesExample) ? { mesExample: clip(card.mesExample, 5000) } : {}),
		},
		formatPlan: buildFormatPlan(input.statusBarFormats, formatTexts),
		formatHints: input.statusBarFormats.slice(0, 16),
		presetBlocks,
		loreFormats,
	};
}
