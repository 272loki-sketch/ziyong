/**
 * 长局压缩（PLAN-RP-HARNESS M4，R3 上下文 = f(分支)）。
 *
 * 台上引擎自管压缩：攒够 N 拍就把早期剧情交给旁路模型写一份接力摘要，
 * 落 rp-summary 快照（CustomEntry）；装配时 rebuildHistory 读回为【前情提要】，
 * 被覆盖的条目整段不进上下文——裁剪不是「减法」，而是装配时就不存在。
 *
 * 为什么不再用 session.compact()：旧路径压的是 pi 的 AgentSession 消息副本，
 * 看不全引擎写进树的东西（rp-draft-op 补丁、rp-state 快照、引擎直落的 assistant），
 * 于是长局压不动。压缩权跟着上下文权走——谁装配，谁压缩。
 *
 * 三条纪律：
 * - **保留最近 K 拍原文**：摘要只接早期剧情，续演点仍是逐字的近拍（防剧情倒退，契约 §5）；
 * - **合并旧摘要**：每次把上一份摘要并进新摘要，故分支上永远只有「最后一条摘要」生效；
 * - **叶守卫（R9）**：旁路调用期间 swipe/rewind 则整体丢弃——摘要绝不能落到导航后的分支上。
 *
 * 被裁正文在落摘要前**完整归档进剧情库**（memory_search 可召回细节）：
 * 摘要管连续性，归档管细节，两者互补。
 */

import {
	rebuildHistory,
	activeSummary,
	SUMMARY_ENTRY_TYPE,
	type BranchEntryLike,
	type RpSummaryData,
} from "./assemble.ts";
import { buildRpSummaryPrompt, validateRpSummaryMarkdown } from "../scribe.ts";
import { formatState } from "../state.ts";
import type { RpEventDigest } from "../memory/types.ts";
import type { WorldState } from "../types.ts";

export { SUMMARY_ENTRY_TYPE };
export type { RpSummaryData };

/** 压缩后原样保留的最近拍数（续演点必须逐字，摘要只接更早的剧情） */
export const KEEP_RECENT_BEATS = 6;

/** 可裁正文的字数地板：低于此值不值得烧一次旁路调用（自动压缩用） */
export const MIN_COMPACT_CHARS = 2000;

/**
 * 手动压缩（/compact）的字数地板。用户明确点了压缩，就不该拿「攒得还不够多」
 * 把人挡回去——只要真有可裁的早期剧情就压。仍留一个下限：几百字的开局压了等于没压。
 */
export const MANUAL_MIN_COMPACT_CHARS = 500;
/** 单次摘要旁路输入硬上限；更长历史先压较早窗口，后续拍继续滚动压缩。 */
export const MAX_COMPACT_INPUT_CHARS = 120_000;

export interface CompactPlan {
	/** 覆盖到此条目为止（含）——装配时该条及之前不进历史 */
	coversThroughId: string;
	/** 待摘要的条目（已按分支顺序） */
	covered: BranchEntryLike[];
	/** 覆盖的叙事拍数（用户消息条数） */
	turns: number;
	/** 序列化后的待摘要正文 */
	conversationText: string;
	/** 更早剧情的既有摘要（合并进本次摘要） */
	previousSummary?: string;
}

export interface PlanCompactionOptions {
	/** 每 N 个叙事拍压缩一次；<=0 关闭 */
	everyNTurns: number;
	userName: string;
	charName: string;
	/** 保留最近拍数（缺省 KEEP_RECENT_BEATS） */
	keepRecentBeats?: number;
	/** 可裁正文字数地板（缺省 MIN_COMPACT_CHARS） */
	minChars?: number;
}

/**
 * 序列化待摘要区间为对话文本。走 rebuildHistory 同一条路：
 * 补丁已套、过程条目不存在——摘要读到的与模型当时读到的是同一份正文。
 *
 * 先剔掉区间内的摘要条目：二次压缩时，上一份 rp-summary 会落在待摘要区间内，
 * 而它的 coversThroughId 指向的条目早已被裁走——rebuildHistory 找不到锚点便退守到
 * 「摘要条目之前全裁」，反而把本次要摘的正文全丢了。旧摘要的内容不靠这条路带回，
 * 由 previousSummary 单独入提示词。
 */
