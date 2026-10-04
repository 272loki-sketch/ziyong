import type { CharacterCard, WorldState } from "../types.ts";
import type { OutlineProjection } from "../outline/projection.ts";
import type { NovelPlayProjection } from "../novel-play/runtime.ts";
import type { BeatMsg } from "./assemble.ts";
import type { EcologyCardPool, EcologyGlobalPool, LiteraryEcologyState } from "./literary-ecology.ts";
import { boundedHistory, clipPromptText } from "./prompt-budget.ts";

export interface PlotEventCandidate { id: string; templateId?: string; name: string; adaptedEvent: string; whyNow: string; involvedCharacters: string[]; causalLinks: string[]; foreshadowing: string[]; entryPoint: string; progressLimit: string; playerAgency: string; status: "selected" | "reserve"; }
export interface PlotAdaptation { version: 1; cardGrammar: string; selected?: PlotEventCandidate; reserves: PlotEventCandidate[]; rejected: string[]; }
const clean = (value: unknown, max = 360) => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, max = 4, chars = 220) => Array.isArray(value) ? value.map((item) => clean(item, chars)).filter(Boolean).slice(0, max) : [];

/** Select a small, deterministic ecology workset before the model performs narrative adaptation. */
export function selectRelevantEcologyRows<T>(rows: T[], input: { state: WorldState; ecology: LiteraryEcologyState; userText: string; history: BeatMsg[]; outline: OutlineProjection }, limit = 12): T[] {
	const signals = `${input.state.location} ${input.state.time} ${input.userText} ${input.history.slice(-6).map((row) => row.text).join(" ")} ${JSON.stringify(input.outline)}`
		.split(/[\s，。；、,.!?！？:：()（）\[\]{}]+/).map((word) => word.trim()).filter((word) => word.length >= 2);
	const activeLocations = new Set(input.ecology.occurrences.filter((row) => row.status === "active" || row.status === "scheduled").map((row) => row.location));
	return rows.map((row, index) => {
		const haystack = JSON.stringify(row);
		const score = signals.reduce((total, signal) => total + (haystack.includes(signal) ? 1 : 0), 0)
			+ (input.state.location && haystack.includes(input.state.location) ? 5 : 0)
			+ (activeLocations.size && [...activeLocations].some((location) => haystack.includes(location)) ? 3 : 0);
		return { row, index, score };
	}).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map((item) => item.row);
}

/** Reuse the established plot-adaptation channel when ecology is disabled. */
export function plotAdaptationFromNovelProjection(value: NovelPlayProjection | undefined): PlotAdaptation | undefined {
	if (!value?.candidates.length && !value?.sceneRecall.length) return undefined;
	const rows = value.candidates.slice(0, 3).map((item, index): PlotEventCandidate => ({
		id: `novel:${item.nodeId}`,
		templateId: item.nodeId,
		name: item.title,
		adaptedEvent: item.summary,
		whyNow: "当前分支仍允许该原著节点作为同阶段候选",
		involvedCharacters: [], causalLinks: [], foreshadowing: [],
		entryPoint: "由导演结合当前场景决定是否自然接入",
		progressLimit: "只推进当前场景的一次互动",
		playerAgency: "候选不得覆盖玩家选择或当前分支事实",
		status: index === 0 ? "selected" : "reserve",
	}));
	const recall = value.sceneRecall.map(item => `原著同场事件候选：${item.title}\n摘要：${item.summary}\n原文证据：${item.quote}`).join("\n\n");
	return { version: 1, cardGrammar: `当前分支事实优先；原著只提供同阶段公开候选。\n【原著当前场景事件组（均为候选，不是事实）】\n${recall}`, selected: rows[0], reserves: rows.slice(1, 3), rejected: [] };
}

function objectOf(value: unknown): Record<string, unknown> | null { if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; if (typeof value !== "string") return null; const source = value.trim(), fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], json = source.match(/\{[\s\S]*\}/)?.[0]; for (const candidate of [source, fenced, json]) { if (!candidate) continue; try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {} } return null; }
function candidate(value: unknown, status: PlotEventCandidate["status"], index: number): PlotEventCandidate | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const row = value as Record<string, unknown>, name = clean(row.name, 120), adaptedEvent = clean(row.adaptedEvent, 600); if (!name || !adaptedEvent) return undefined; return { id: clean(row.id, 80) || `plot-${status}-${index + 1}`, templateId: clean(row.templateId, 120) || undefined, name, adaptedEvent, whyNow: clean(row.whyNow, 360), involvedCharacters: strings(row.involvedCharacters), causalLinks: strings(row.causalLinks), foreshadowing: strings(row.foreshadowing), entryPoint: clean(row.entryPoint, 360), progressLimit: clean(row.progressLimit, 360), playerAgency: clean(row.playerAgency, 240), status }; }

