/** 模式是提交身份的一部分，不由剧情重要性推断。 */
export type GenerationMode = "direct" | "director";
export const DEFAULT_GENERATION_MODE: GenerationMode = "director";
export function isGenerationMode(value: unknown): value is GenerationMode {
	return value === "direct" || value === "director";
}
export function effectiveGenerationMode(value: unknown): GenerationMode {
	return isGenerationMode(value) ? value : DEFAULT_GENERATION_MODE;
}
export interface GenerationStageReceipt {
	stage: "evidence" | "ideas" | "draft" | "review" | "revision" | "finalize";
	status: "success" | "degraded" | "failed" | "skipped";
	calls: number;
}
export interface GenerationWorkflow {
	version: 1;
	mode: GenerationMode;
	stages: GenerationStageReceipt[];
	writerRounds: number;
	toolFallback: boolean;
	toolFallbackReason?: "configured" | "unsupported";
}
/** Wire 只允许有限的阶段元信息；不传原始报告、prompt、reasoning。 */
export function generationWorkflowView(value: unknown): GenerationWorkflow | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	if (row.version !== 1 || !isGenerationMode(row.mode)) return undefined;
	const stages = ["evidence", "ideas", "draft", "review", "revision", "finalize"];
	const statuses = ["success", "degraded", "failed", "skipped"];
	return { version: 1, mode: row.mode, writerRounds: Math.max(0, Math.min(40, Number(row.writerRounds) || 0)), toolFallback: row.toolFallback === true,
		...(["configured", "unsupported"].includes(String(row.toolFallbackReason)) ? { toolFallbackReason: row.toolFallbackReason as "configured" | "unsupported" } : {}),
		stages: (Array.isArray(row.stages) ? row.stages : []).flatMap(item => {
			if (!item || typeof item !== "object") return [];
			const v = item as Record<string, unknown>;
			if (!stages.includes(String(v.stage)) || !statuses.includes(String(v.status))) return [];
			return [{ stage: v.stage as GenerationStageReceipt["stage"], status: v.status as GenerationStageReceipt["status"], calls: Math.max(0, Math.min(16, Number(v.calls) || 0)) }];
		}).slice(0, 40) };
}