export function serializeForSummary(entries: BranchEntryLike[], userName: string, charName: string): string {
	const bodyOnly = entries.filter(
		(e) => e.type !== "compaction" && !(e.type === "custom" && e.customType === SUMMARY_ENTRY_TYPE),
	);
	const { history } = rebuildHistory(bodyOnly);
	return history.map((m) => `${m.role === "user" ? userName : charName}：${m.text}`).join("\n\n");
}

/**
 * 压缩判定 + 切点计算（纯函数）。
 * 触发条件：分支上「活着的」叙事拍数 ≥ 保留拍数 + 周期，且可裁正文够长。
 * 返回 null = 本拍不压缩。
 */
export function planCompaction(branch: BranchEntryLike[], opts: PlanCompactionOptions): CompactPlan | null {
	const keep = opts.keepRecentBeats ?? KEEP_RECENT_BEATS;
	const minChars = opts.minChars ?? MIN_COMPACT_CHARS;
	if (!Number.isFinite(opts.everyNTurns) || opts.everyNTurns <= 0) return null;

	// 已被上一份摘要覆盖的前缀不再参与
	const active = activeSummary(branch);
	const live = active ? branch.slice(active.cut) : branch;

	// 拍的边界 = 用户消息；最近 keep 拍原样保留
	const beatStarts: number[] = [];
	for (let i = 0; i < live.length; i++) {
		const e = live[i];
		if (e.type === "message" && e.message?.role === "user") beatStarts.push(i);
	}
	if (beatStarts.length < keep + opts.everyNTurns) return null;

	const cutAt = beatStarts[beatStarts.length - keep];
	if (cutAt <= 0) return null;
	const covered = live.slice(0, cutAt);
	const coversThroughId = covered[covered.length - 1]?.id;
	if (!coversThroughId) return null; // 无 id 的条目（异常树）不敢下刀

	let boundedCovered = covered;
	let conversationText = serializeForSummary(boundedCovered, opts.userName, opts.charName);
	if (conversationText.length > MAX_COMPACT_INPUT_CHARS) {
		// 按完整树条目递增找最大安全前缀，绝不在一条消息中间硬切。
		let low = 1, high = covered.length, best = 0;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const candidate = serializeForSummary(covered.slice(0, mid), opts.userName, opts.charName);
			if (candidate.length <= MAX_COMPACT_INPUT_CHARS) { best = mid; low = mid + 1; }
			else high = mid - 1;
		}
		if (best === 0) return null;
		boundedCovered = covered.slice(0, best);
		conversationText = serializeForSummary(boundedCovered, opts.userName, opts.charName);
	}
	if (conversationText.length < minChars) return null;
	const boundedThroughId = boundedCovered[boundedCovered.length - 1]?.id;
	if (!boundedThroughId) return null;

	return {
		coversThroughId: boundedThroughId,
		covered: boundedCovered,
		turns: beatStarts.length - keep,
		conversationText,
		...(active ? { previousSummary: active.summary } : {}),
	};
}

export interface CompactRunDeps {
	/** 旁路文本调用：返回文本，或 {error} */
	sideText: (systemPrompt: string, userText: string) => Promise<string | { error: string }>;
	/** 摘要落树（CustomEntry：不进 pi 上下文，装配由引擎自管） */
	appendSummaryEntry: (data: RpSummaryData) => void;
	/** 叶守卫读数：调用前后各取一次，不等则丢弃 */
	getLeafId: () => string | null;
	/** 被裁正文归档进剧情库（供 memory_search 召回细节）；失败只丢召回能力 */
	archive?: (text: string, opts?: { sourceRefs?: MemorySourceRefLike[]; perEntry?: ArchiveEntryLike[] }) => Promise<void>;
	/**
	 * PLAN-RP-MEMORY：事件候选提取旁路。给定被裁正文/区间，产出事件卡并入库。
	 * 失败/未注入 = 只有摘要与归档，无事件索引（不阻塞压缩）。
	 */
	extractEvents?: (text: string, opts?: { sourceRefs?: MemorySourceRefLike[] }) => Promise<void>;
	/** 统一摘要 envelope 中已经生成的事件卡；避免摘要与事件二次生成出两套 id。 */
	appendEventDigests?: (events: RpEventDigest[], opts?: { sourceRefs?: MemorySourceRefLike[] }) => Promise<void>;
	/** 将模型使用的 sourceKey 重写成代码生成的 canonical event id；refs 为被压缩区间锚点（统一 canonical 种子）。 */
	normalizeSummary?: (summary: string, events: RpEventDigest[], refs: MemorySourceRefLike[]) => string;
	onActivity?: (detail: string) => void;
}

