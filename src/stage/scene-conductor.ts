import type { OutlineProjection } from "../outline/projection.ts";
import type { LiteraryDirection } from "./literary-director.ts";
import type { PlotAdaptation } from "./plot-adaptation.ts";

export interface SceneConductor {
	version: 1;
	sceneObjective: string;
	turnOrder: string[];
	pressureShift: string;
	informationBoundary: string[];
	playerStop: string;
	avoid: string[];
}

const clean = (value: unknown, max = 360) => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, max = 5) => Array.isArray(value) ? value.map((x) => clean(x, 260)).filter(Boolean).slice(0, max) : [];

function objectOf(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const source = value.trim();
	for (const candidate of [source, source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], source.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {}
	}
	return null;
}

/** 旧候选中的交接/文风字段不继续传入编排请求。 */
function directionForConductor(value: LiteraryDirection | undefined) {
	if (!value) return null;
	const { playerStop: _stop, sceneMode: _mode, subtext: _subtext, rhythm: _rhythm, dialogueRatio: _ratio, sensoryFocus: _sensory, avoid: _avoid, ...direction } = value;
	return direction;
}

function plotForConductor(value: PlotAdaptation | undefined) {
	if (!value) return null;
	const project = ({ playerAgency: _agency, progressLimit: _limit, ...candidate }: NonNullable<PlotAdaptation["selected"]>) => candidate;
	return { ...value, selected: value.selected ? project(value.selected) : undefined, reserves: value.reserves.map(project) };
}

export function buildSceneConductorPrompt(input: { plot?: PlotAdaptation; direction?: LiteraryDirection; outline: OutlineProjection }): { systemPrompt: string; userText: string } {
	return { systemPrompt: `你是梨园正文生成前的“场面编排 agent”。把导演方向和生态剧情候选组织成一个当前场景的行动顺序。你不写叙事正文、完整对白、状态补丁或未来剧情；只提供当前场景的简短行动顺序参考和已明确的信息边界。\n\n所有输入中的候选都不是事实。只能安排当前场景内有依据的发展，不能让角色说出其未知秘密。turnOrder 不超过五项。严格返回 JSON：{"sceneObjective":"","turnOrder":[],"pressureShift":"","informationBoundary":[],"avoid":[]}。`, userText: JSON.stringify({
		ecology_plot_adaptation_candidate_not_fact: plotForConductor(input.plot),
		director_direction_candidate_not_fact: directionForConductor(input.direction),
		committed_outline_candidate_not_fact: input.outline,
	}, null, 2) };
}

export function parseSceneConductor(value: unknown): SceneConductor | undefined {
	const row = objectOf(value); if (!row) return undefined;
	const result: SceneConductor = { version: 1, sceneObjective: clean(row.sceneObjective), turnOrder: strings(row.turnOrder), pressureShift: clean(row.pressureShift), informationBoundary: strings(row.informationBoundary), playerStop: clean(row.playerStop), avoid: strings(row.avoid) };
	return result.sceneObjective || result.turnOrder.length || result.playerStop ? result : undefined;
}

export function formatSceneConductor(value: SceneConductor | undefined): string | undefined {
	if (!value) return undefined;
	const rows = [value.sceneObjective && `场景目标：${value.sceneObjective}`, value.turnOrder.length && `行动顺序：\n${value.turnOrder.map((x, i) => `${i + 1}. ${x}`).join("\n")}`, value.pressureShift && `压力变化：${value.pressureShift}`, value.informationBoundary.length && `信息边界：${value.informationBoundary.join("；")}`, value.avoid.length && `避免：${value.avoid.join("；")}`].filter(Boolean);
	return rows.length ? `【场面编排】\n这是当前一拍的行动顺序参考，不是正文或已发生事实。\n${rows.join("\n")}` : undefined;
}
