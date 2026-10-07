import type { SideModelStep } from "../model-routing.ts";
import type { SkillFile } from "./skill-store.ts";

export type DirectorRole =
	| "continuity"
	| "setting"
	| "ecology"
	| "idea-a"
	| "idea-b"
	| "review-facts"
	| "review-style";

export type DirectorPhase = "evidence" | "ideas" | "review";

export const DIRECTOR_ROLES: Record<DirectorPhase, readonly DirectorRole[]> = {
	evidence: ["continuity", "setting", "ecology"],
	ideas: ["idea-a", "idea-b"],
	review: ["review-facts", "review-style"],
};

export interface DirectorContext {
	userText: string;
	card: unknown;
	state: unknown;
	history: Array<{ role: string; text: string }>;
	summary?: string;
	world?: unknown;
	ecology?: unknown;
	outline?: unknown;
	lore?: unknown;
	/** Legacy assembled preset, used only when the style reviewer has no pure preset. */
	presetText?: string;
	/** Pure author-written preset blocks, without assembled card/world markers. */
	writerPresetText?: string;
	constantLore?: unknown;
	userPersona?: string;
	/** Advisory bridge only; these reports never become canonical sources. */
	priorReports?: DirectorReport[];
	draft?: string;
	sources: Array<{ id: string; text: string }>;
	sessionId: string;
	leafId: string | null;
}

export interface DirectorTask {
	role: DirectorRole;
	task: string;
}

export interface DirectorReport {
	role: DirectorRole;
	status: "success" | "degraded" | "failed";
	summary: string;
	facts: Array<{ text: string; sourceIds: string[] }>;
	inferences: string[];
	candidates: string[];
	issues: Array<{ text: string; sourceIds: string[] }>;
}

const ROLE_STEP: Record<DirectorRole, SideModelStep> = {
	continuity: "literaryContinuity" as SideModelStep,
	setting: "directorSetting" as SideModelStep,
	ecology: "ecologyRuntime" as SideModelStep,
	"idea-a": "directorIdeas" as SideModelStep,
	"idea-b": "directorIdeas" as SideModelStep,
	"review-facts": "directorReviewFacts" as SideModelStep,
	"review-style": "directorReviewStyle" as SideModelStep,
};

const ROLE_WORKFLOW: Record<DirectorRole, string> = {
	continuity: "director-evidence",
	setting: "director-setting",
	ecology: "director-ecology",
	"idea-a": "director-ideas",
	"idea-b": "director-ideas",
	"review-facts": "director-review-facts",
	"review-style": "director-review-style",
};

const ECOLOGY_ROLES = new Set<DirectorRole>(["ecology", "idea-a", "idea-b", "review-facts"]);
const OUTLINE_ROLES = new Set<DirectorRole>(["idea-a", "idea-b"]);

const MAX_TOKENS_PER_ROLE = 1_200;
const MAX_SUMMARY_CHARS = 360;
const MAX_ITEM_CHARS = 420;
const MAX_FACTS = 8;
const MAX_INFERENCES = 8;
const MAX_CANDIDATES = 8;
const MAX_ISSUES = 8;
const MAX_SOURCE_IDS = 6;
const MAX_REPORT_CHARS = 280;
const MAX_REPAIR_REPORT_CHARS = 24_000;

type ReportValidationError = {
	code: "invalid_source_ids" | "invalid_report_schema";
	path?: string;
	sourceIds?: unknown;
};

const own = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const cleanText = (value: unknown, max: number): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const unique = <T>(values: T[]): T[] => [...new Set(values)];

function unavailableReport(role: DirectorRole, summary: string, status: DirectorReport["status"] = "failed"): DirectorReport {
	return { role, status, summary: cleanText(summary, MAX_SUMMARY_CHARS), facts: [], inferences: [], candidates: [], issues: [] };
}

function boundedJson(value: unknown, maxChars: number): unknown {
	if (value === undefined) return null;
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		serialized = String(value);
	}
	if (serialized.length <= maxChars) {
		try { return JSON.parse(serialized) as unknown; } catch { return serialized; }
	}
	return { truncated: true, excerpt: serialized.slice(0, Math.max(0, maxChars - 48)) };
}