/** 逐 entry 归档单元：原始正文 + 它的树锚点（供精确证据切块与回源）。 */
export interface ArchiveEntryLike {
	entryId: string;
	entryType?: string;
	turn?: number;
	text: string;
}

/** 从树条目提取原始文本（与 server 回源切片用同一坐标空间）。 */
export function entryRawText(e: BranchEntryLike): string {
	if (e.type !== "message") return "";
	const content = (e.message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	return "";
}

export interface RpSummaryEnvelope {
	version: 2;
	summaryMarkdown: string;
	events: RpEventDigest[];
}

/** 宽容解析数据库式摘要 envelope；旧会话/旧模型仍可返回纯 Markdown。 */
export function parseRpSummaryEnvelope(text: string): { summary: string; events: RpEventDigest[]; wasEnvelope: boolean } {
	let raw = text.trim();
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) raw = fence[1]!.trim();
	try {
		const value = JSON.parse(raw) as Partial<RpSummaryEnvelope>;
		if (value && value.version === 2 && typeof value.summaryMarkdown === "string") {
			const events: RpEventDigest[] = [];
			if (Array.isArray(value.events)) {
				for (const rawEvent of value.events) {
					if (!rawEvent || typeof rawEvent !== "object") continue;
					const event = rawEvent as Partial<RpEventDigest>;
					const sourceKey = typeof event.sourceKey === "string" && event.sourceKey ? event.sourceKey : event.id;
					if (typeof sourceKey !== "string" || !sourceKey || typeof event.title !== "string" || !event.title.trim()) continue;
					events.push({
						...event,
						kind: "rp-event-digest",
						id: sourceKey,
						sourceKey,
						title: event.title,
						status: event.status ?? "active",
						importance: event.importance ?? "normal",
						tags: Array.isArray(event.tags) ? event.tags.filter((x): x is string => typeof x === "string") : [],
						recallAnchors: Array.isArray(event.recallAnchors) ? event.recallAnchors.filter((x): x is string => typeof x === "string") : [],
						summary: typeof event.summary === "string" ? event.summary : event.title,
						evidenceLevel: event.evidenceLevel ?? "source-backed",
						sourceRefs: Array.isArray(event.sourceRefs) ? event.sourceRefs : [],
						...(typeof event.arc === "string" && event.arc.trim() ? { arc: event.arc.trim() } : {}),
						...(Array.isArray(event.links) ? { links: event.links } : {}),
					});
				}
			}
			return { summary: value.summaryMarkdown.trim(), events, wasEnvelope: true };
		}
	} catch {
		// 旧摘要是 Markdown，继续走兼容路径。
	}
	return { summary: text.trim(), events: [], wasEnvelope: false };
}

/** 记忆 sourceRef 的最小形状（避免 service 层强耦合进 stage） */
export interface MemorySourceRefLike {
	entryId: string;
	entryType?: string;
	turn?: number;
	charFrom?: number;
	charTo?: number;
}

export interface CompactRunInput {
	branch: BranchEntryLike[];
	state: WorldState;
	language: string;
	userName: string;
	charName: string;
	everyNTurns: number;
	keepRecentBeats?: number;
	minChars?: number;
}

export type CompactOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "stale" }
	| { kind: "failed"; error: string }
	| { kind: "compacted"; summary: string; turns: number; chars: number };

/**
 * 一次压缩。任何失败都只跳过本次压缩，不影响正文——下一拍会再判一次。
 * 调用方保证：只对干净收笔的台上拍调用（中断半拍/戏外轮不压缩）。
 */
