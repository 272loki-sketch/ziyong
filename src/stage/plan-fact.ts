import type { PlotAdaptation } from "./plot-adaptation.ts";
import type { SceneConductor } from "./scene-conductor.ts";

export interface PlanFactComparison { version: 1; selectedEvent: string; actualOutcome: string; eventStatus: "not-used" | "partially-advanced" | "advanced" | "diverged"; foreshadowingStatus: "not-planted" | "suggested" | "planted"; nextPressure: string; evidence: string[]; }
const text = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, max = 4) => Array.isArray(value) ? value.map((item) => text(item, 280)).filter(Boolean).slice(0, max) : [];
export function buildPlanFactPrompt(input: { plot?: PlotAdaptation; scene?: SceneConductor; narrative: string }): { systemPrompt: string; userText: string } {
	return { systemPrompt: `你是梨园的“计划—事实对照 agent”。只根据已写出的正文，核对本拍候选是否实际发生、推进到何种程度、候选伏笔是否真正写入，以及下一拍保留什么压力。绝不把候选补写成事实；正文没有证据时必须写 not-used 或 not-planted。只返回 JSON：{"selectedEvent":"","actualOutcome":"","eventStatus":"not-used|partially-advanced|advanced|diverged","foreshadowingStatus":"not-planted|suggested|planted","nextPressure":"","evidence":[]}。`, userText: JSON.stringify({ plot_candidate_not_fact: input.plot ?? null, scene_plan_not_fact: input.scene ?? null, actual_narrative: input.narrative }, null, 2) };
}
export function parsePlanFact(value: unknown): PlanFactComparison | undefined {
	let row: Record<string, unknown> | undefined;
	if (value && typeof value === "object" && !Array.isArray(value)) row = value as Record<string, unknown>;
	else if (typeof value === "string") for (const source of [value, value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], value.match(/\{[\s\S]*\}/)?.[0]]) { try { const parsed = source && JSON.parse(source); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { row = parsed; break; } } catch {} }
	if (!row) return undefined;
	const eventStatus = ["not-used", "partially-advanced", "advanced", "diverged"].includes(String(row.eventStatus)) ? row.eventStatus as PlanFactComparison["eventStatus"] : "not-used";
	const foreshadowingStatus = ["not-planted", "suggested", "planted"].includes(String(row.foreshadowingStatus)) ? row.foreshadowingStatus as PlanFactComparison["foreshadowingStatus"] : "not-planted";
	const result = { version: 1 as const, selectedEvent: text(row.selectedEvent, 180), actualOutcome: text(row.actualOutcome), eventStatus, foreshadowingStatus, nextPressure: text(row.nextPressure), evidence: strings(row.evidence) };
	return result.actualOutcome || result.nextPressure || result.evidence.length ? result : undefined;
}
