export const SIDE_MODEL_STEPS = [
	"writer",
	"literaryContinuity",
	"literaryDirector",
	"literaryCharacter",
	"characterRehearsal",
	"literaryPersona",
	"literaryWorld",
	"worldProfile",
	"literaryWorldFacts",
	"literaryWorldAudit",
	"ecologySearch",
	"ecologyGlobal",
	"ecologyCard",
	"ecologyRuntime",
	"plotAdaptation",
	"sceneConductor",
	"outlineChat",
	"outlineBootstrap",
	"outlineReconcile",
	"outlineForeshadowing",
	"outlineAudit",
	"outlineResearch",
	"outlineCorpusResearch",
	"novelDigest",
	"contractDeclare",
	"scribe",
	"compaction",
	"memoryEvents",
	"presetSort",
] as const;

export type SideModelStep = (typeof SIDE_MODEL_STEPS)[number];
export interface ModelRef { provider: string; id: string }
export type StepModelOverrides = Partial<Record<SideModelStep, ModelRef>>;

export function normalizeStepModels(value: unknown): StepModelOverrides | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const result: StepModelOverrides = {};
	for (const step of SIDE_MODEL_STEPS) {
		const raw = source[step];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const provider = typeof (raw as { provider?: unknown }).provider === "string"
			? (raw as { provider: string }).provider.trim() : "";
		const id = typeof (raw as { id?: unknown }).id === "string"
			? (raw as { id: string }).id.trim() : "";
		if (provider && id) result[step] = { provider, id };
	}
	return Object.keys(result).length ? result : undefined;
}

export function resolveStepModel<M>(
	step: SideModelStep,
	stepModels: StepModelOverrides | undefined,
	primary: M | undefined,
	find: (provider: string, id: string) => M | undefined,
	findById?: (id: string) => M | undefined,
	fallbackChain?: SideModelStep[],
): { model?: M; requested?: ModelRef; fallback: boolean } {
	if (!primary) return { fallback: false };
	let fallbackResolved: {
		requested?: ModelRef;
		selected?: M;
	} | undefined;
	// novelDigest 未显式配置时回退 outlineResearch 插头（同一套研究旁路家族再落到总插头）。
	if (!stepModels?.[step] && fallbackChain?.length) {
		for (const candidate of fallbackChain) {
			const requested = stepModels?.[candidate];
			if (!requested) continue;
			const selected = find(requested.provider, requested.id) ?? findById?.(requested.id);
			if (selected) { fallbackResolved = { requested, selected }; break; }
		}
	}
	if (fallbackResolved?.selected) return { model: fallbackResolved.selected, requested: fallbackResolved.requested, fallback: false };
	const requested = stepModels?.[step];
	if (!requested) return { model: primary, fallback: false };
	// provider 是渠道配置名，用户删掉旧渠道再以新名字接入同一模型时会变化；
	// model id 才是跨渠道迁移时相对稳定的标识。先精确匹配，失效后按 id 唯一重定位。
	const selected = find(requested.provider, requested.id) ?? findById?.(requested.id);
	return selected
		? { model: selected, requested, fallback: false }
		: { model: primary, requested, fallback: true };
}