export async function runCompaction(deps: CompactRunDeps, input: CompactRunInput): Promise<CompactOutcome> {
	const plan = planCompaction(input.branch, {
		everyNTurns: input.everyNTurns,
		userName: input.userName,
		charName: input.charName,
		keepRecentBeats: input.keepRecentBeats,
		minChars: input.minChars,
	});
	if (!plan) return { kind: "skipped", reason: "not-due" };

	const leafBefore = deps.getLeafId();
	deps.onActivity?.(`正在压缩前情（${plan.turns} 拍 · ${plan.conversationText.length} 字）…`);

	const prompt = buildRpSummaryPrompt({
		conversationText: plan.conversationText,
		stateSnapshot: formatState(input.state),
		previousSummary: plan.previousSummary,
		language: input.language,
		userName: input.userName,
		charName: input.charName,
	});
	const resp = await deps.sideText(prompt.systemPrompt, prompt.userText);
	if (typeof resp !== "string") return { kind: "failed", error: resp.error };
	const envelope = parseRpSummaryEnvelope(resp);

	// 被裁区间的逐 entry 原文与平铺锚点：供归档精确切块、事件/摘要 canonical 种子统一。
	const sourceRefs: MemorySourceRefLike[] = [];
	const perEntry: ArchiveEntryLike[] = [];
	let beatTurn = 0;
	for (const e of plan.covered) {
		if (e.type === "message" && e.message?.role === "user") beatTurn++;
		if (e.id) {
			sourceRefs.push({ entryId: e.id, entryType: e.type, turn: beatTurn || undefined });
			const raw = entryRawText(e);
			if (raw.trim()) perEntry.push({ entryId: e.id, entryType: e.type, ...(beatTurn ? { turn: beatTurn } : {}), text: raw });
		}
	}

	const summary = deps.normalizeSummary ? deps.normalizeSummary(envelope.summary, envelope.events, sourceRefs) : envelope.summary;
	if (!summary) return { kind: "failed", error: "摘要为空" };
	const validation = validateRpSummaryMarkdown(summary, { requireStructured: envelope.wasEnvelope });
	if (!validation.ok) {
		deps.onActivity?.(`前情摘要拒绝提交：${validation.errors.join("；")}`);
		return { kind: "failed", error: validation.errors.join("；") };
	}

	// R9 叶守卫：调用期间树动过（swipe/rewind/切线）→ 整体丢弃
	if (deps.getLeafId() !== leafBefore) {
		deps.onActivity?.("压缩已丢弃（本拍期间切换了分支）");
		return { kind: "stale" };
	}

	// 归档先于落摘要：正文一旦被摘要覆盖就不再进上下文，细节只能靠剧情库召回。
	// These writes must finish before appendSummaryEntry advances the session leaf;
	// otherwise the engine's branch guard cancels its own queued microtasks.
	if (deps.archive) {
		await deps.archive(plan.conversationText, { sourceRefs, perEntry }).catch(() => {
			// 归档失败不挡压缩（只丢细节召回能力，连续性仍由摘要保底）
		});
	}
	// PLAN-RP-MEMORY：事件候选提取（与被裁区间同源）。
	if (envelope.events.length === 0 && deps.extractEvents) {
		await deps.extractEvents(plan.conversationText, { sourceRefs }).catch(() => {
			// 事件提取失败不挡压缩（只丢事件索引能力）
		});
	}
	if (envelope.events.length > 0 && deps.appendEventDigests) {
		await deps.appendEventDigests(envelope.events, { sourceRefs }).catch(() => {
			// 事件卡是检索增强，不阻塞摘要提交。
		});
	}
	if (deps.getLeafId() !== leafBefore) {
		deps.onActivity?.("压缩已丢弃（归档期间切换了分支）");
		return { kind: "stale" };
	}

	deps.appendSummaryEntry({
		summary,
		coversThroughId: plan.coversThroughId,
		turns: plan.turns,
		chars: plan.conversationText.length,
	});
	deps.onActivity?.(`前情已压缩：${plan.turns} 拍 ${plan.conversationText.length} 字 → 摘要 ${summary.length} 字`);
	return { kind: "compacted", summary, turns: plan.turns, chars: plan.conversationText.length };
}
