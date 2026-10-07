import type { GenerationWorkflow } from "../../src/stage/generation-mode.ts";

export type GenerationStageStatus = GenerationWorkflow["stages"][number]["status"];

const STATUS_PRESENTATION: Record<GenerationStageStatus, { label: string; icon: string }> = {
	success: { label: "成功", icon: "✓" },
	degraded: { label: "报告待复核", icon: "!" },
	failed: { label: "失败", icon: "×" },
	skipped: { label: "跳过", icon: "○" },
};

export function generationStageStatusPresentation(status: GenerationStageStatus) {
	return STATUS_PRESENTATION[status];
}

export function generationStageLabel(stage: GenerationWorkflow["stages"][number]["stage"]): string {
	const labels: Record<GenerationWorkflow["stages"][number]["stage"], string> = {
		evidence: "证据分析",
		ideas: "创意分析",
		draft: "候选写作",
		review: "审阅",
		revision: "修订",
		finalize: "定稿",
	};
	return labels[stage];
}