function boundedHistory(history: DirectorContext["history"]): Array<{ role: string; text: string }> {
	let remaining = 5_000;
	const selected: Array<{ role: string; text: string }> = [];
	for (const item of history.slice(-8)) {
		if (remaining <= 0) break;
		const text = cleanText(item?.text, Math.min(1_200, remaining));
		if (!text) continue;
		selected.push({ role: cleanText(item?.role, 80), text });
		remaining -= text.length;
	}
	return selected;
}

function boundedSources(sources: DirectorContext["sources"]): Array<{ id: string; text: string }> {
	let remaining = 12_000;
	const result: Array<{ id: string; text: string }> = [];
	for (const source of sources) {
		if (remaining <= 0 || result.length >= 24) break;
		if (typeof source?.id !== "string" || !source.id.trim()) continue;
		const text = cleanText(source.text, Math.min(1_000, remaining));
		if (!text || result.some(item => item.id === source.id)) continue;
		result.push({ id: source.id, text });
		remaining -= text.length;
	}
	return result;
}

function boundedPriorReports(context: DirectorContext, visible: Set<string>): DirectorReport[] {
	return (context.priorReports ?? []).slice(-5).map(report => ({
		role: report.role, status: report.status,
		summary: cleanText(report.summary, 240),
		facts: report.facts.filter(item => item.sourceIds.every(id => visible.has(id))).slice(0, 4),
		inferences: report.inferences.slice(0, 3).map(item => cleanText(item, 240)),
		candidates: report.candidates.slice(0, 2).map(item => cleanText(item, 300)),
		issues: report.issues.filter(item => item.sourceIds.every(id => visible.has(id))).slice(0, 3),
	}));
}

function buildUserPayload(phase: DirectorPhase, task: DirectorTask, context: DirectorContext): string {
	const review = phase === "review", style = task.role === "review-style";
	const needsEcology = ECOLOGY_ROLES.has(task.role), needsOutline = OUTLINE_ROLES.has(task.role);
	const presetText = style ? context.writerPresetText ?? context.presetText : undefined;
	// Filter before budgeting: excluded role material must not displace real sources.
	const sources = (context.sources ?? []).filter(source =>
		(style || source.id !== "preset") && (needsEcology || source.id !== "ecology") && (needsOutline || source.id !== "outline"))
		.map(source => style && source.id === "preset" && context.writerPresetText !== undefined
			? { ...source, text: context.writerPresetText } : source);
	const payload = {
		role: task.role,
		task: cleanText(task.task, 2_000),
		context: {
			userText: cleanText(context.userText, 6_000),
			card: boundedJson(context.card, 10_000),
			state: boundedJson(context.state, 10_000),
			history: boundedHistory(context.history ?? []),
			...(context.summary !== undefined ? { summary: cleanText(context.summary, 4_000) } : {}),
			...(context.world !== undefined ? { world: boundedJson(context.world, 8_000) } : {}),
			...(needsEcology && context.ecology !== undefined ? { ecology: boundedJson(context.ecology, 6_000) } : {}),
			...(needsOutline && context.outline !== undefined ? { outline: boundedJson(context.outline, 6_000) } : {}),
			...(context.lore !== undefined ? { lore: boundedJson(context.lore, 6_000) } : {}),
			...(context.constantLore !== undefined ? { constantLore: boundedJson(context.constantLore, 6_000) } : {}),
			...(presetText !== undefined ? { presetText } : {}),
			...(context.userPersona !== undefined ? { userPersona: cleanText(context.userPersona, 6_000) } : {}),
			...(review && context.draft !== undefined ? { draft: context.draft } : {}),
			sources: boundedSources(sources),
		},
	};
	const sourceScope = [
		...payload.context.sources.map((source, index) => ({ id: source.id, path: `context.sources[${index}].text` })),
		...Object.entries(payload.context).filter(([key, value]) => !["history", "sources", "draft"].includes(key)
			&& value !== null && value !== undefined && (typeof value !== "string" || value.trim().length > 0))
			.map(([key]) => ({ id: `ctx:${key}`, path: `context.${key}` })),
		...(review && typeof payload.context.draft === "string" && payload.context.draft.trim() ? [{ id: "draft", path: "context.draft" }] : []),
	];
	const priorReports = context.priorReports?.length
		? boundedPriorReports(context, new Set(sourceScope.map(source => source.id))) : undefined;
	return JSON.stringify({ ...payload,
		context: { ...payload.context, ...(priorReports ? { priorReports } : {}) },
		source_scope: sourceScope,
	}, null, 2);
}