export function buildPlotAdaptationPrompt(input: { card: CharacterCard; cardPool: EcologyCardPool; globalPool: EcologyGlobalPool; ecology: LiteraryEcologyState; outline: OutlineProjection; state: WorldState; history: BeatMsg[]; summary?: string; userText: string; userName: string; novelProjection?: NovelPlayProjection; }): { systemPrompt: string; userText: string } {
	const workset = { templates: selectRelevantEcologyRows(input.cardPool.templates.filter((row) => row.status === "active"), input, 12), prototypes: selectRelevantEcologyRows(input.globalPool.prototypes.filter((row) => row.status === "active"), input, 12) };
	return { systemPrompt: `你是梨园的“剧情卡—生态适配 agent”。你的工作是把生态库的抽象叙事原型与当前角色卡、当前大纲和眼前场景结合，提出本拍可自然发生的事件候选。不是筛掉生态，而是把相似剧情按当前世界规则、人物欲望和既有因果重新变形。\n\n输入的生态工作集是确定性筛选出的相关子集，不代表其他生态不存在。只能使用输入中已存在的生态模板、事件状态、大纲线索和角色卡事实；不得把候选写成已发生事实，不得替玩家做选择，不得揭露 secret / discoverable 信息。原著候选同样只是候选，当前分支事实始终优先。优先让事件有明确起因、人物钩子、后果和可回收线索；允许 selected 为空。selected 最多一条，reserves 最多两条。progressLimit 必须限制本拍只推进到当前场景的一次互动。严格只返回 JSON：{"cardGrammar":"","selected":null,"reserves":[],"rejected":[]}；每个候选：{"id":"","templateId":"","name":"","adaptedEvent":"","whyNow":"","involvedCharacters":[],"causalLinks":[],"foreshadowing":[],"entryPoint":"","progressLimit":"","playerAgency":""}。`, userText: JSON.stringify({ card: { name: input.card.name, description: clipPromptText(input.card.description, 7000), personality: clipPromptText(input.card.personality, 5000), scenario: clipPromptText(input.card.scenario, 4000), tags: input.card.tags }, card_ecology_grammar: { digest: input.cardPool.digest, worldGrammar: input.cardPool.worldGrammar, actorGrammar: input.cardPool.actorGrammar, templates: workset.templates }, global_prototypes: workset.prototypes, workset: { cardTemplates: workset.templates.length, globalPrototypes: workset.prototypes.length }, living_ecology: input.ecology, committed_outline_candidate_not_fact: input.outline, novel_candidates_not_facts: input.novelProjection, current_state: input.state, prior_summary: clipPromptText(input.summary, 6000), recent_history: boundedHistory(input.history, 20, 36000), latest_user_input: clipPromptText(input.userText, 8000), user_name: input.userName }, null, 2) };
}
export function parsePlotAdaptation(value: unknown): PlotAdaptation | undefined { const row = objectOf(value); if (!row) return undefined; const selected = row.selected ? candidate(row.selected, "selected", 0) : undefined, reserves = Array.isArray(row.reserves) ? row.reserves.map((item, index) => candidate(item, "reserve", index)).filter((item): item is PlotEventCandidate => !!item).slice(0, 2) : [], cardGrammar = clean(row.cardGrammar, 900), rejected = strings(row.rejected, 5, 180); return cardGrammar || selected || reserves.length ? { version: 1, cardGrammar, selected, reserves, rejected } : undefined; }
export function mergePlotAdaptations(primary: PlotAdaptation | undefined, secondary: PlotAdaptation | undefined): PlotAdaptation | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	return {
		version: 1,
		cardGrammar: [primary.cardGrammar, secondary.cardGrammar].filter(Boolean).join("\n"),
		selected: secondary.selected ?? primary.selected,
		reserves: [...(primary.reserves ?? []), ...(secondary.reserves ?? [])].slice(0, 2),
		rejected: [...new Set([...(primary.rejected ?? []), ...(secondary.rejected ?? [])])].slice(0, 5),
	};
}
export function formatPlotAdaptation(value: PlotAdaptation | undefined): string | undefined { if (!value) return undefined; const rows = [value.cardGrammar && `卡级剧情语法：${value.cardGrammar}`]; for (const item of [value.selected, ...value.reserves].filter((item): item is PlotEventCandidate => !!item)) rows.push([`## ${item.status === "selected" ? "本拍候选" : "储备候选"}：${item.name}`, `改造事件：${item.adaptedEvent}`, item.whyNow && `为何此刻：${item.whyNow}`, item.involvedCharacters.length && `涉及人物：${item.involvedCharacters.join("、")}`, item.causalLinks.length && `因果连接：${item.causalLinks.join("；")}`, item.foreshadowing.length && `可埋线索：${item.foreshadowing.join("；")}`, item.entryPoint && `入场方式：${item.entryPoint}`, item.progressLimit && `本拍上限：${item.progressLimit}`, item.playerAgency && `玩家空间：${item.playerAgency}`].filter(Boolean).join("\n")); return rows.length ? `【生态剧情适配】\n以下是由剧情卡语法改造出的事件候选，不是已发生事实，也不是必须写入正文。导演、角色排演和主演可选择、变形或弃用；不得替用户选择。\n${rows.filter(Boolean).join("\n\n")}` : undefined; }
