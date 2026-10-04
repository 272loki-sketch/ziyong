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

export function buildSceneConductorPrompt(input: { plot?: PlotAdaptation; direction?: LiteraryDirection; outline: OutlineProjection }): { systemPrompt: string; userText: string } {
	return { systemPrompt: `你是梨园正文生成前的“场面编排 agent”。把导演方向和生态剧情候选组织成一个当前场景的行动顺序。你不写叙事正文、完整对白、状态补丁或未来剧情；只安排谁先行动、谁如何回应、何处产生信息差，以及何时把行动权交还用户。\n\n所有输入中的候选都不是事实。只能安排当前场景的一次互动，不能替用户行动或让角色说出其未知秘密。turnOrder 的每项应是“角色/环境动作 → 可见反应 → 局势变化”的短链，不超过五项。严格返回 JSON：{"sceneObjective":"","turnOrder":[],"pressureShift":"","informationBoundary":[],"playerStop":"","avoid":[]}。`, userText: JSON.stringify({
		ecology_plot_adaptation_candidate_not_fact: input.plot ?? null,
		director_direction_candidate_not_fact: input.direction ?? null,
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
	const rows = [value.sceneObjective && `场景目标：${value.sceneObjective}`, value.turnOrder.length && `行动顺序：\n${value.turnOrder.map((x, i) => `${i + 1}. ${x}`).join("\n")}`, value.pressureShift && `压力变化：${value.pressureShift}`, value.informationBoundary.length && `信息边界：${value.informationBoundary.join("；")}`, value.playerStop && `玩家停点：${value.playerStop}`, value.avoid.length && `避免：${value.avoid.join("；")}`].filter(Boolean);
	return rows.length ? `【场面编排】\n这是当前一拍的行动顺序参考，不是正文或已发生事实。严格保留用户行动权；可根据实际落笔调整，但不得越过玩家停点。\n${rows.join("\n")}` : undefined;
}