function extractObject(value: string): Record<string, unknown> | null {
	const source = value.trim();
	const candidates = [source, source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (own(parsed)) return parsed;
		} catch { /* Try a prose-wrapped JSON object below. */ }
	}
	const start = source.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) {
			try {
				const parsed: unknown = JSON.parse(source.slice(start, index + 1));
				return own(parsed) ? parsed : null;
			} catch { return null; }
		}
	}
	return null;
}

function stringItems(value: unknown, maxItems: number, maxChars: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => cleanText(item, maxChars)).filter(Boolean).slice(0, maxItems);
}

function sourceIds(value: unknown, validIds: Set<string>): { ids: string[]; valid: boolean } {
	if (!Array.isArray(value) || value.length === 0) return { ids: [], valid: false };
	const raw = value.filter((item): item is string => typeof item === "string");
	const distinct = unique(raw);
	const valid = raw.length === value.length && distinct.length > 0 && distinct.every((id) => validIds.has(id));
	return { ids: distinct.filter((id) => validIds.has(id)).slice(0, MAX_SOURCE_IDS), valid };
}

function evidenceItems(
	value: unknown,
	validIds: Set<string>,
	asInference: string[],
	maxItems: number,
	field: "facts" | "issues",
	validationErrors: ReportValidationError[],
): Array<{ text: string; sourceIds: string[] }> {
	if (!Array.isArray(value)) return [];
	const accepted: Array<{ text: string; sourceIds: string[] }> = [];
	for (const [index, item] of value.slice(0, maxItems).entries()) {
		if (!own(item)) continue;
		const text = cleanText(item.text, MAX_ITEM_CHARS);
		if (!text) continue;
		const refs = sourceIds(item.sourceIds, validIds);
		if (!refs.valid) {
			validationErrors.push({ code: "invalid_source_ids", path: `${field}[${index}].sourceIds`, sourceIds: boundedJson(item.sourceIds, MAX_ITEM_CHARS) });
			asInference.push(text.startsWith("未证实") ? text : `未证实：${text}`);
			continue;
		}
		accepted.push({ text, sourceIds: refs.ids });
	}
	return accepted;
}

function parseReport(value: string, role: DirectorRole, validIds: Set<string>, validationErrors: ReportValidationError[] = []): DirectorReport | null {
	const parsed = extractObject(value);
	if (!parsed || typeof parsed.summary !== "string" || !["facts", "inferences", "candidates", "issues"].every(key => Array.isArray(parsed[key]))) {
		validationErrors.push({ code: "invalid_report_schema" });
		return null;
	}
	const inferences = stringItems(parsed.inferences, MAX_INFERENCES, MAX_ITEM_CHARS);
	const facts = evidenceItems(parsed.facts, validIds, inferences, MAX_FACTS, "facts", validationErrors);
	const issues = evidenceItems(parsed.issues, validIds, inferences, MAX_ISSUES, "issues", validationErrors);
	const summary = cleanText(parsed.summary, MAX_SUMMARY_CHARS);
	return {
		role,
		status: inferences.length > stringItems(parsed.inferences, MAX_INFERENCES, MAX_ITEM_CHARS).length ? "degraded" : "success",
		summary,
		facts,
		inferences: unique(inferences).slice(0, MAX_INFERENCES),
		candidates: stringItems(parsed.candidates, MAX_CANDIDATES, MAX_ITEM_CHARS),
		issues,
	};
}

function current(signal?: AbortSignal, isCurrent?: () => boolean): boolean {
	if (signal?.aborted) return false;
	if (!isCurrent) return true;
	try { return isCurrent(); } catch { return false; }
}

function skillFor(skills: SkillFile[], role: DirectorRole): SkillFile | undefined {
	const workflow = ROLE_WORKFLOW[role];
	return skills.find((skill) => skill.workflow === workflow);
}

function cancellationReports(tasks: DirectorTask[]): DirectorReport[] {
	return tasks.map((task) => unavailableReport(task.role, "批次已取消或上下文已切换；结果未采用。", "failed"));
}

/**
 * Execute one fixed expert stage. Experts produce bounded advisory reports only;
 * callers remain the sole owners of narrative drafts and edits.
 */
export async function executeDirectorBatch(input: {
	phase: DirectorPhase;
	tasks: DirectorTask[];
	context: DirectorContext;
	skills: SkillFile[];
	run: (step: SideModelStep, system: string, user: string, maxTokens: number, recoverMalformed?: boolean) => Promise<string | { error: string }>;
	repairMalformed?: boolean;
	signal?: AbortSignal;
	isCurrent?: () => boolean;
	onActivity?: (detail: string) => void;
}): Promise<DirectorReport[]> {
	if (!(input.phase in DIRECTOR_ROLES)) throw new Error(`未知导演阶段：${String(input.phase)}`);
	const expected = DIRECTOR_ROLES[input.phase];
	if (!Array.isArray(input.tasks) || input.tasks.length !== expected.length) {
		throw new Error(`${input.phase} 阶段必须恰好提供 ${expected.length} 个专家任务`);
	}
	const seen = new Set<string>();
	for (const task of input.tasks) {
		if (!task || !expected.includes(task.role)) throw new Error(`${input.phase} 阶段包含未知或不匹配的专家角色`);
		if (seen.has(task.role)) throw new Error(`专家角色重复：${task.role}`);
		seen.add(task.role);
	}
	if (seen.size !== expected.length || expected.some((role) => !seen.has(role))) {
		throw new Error(`${input.phase} 阶段必须覆盖全部固定专家角色`);
	}
	if (!current(input.signal, input.isCurrent)) return cancellationReports(input.tasks);
	let stopped = false;
	let stopTimer: ReturnType<typeof setInterval> | undefined;
	let resolveStop!: () => void;
	const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		resolveStop();
	};
	const onAbort = (): void => stop();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.isCurrent) {
		stopTimer = setInterval(() => {
			if (!current(input.signal, input.isCurrent)) stop();
		}, 100);
	}

	const requests = input.tasks.map(async (task): Promise<DirectorReport> => {
		if (!current(input.signal, input.isCurrent)) return unavailableReport(task.role, "批次已取消或上下文已切换；结果未采用。", "failed");
		const skill = skillFor(input.skills, task.role);
		if (!skill?.body.trim()) return unavailableReport(task.role, `缺少工作流 Skill：${ROLE_WORKFLOW[task.role]}`);
		try {
			try { input.onActivity?.(`导演专家：${task.role}`); } catch { /* Activity reporting must not affect the run. */ }
			const userPayload = buildUserPayload(input.phase, task, input.context);
			const sent = JSON.parse(userPayload) as { source_scope: Array<{ id: string }> };
			const validIds = new Set(sent.source_scope.map(source => source.id));
			const result = await input.run(ROLE_STEP[task.role], skill.body, userPayload, MAX_TOKENS_PER_ROLE);
			if (!current(input.signal, input.isCurrent) || stopped) return unavailableReport(task.role, "批次已取消或上下文已切换；结果未采用。", "failed");
			if (typeof result !== "string") return unavailableReport(task.role, `专家请求失败：${cleanText(result?.error, 260) || "未知错误"}`);
			const validationErrors: ReportValidationError[] = [];
			let report = parseReport(result, task.role, validIds, validationErrors);
			if ((!report || report.status === "degraded") && input.repairMalformed && current(input.signal, input.isCurrent)) {
				try { input.onActivity?.(`导演专家 ${task.role} 报告校验失败：使用已配置恢复模型重取同岗位，未跳过审阅。`); } catch { /* Activity reporting must not affect recovery. */ }
				// Only machine feedback is added; the same role/Skill owns the new report.
				const repairPayload = JSON.stringify({ ...JSON.parse(userPayload),
					validation_errors: validationErrors.slice(0, MAX_FACTS + MAX_ISSUES),
					invalid_report: result.slice(0, MAX_REPAIR_REPORT_CHARS),
				}, null, 2);
				const repaired = await input.run(ROLE_STEP[task.role], skill.body, repairPayload, MAX_TOKENS_PER_ROLE * 3, true);
				if (!current(input.signal, input.isCurrent) || stopped) return unavailableReport(task.role, "批次已取消或上下文已切换；结果未采用。", "failed");
				if (typeof repaired !== "string") return unavailableReport(task.role, `专家报告恢复请求失败：${cleanText(repaired?.error, 260) || "未知错误"}`);
				validationErrors.length = 0;
				report = parseReport(repaired, task.role, validIds, validationErrors);
			}
			if (input.repairMalformed && report?.status === "degraded") return {
				...report, status: "failed",
				summary: cleanText(`专家报告来源校验失败：同岗位恢复后仍有无效 sourceIds（${validationErrors.map(error => error.path).filter(Boolean).join("、")}）。`, MAX_SUMMARY_CHARS),
			};
			return report ?? unavailableReport(task.role, "专家返回无法解析的报告。", "failed");
		} catch (error) {
			if (!current(input.signal, input.isCurrent) || stopped) return unavailableReport(task.role, "批次已取消或上下文已切换；结果未采用。", "failed");
			return unavailableReport(task.role, `专家请求失败：${cleanText(error instanceof Error ? error.message : String(error), 260) || "未知错误"}`);
		}
	});

	try {
		const outcome = await Promise.race([
			Promise.all(requests).then((reports) => ({ kind: "done" as const, reports })),
			stopPromise.then(() => ({ kind: "stopped" as const })),
		]);
		if (outcome.kind === "stopped" || !current(input.signal, input.isCurrent)) return cancellationReports(input.tasks);
		return outcome.reports;
	} finally {
		if (stopTimer) clearInterval(stopTimer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}

const ROLE_LABEL: Record<DirectorRole, string> = {
	continuity: "连续性证据",
	setting: "设定核对",
	ecology: "生态参考",
	"idea-a": "构思 A",
	"idea-b": "构思 B",
	"review-facts": "事实审阅",
	"review-style": "预设审阅",
};

/** Render only the public report protocol, never prompts, raw model output, or hidden reasoning. */
export function formatDirectorReports(reports: DirectorReport[]): string {
	const blocks = reports.map((report) => {
		const lines = [`【导演专家｜${ROLE_LABEL[report.role]}｜${report.status}】`];
		const summary = cleanText(report.summary, MAX_REPORT_CHARS);
		if (summary) lines.push(summary);
		for (const fact of report.facts.slice(0, MAX_FACTS)) {
			const text = cleanText(fact.text, MAX_REPORT_CHARS);
			const ids = fact.sourceIds.slice(0, MAX_SOURCE_IDS).map((id) => cleanText(id, 120)).filter(Boolean);
			if (text) lines.push(`证据：${text}${ids.length ? `〔${ids.join("、")}〕` : ""}`);
		}
		for (const inference of report.inferences.slice(0, MAX_INFERENCES)) {
			const text = cleanText(inference, MAX_REPORT_CHARS);
			if (text) lines.push(`未证实推断：${text}`);
		}
		for (const candidate of report.candidates.slice(0, MAX_CANDIDATES)) {
			const text = cleanText(candidate, MAX_REPORT_CHARS);
			if (text) lines.push(`候选（非正文、非事实）：${text}`);
		}
		for (const issue of report.issues.slice(0, MAX_ISSUES)) {
			const text = cleanText(issue.text, MAX_REPORT_CHARS);
			const ids = issue.sourceIds.slice(0, MAX_SOURCE_IDS).map((id) => cleanText(id, 120)).filter(Boolean);
			if (text) lines.push(`审阅问题：${text}${ids.length ? `〔${ids.join("、")}〕` : ""}`);
		}
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}

/** Return the main director's editable Skill body; an absent Skill stays absent. */
export function directorMainSkill(skills: SkillFile[]): string {
	return skills.find((skill) => String(skill.workflow) === "director-main")?.body ?? "";
}
