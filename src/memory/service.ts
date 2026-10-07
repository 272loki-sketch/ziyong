/**
 * 记忆服务门面：
 *  - 剧情库 narrative：仅 agent 合并入库
 *  - 额外库 external：导入 + 手动向量化（条目可删）
 * 读写一律带 MemoryScope（角色卡 + 会话）
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cosine, embedOne } from "./embed.ts";
import { memoryScopeId, loadMemoryConfig, patchMemoryConfig, publicMemoryConfig, saveMemoryConfig } from "./config.ts";
import type { EmbedContext } from "./embed.ts";
import { canonicalEventId } from "./event-id.ts";
import {
	clearStore,
	appendMemoryDiff,
	countChunks,
	deleteChunkById,
	deleteStoreFiles,
	evictByPriority,
	listChunks,
	listMemoryDiff,
	loadChunks,
	mergeNarrativeText,
	persistChunks,
	reembedStore,
	searchStore,
	splitEntryWithOffsets,
	splitTextChunks,
	upsertTexts,
	type MemoryStoreInput,
} from "./store.ts";
import type {
	MemoryChunk,
	MemoryChunkListItem,
	MemoryChunkMeta,
	MemoryConfig,
	MemoryDiffRecord,
	MemoryScope,
	MemorySearchHit,
	MemorySourceRef,
	MemoryStoreConfig,
	MemoryStoreStats,
	RpEventDigest,
	RpEventLink,
} from "./types.ts";
import { DEFAULT_MEMORY_CONFIG } from "./types.ts";

function upstreamDatabaseOwnsAutomaticMemory(cwd: string): boolean {
	try { return JSON.parse(readFileSync(join(cwd, ".liyuan-database-plugin", "config.json"), "utf8")).enabled === true; } catch { return false; }
}

function embedCtxFrom(cfg: MemoryConfig): EmbedContext {
	return { mode: cfg.embedMode, cloud: cfg.cloudEmbed };
}

function normalizeScope(scope: MemoryScope | undefined): MemoryScope {
	return {
		sessionId: (scope?.sessionId || "_default").trim() || "_default",
		card: scope?.card?.trim() || undefined,
	};
}

function assertExtraStore(storeId: string): void {
	if (storeId === "narrative") {
		throw new Error("剧情数据库仅由 agent 自动合并写入，不能手动导入/添加");
	}
}

/**
 * 写路径 keyed mutex：同一 scope+store 的所有读-改-写事务必须串行。
 * 即使 SQLite 单写者天然原子，服务层的读→await embedding→写仍可能互相交错，
 * 锁保证「读到的状态 + 本次修改」整体可见，删除/清空也必须等在途写入完成。
 * 此锁仅协调同一进程；多个进程共享同一 SQLite 文件仍需额外的 DB revision 门禁。
 */
const writeLocks = new Map<string, Promise<void>>();

function lockKey(cwd: string, scopeId: string, storeId: string): string {
	return `${cwd}|${scopeId}|${storeId}`;
}

function withScopeStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = writeLocks.get(key) ?? Promise.resolve();
	const run = prev.then(() => fn());
	writeLocks.set(key, run.then(() => undefined, () => undefined));
	return run;
}

const EVENT_SEMANTIC_DEDUPE_THRESHOLD_LOCAL = 0.75;
const EVENT_SEMANTIC_DEDUPE_THRESHOLD_CLOUD = 0.92;

function uniqStrings(values: Array<string | undefined>, limit: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const text = value?.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out;
}

function importanceMax(a: RpEventDigest["importance"], b: RpEventDigest["importance"]): RpEventDigest["importance"] {
	const rank = { minor: 0, normal: 1, major: 2, core: 3 } as const;
	return rank[b] > rank[a] ? b : a;
}

function mergeSourceRefs(a: RpEventDigest["sourceRefs"], b: RpEventDigest["sourceRefs"]): RpEventDigest["sourceRefs"] {
	const out: RpEventDigest["sourceRefs"] = [];
	const seen = new Set<string>();
	for (const ref of [...a, ...b]) {
		const key = `${ref.entryId}|${ref.charFrom ?? ""}|${ref.charTo ?? ""}`;
		if (!ref.entryId || seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	// Long-running events need their newest evidence. Keeping the oldest refs made
	// an updated event summary point back to stale dialogue after enough merges.
	return out.slice(-24);
}

function mergeLinks(a: RpEventLink[] | undefined, b: RpEventLink[] | undefined): RpEventLink[] | undefined {
	const out: RpEventLink[] = [];
	const seen = new Set<string>();
	for (const link of [...(a ?? []), ...(b ?? [])]) {
		const to = link?.to?.trim();
		if (!to || !["caused_by", "evolved_from", "resolved_the", "contradicts"].includes(link.type)) continue;
		const key = `${to}|${link.type}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ to, type: link.type, ...(link.note?.trim() ? { note: link.note.trim().slice(0, 240) } : {}) });
		if (out.length >= 24) break;
	}
	return out.length ? out : undefined;
}

function mergeEventDigest(previous: RpEventDigest, next: RpEventDigest): RpEventDigest {
	const from = Math.min(previous.turnRange?.from ?? Number.MAX_SAFE_INTEGER, next.turnRange?.from ?? Number.MAX_SAFE_INTEGER);
	const to = Math.max(previous.turnRange?.to ?? 0, next.turnRange?.to ?? 0);
	return {
		...previous,
		id: previous.id,
		sourceKey: previous.sourceKey ?? next.sourceKey,
		status: next.status ?? previous.status,
		importance: importanceMax(previous.importance, next.importance),
		title: previous.title || next.title,
		...(from !== Number.MAX_SAFE_INTEGER && to > 0 ? { turnRange: { from, to } } : {}),
		sourceRefs: mergeSourceRefs(previous.sourceRefs, next.sourceRefs),
		participants: uniqStrings([...(previous.participants ?? []), ...(next.participants ?? [])], 10),
		time: next.time?.trim() || previous.time,
		location: next.location?.trim() || previous.location,
		tags: uniqStrings([...previous.tags, ...next.tags], 12),
		recallAnchors: uniqStrings([...previous.recallAnchors, ...next.recallAnchors], 8),
		summary: next.summary?.trim() || previous.summary,
		evidenceLevel: previous.evidenceLevel === "source-backed" || next.evidenceLevel === "source-backed" ? "source-backed" : "summary-only",
		branchLeafId: next.branchLeafId ?? previous.branchLeafId,
		arc: next.arc?.trim() || previous.arc,
		links: mergeLinks(previous.links, next.links),
	};
}

function parseEventChunk(chunk: MemoryChunk): RpEventDigest | null {
	if (chunk.meta?.kind !== "event") return null;
	try {
		const event = JSON.parse(chunk.text) as RpEventDigest;
		return event?.kind === "rp-event-digest" && typeof event.id === "string" ? event : null;
	} catch {
		return null;
	}
}

function eventEmbeddingText(event: RpEventDigest): string {
	return [
		event.title,
		event.arc,
		event.summary,
		...(event.participants ?? []),
		...(event.tags ?? []),
		...(event.recallAnchors ?? []),
	].filter(Boolean).join("\n");
}

function eventMeta(event: RpEventDigest, scope: MemoryScope, mode: MemoryConfig["embedMode"], model: string, now: string): MemoryChunkMeta {
	return {
		source: "event",
		kind: "event",
		importance: event.importance,
		eventId: event.id,
		title: event.title,
		recallAnchors: event.recallAnchors,
		evidenceLevel: event.evidenceLevel,
		sourceRefs: event.sourceRefs,
		branchLeafId: event.branchLeafId,
		// 缺少弧线不能让事件从 sweep 召回中消失；未分类事件仍应可被线索召回.
		arc: event.arc?.trim() || "未归类剧情线",
		sessionId: scope.sessionId,
		card: scope.card,
		embedMode: mode,
		embedModel: model,
		updatedAt: now,
	};
}

export function getMemoryStatus(
	cwd: string,
	scope?: MemoryScope,
): {
	config: ReturnType<typeof publicMemoryConfig>;
	stores: MemoryStoreStats[];
	/** 当前作用域（设置面板展示：本对话的库） */
	scope: { sessionId: string; card?: string; scopeId: string };
} {
	const sc = normalizeScope(scope);
	const config = loadMemoryConfig(cwd);
	const stores: MemoryStoreStats[] = config.stores.map((s) => ({
		id: s.id,
		name: s.name,
		kind: s.kind,
		enabled: s.enabled,
		everyNTurns: s.everyNTurns,
		chunkCount: countChunks(cwd, sc, s.id),
		maxChunks: s.maxChunks,
	}));
	return {
		config: publicMemoryConfig(config),
		stores,
		scope: {
			sessionId: sc.sessionId,
			card: sc.card,
			scopeId: memoryScopeId(sc),
		},
	};
}

export function updateMemoryConfig(cwd: string, patch: Partial<MemoryConfig>): MemoryConfig {
	// apiKey 若前端回传掩码则不覆盖
	if (patch.cloudEmbed?.apiKey === "••••••••" || patch.cloudEmbed?.apiKey === "********") {
		const cur = loadMemoryConfig(cwd);
		patch = {
			...patch,
			cloudEmbed: { ...patch.cloudEmbed, apiKey: cur.cloudEmbed.apiKey },
		};
	}
	return patchMemoryConfig(cwd, patch);
}

export function updateStoreConfig(
	cwd: string,
	storeId: string,
	patch: Partial<MemoryStoreConfig>,
): MemoryConfig {
	const cfg = loadMemoryConfig(cwd);
	const stores = cfg.stores.map((s) => (s.id === storeId ? { ...s, ...patch, id: s.id } : s));
	return saveMemoryConfig(cwd, { ...cfg, stores });
}

/** 读取用（管理 UI）：只返回当前祖先链可见的条目。 */
export function memoryVisibleChunks(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	visibleEntryIds?: ReadonlySet<string>,
): MemoryChunk[] {
	return loadChunks(cwd, normalizeScope(scope), storeId).filter((c) => memoryHitVisibleOnBranch({ id: c.id, text: c.text, score: 1, meta: c.meta, createdAt: c.createdAt }, visibleEntryIds));
}

export async function memorySearch(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	query: string,
	topK?: number,
	visibleEntryIds?: ReadonlySet<string>,
): Promise<MemorySearchHit[]> {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled) return [];
	const store = cfg.stores.find((s) => s.id === storeId);
	if (!store?.enabled) return [];
	const sc = normalizeScope(scope);
	const hits = await searchStore(cwd, sc, storeId, query, topK ?? cfg.searchTopK, embedCtxFrom(cfg));
	return hits.filter((h) => memoryHitVisibleOnBranch(h, visibleEntryIds));
}

/** 列出条目（无 embedding），供管理 UI */
export function memoryListChunks(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
): MemoryChunkListItem[] {
	const cfg = loadMemoryConfig(cwd);
	const store = cfg.stores.find((s) => s.id === storeId);
	if (!store) throw new Error(`库不存在：${storeId}`);
	return listChunks(cwd, normalizeScope(scope), storeId);
}

/** 删除单条；Promise 成功结算时删除已生效，不能 fire-and-forget。 */
export async function memoryDeleteChunk(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	chunkId: string,
): Promise<boolean> {
	const sc = normalizeScope(scope);
	return withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), storeId), async () => {
		const cfg = loadMemoryConfig(cwd);
		const store = cfg.stores.find((s) => s.id === storeId);
		if (!store) throw new Error(`库不存在：${storeId}`);
		return deleteChunkById(cwd, sc, storeId, chunkId);
	});
}

/**
 * 额外库：手动向量化一条（不切碎长文以外的特殊逻辑；过长按块切，每块一条）。
 * 禁止写入剧情库。
 */
export async function memoryManualAdd(
	cwd: string,
	scope: MemoryScope,
	text: string,
	opts?: { title?: string; storeId?: string },
): Promise<{ added: number; total: number; chunks: number }> {
	const storeId = (opts?.storeId || "external").trim() || "external";
	assertExtraStore(storeId);
	const sc = normalizeScope(scope);
	const raw = text.trim();
	if (raw.length < 8) throw new Error("内容太短（至少约 8 字）");
	// 短文整条；长文切块，每块一个条目
	const parts = raw.length <= 800 ? [raw.slice(0, 4000)] : splitTextChunks(raw, 600);
	return withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), storeId), async () => {
		// 排队期间可能删库/停用；配置只能在取得写锁后读取，不能用旧配置重建已删库。
		const cfg = loadMemoryConfig(cwd);
		if (!cfg.enabled) throw new Error("请先启用向量记忆");
		const store = cfg.stores.find((s) => s.id === storeId);
		if (!store?.enabled) throw new Error(`库未启用：${store?.name || storeId}`);
		const r = await upsertTexts(
			cwd, sc, storeId, parts,
			{ source: "manual", title: opts?.title?.trim() || undefined },
			store.maxChunks, embedCtxFrom(cfg),
		);
		return { ...r, chunks: parts.length };
	});
}

export async function memoryImportText(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	text: string,
	fileName?: string,
): Promise<{ added: number; total: number; chunks: number }> {
	assertExtraStore(storeId);
	const sc = normalizeScope(scope);
	const parts = splitTextChunks(text, 600);
	return withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), storeId), async () => {
		const cfg = loadMemoryConfig(cwd);
		if (!cfg.enabled) return { added: 0, total: 0, chunks: 0 };
		const store = cfg.stores.find((s) => s.id === storeId);
		if (!store?.enabled) return { added: 0, total: 0, chunks: 0 };
		const r = await upsertTexts(
			cwd, sc, storeId, parts,
			{ source: "import", fileName, title: fileName },
			store.maxChunks, embedCtxFrom(cfg),
		);
		return { ...r, chunks: parts.length };
	});
}

/** 清空当前作用域；等待在途写入后执行，成功返回时旧快照不能再覆盖本次清空。 */
export async function memoryClearStore(cwd: string, scope: MemoryScope, storeId: string): Promise<void> {
	const sc = normalizeScope(scope);
	return withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), storeId), async () => {
		clearStore(cwd, sc, storeId);
	});
}

/** 删除自定义库配置 + 文件；内置 narrative/external 仅清空当前作用域。须等待返回。 */
export async function memoryRemoveStore(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
): Promise<MemoryConfig> {
	const sc = normalizeScope(scope);
	return withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), storeId), async () => {
		const cfg = loadMemoryConfig(cwd);
		const store = cfg.stores.find((s) => s.id === storeId);
		if (!store) return cfg;
		if (store.kind === "narrative" || store.kind === "external") {
			clearStore(cwd, sc, storeId);
			return cfg;
		}
		deleteStoreFiles(cwd, sc, storeId);
		// 删除数据和配置之间没有 await；后续排队导入在锁内重读配置，不会重建此库。
		return saveMemoryConfig(cwd, {
			...cfg,
			stores: cfg.stores.filter((s) => s.id !== storeId),
		});
	});
}

/**
 * 一级事件卡入剧情库（PLAN-RP-MEMORY §2.1）。
 * 事件卡是检索投影 + 原文锚定：kind=event，按 importance 分级保活（core/major 不淘汰）。
 * 每个事件一条块；同 id 重复写入时更新（不再追加）。
 */
export async function memoryUpsertEventDigest(
	cwd: string,
	scope: MemoryScope,
	event: RpEventDigest,
	opts?: { mergeInto?: string; reason?: string },
): Promise<{ stored: boolean; op?: "create" | "merge" | "update"; eventId?: string; reason?: string; error?: string }> {
	if (upstreamDatabaseOwnsAutomaticMemory(cwd)) return { stored: false, error: "upstream database plugin owns automatic memory" };
	const sc = normalizeScope(scope);
	const key = lockKey(cwd, memoryScopeId(sc), "narrative");
	return withScopeStoreLock(key, async () => {
		const cfg = loadMemoryConfig(cwd);
		if (!cfg.enabled) return { stored: false, error: "memory disabled" };
		const storeCfg = cfg.stores.find((s) => s.id === "narrative" && s.enabled);
		if (!storeCfg) return { stored: false, error: "narrative store disabled" };

		const chunks = loadChunks(cwd, sc, "narrative");
		const eventRows = chunks.map((chunk) => ({ chunk, event: parseEventChunk(chunk) })).filter((row): row is { chunk: MemoryChunk; event: RpEventDigest } => !!row.event);
		const requestedTarget = opts?.mergeInto?.trim();
		const canonicalId = canonicalEventId(sc, event);
		let target = requestedTarget
			? eventRows.find((row) => row.event.id === requestedTarget)
			: eventRows.find((row) => row.event.id === canonicalId);

		// 显式 merge 也必须通过分支兼容：与目标至少共享一个来源条目，
		// 避免模型拿兄弟分支的事件 id 直接把本分支事件并进去。
		if (requestedTarget && target) {
			const overlap = event.sourceRefs.some((ref) => target!.event.sourceRefs.some((old) => old.entryId === ref.entryId));
			if (!overlap && event.sourceRefs.length > 0 && target!.event.sourceRefs.length > 0) {
				return { stored: false, error: "merge target not reachable from this branch" };
			}
		}

		const now = new Date().toISOString();
		const mode = cfg.embedMode;
		const model = mode === "cloud" ? cfg.cloudEmbed.model : "local-hash-v1";
		const incoming = {
			...event,
			id: target?.event.id ?? canonicalId,
			arc: event.arc?.trim() || target?.event.arc?.trim() || "未归类剧情线",
		};
		const incomingEmbedding = await embedOne(eventEmbeddingText(incoming), embedCtxFrom(cfg));

		if (!target) {
			const dedupeThreshold = mode === "cloud" ? EVENT_SEMANTIC_DEDUPE_THRESHOLD_CLOUD : EVENT_SEMANTIC_DEDUPE_THRESHOLD_LOCAL;
			let bestScore = -1;
			for (const row of eventRows) {
				if (row.chunk.meta?.embedMode !== mode || row.chunk.meta?.embedModel !== model || row.chunk.embedding.length !== incomingEmbedding.length) continue;
				if (incoming.branchLeafId && row.event.branchLeafId && incoming.branchLeafId !== row.event.branchLeafId) {
					const overlap = incoming.sourceRefs.some((ref) => row.event.sourceRefs.some((old) => old.entryId === ref.entryId));
					if (!overlap) continue;
				}
				const score = cosine(incomingEmbedding, row.chunk.embedding);
				if (score > bestScore) { bestScore = score; target = row; }
			}
			if (bestScore < dedupeThreshold) target = undefined;
		}

		if (target) {
			const merged = mergeEventDigest(target.event, { ...incoming, id: target.event.id });
			const embedding = await embedOne(eventEmbeddingText(merged), embedCtxFrom(cfg));
			const meta = eventMeta(merged, sc, mode, model, now);
			persistChunks(cwd, sc, "narrative", chunks.map((chunk) => chunk.id === target!.chunk.id ? { ...chunk, text: JSON.stringify(merged), embedding, meta } : chunk));
			const exact = target.event.id === canonicalId && !requestedTarget;
			const op = exact ? "update" as const : "merge" as const;
			const reason = opts?.reason ?? (requestedTarget ? "llm-merge" : exact ? "canonical-id" : "cosine-duplicate");
			appendMemoryDiff(cwd, sc, { ts: now, op, eventId: merged.id, title: merged.title, ...(merged.arc ? { arc: merged.arc } : {}), reason });
			return { stored: true, op, eventId: merged.id, reason };
		}

		const { op: _operation, ...eventWithoutOperation } = incoming;
		const canonical = { ...eventWithoutOperation, id: canonicalId };
		const meta = eventMeta(canonical, sc, mode, model, now);
		nextChunksSafe(cwd, sc, "narrative", storeCfg.maxChunks, [...chunks, { id: randomBytes(8).toString("hex"), text: JSON.stringify(canonical), embedding: incomingEmbedding, meta, createdAt: now }]);
		appendMemoryDiff(cwd, sc, { ts: now, op: "create", eventId: canonical.id, title: canonical.title, ...(canonical.arc ? { arc: canonical.arc } : {}), reason: opts?.reason ?? "new" });
		return { stored: true, op: "create", eventId: canonical.id, reason: opts?.reason ?? "new" };
	});
}

export function memoryListDiff(cwd: string, scope: MemoryScope, limit = 50): MemoryDiffRecord[] {
	return listMemoryDiff(cwd, normalizeScope(scope), limit);
}

/** 列出当前作用域的事件卡（不含向量），供管理/导演室/旁路。 */
export function memoryListEventDigests(cwd: string, scope: MemoryScope, visibleEntryIds?: ReadonlySet<string>): RpEventDigest[] {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled) return [];
	const sc = normalizeScope(scope);
	const chunks = loadChunks(cwd, sc, "narrative");
	const out: RpEventDigest[] = [];
	for (const c of chunks) {
		if (c.meta?.kind !== "event") continue;
		if (!memoryHitVisibleOnBranch({ id: c.id, text: c.text, score: 1, meta: c.meta, createdAt: c.createdAt }, visibleEntryIds)) continue;
		try {
			const e = JSON.parse(c.text) as RpEventDigest;
			if (e && e.kind === "rp-event-digest" && typeof e.id === "string") out.push(e);
		} catch {
			// 丢弃损坏事件卡
		}
	}
	return out;
}

/** 事件卡写入时也走分级保活（core/major 永不淘汰）。 */
function nextChunksSafe(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	maxChunks: number,
	chunks: MemoryChunk[],
): void {
	let next = chunks;
	if (next.length > maxChunks) next = evictByPriority(next, maxChunks);
	persistChunks(cwd, scope, storeId, next);
}

/**
 * 叙事轮结束：按 everyNTurns **合并**写入剧情库（仅 agent 路径）。
 * 计数器更新与合并写入共享同一全局配置锁：并发调用互不覆盖 turnCounters。
 */
export async function onNarrativeTurnEnd(
	cwd: string,
	scope: MemoryScope,
	assistantText: string,
	opts?: {
		entries?: Array<{ entryId: string; entryType?: MemorySourceRef["entryType"]; turn?: number; text: string; textBasis?: MemorySourceRef["textBasis"] }>;
		branchLeafId?: string;
	},
): Promise<{
	stored: boolean;
	merged?: boolean;
	counter: number;
	added?: number;
	error?: string;
	noop?: boolean;
}> {
	if (upstreamDatabaseOwnsAutomaticMemory(cwd)) return { stored: false, counter: 0, noop: true };
	const cfg0 = loadMemoryConfig(cwd);
	if (!cfg0.enabled) return { stored: false, counter: 0 };
	const store0 = cfg0.stores.find((s) => s.id === "narrative" && s.enabled);
	if (!store0 || store0.everyNTurns <= 0) return { stored: false, counter: 0 };

	const sc = normalizeScope(scope);
	// Counter updates are global config work; narrative writes use the same keyed
	// lock as event/evidence writes so an async embedding cannot overwrite them.
	return withScopeStoreLock(lockKey(cwd, "config", "turnCounter"), async () => {
		const cfg = loadMemoryConfig(cwd);
		const store = cfg.stores.find((s) => s.id === "narrative" && s.enabled);
		if (!cfg.enabled || !store || store.everyNTurns <= 0) return { stored: false, counter: 0 };
		const scopeKey = memoryScopeId(sc);
		const counters = { ...(cfg.turnCounters ?? {}) };
		const next = (counters[scopeKey] ?? 0) + 1;
		counters[scopeKey] = next;
		saveMemoryConfig(cwd, { ...cfg, turnCounters: counters });

		if (next % store.everyNTurns !== 0) {
			return { stored: false, counter: next };
		}
		const entries = opts?.entries?.filter((entry) => entry.entryId && entry.text.trim().length >= 20) ?? [];
		const text = assistantText.trim();
		if (!entries.length && text.length < 20) return { stored: false, counter: next };

		try {
			return await withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), "narrative"), async () => {
				if (entries.length) {
					const parts: MemoryStoreInput[] = [];
					for (const entry of entries) {
						for (const part of splitEntryWithOffsets(entry.text, 600)) {
							parts.push({
								text: part.text,
								meta: {
									source: "narrative",
									kind: "digest",
									evidenceLevel: "summary-only",
									sourceRefs: [{ entryId: entry.entryId, entryType: entry.entryType, turn: entry.turn, charFrom: part.charFrom, charTo: part.charTo, ...(entry.textBasis ? { textBasis: entry.textBasis } : {}) }],
									branchLeafId: opts?.branchLeafId,
								},
							});
						}
					}
					const r = await upsertTexts(cwd, sc, "narrative", parts, { source: "narrative", kind: "digest", evidenceLevel: "summary-only", branchLeafId: opts?.branchLeafId, sessionId: sc.sessionId, card: sc.card }, store.maxChunks, embedCtxFrom(cfg));
					return { stored: r.added > 0, merged: false, counter: next, added: r.added, noop: r.added === 0 };
				}
				const r = await mergeNarrativeText(
					cwd, sc, text,
					{ source: "narrative", kind: "digest", evidenceLevel: "summary-only", branchLeafId: opts?.branchLeafId, sessionId: sc.sessionId, card: sc.card },
					store.maxChunks, embedCtxFrom(cfg),
				);
				if (r.noop) return { stored: false, counter: next, noop: true, merged: r.merged };
				return { stored: true, merged: r.merged, counter: next, added: r.added };
			});
		} catch (e) {
			return { stored: false, counter: next, error: e instanceof Error ? e.message : String(e) };
		}
	});
}

/** 重试最近一轮剧情入库：不递增轮次计数，专供自动入库失败后的人工重试。 */
export async function retryNarrativeMemory(
	cwd: string,
	scope: MemoryScope,
	assistantText: string,
): Promise<{ stored: boolean; merged?: boolean; added?: number; noop?: boolean }> {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled) throw new Error("向量记忆未启用");
	const store = cfg.stores.find((s) => s.id === "narrative" && s.enabled);
	if (!store) throw new Error("剧情数据库未启用");
	const sc = normalizeScope(scope);
	return withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), "narrative"), async () => {
		const text = assistantText.trim();
		if (text.length < 20) throw new Error("最近一轮正文为空或过短");
		const r = await mergeNarrativeText(
			cwd,
			sc,
			text,
			{ source: "narrative", kind: "digest", evidenceLevel: "summary-only", sessionId: sc.sessionId, card: sc.card },
			store.maxChunks,
			embedCtxFrom(cfg),
		);
		return { stored: !r.noop, merged: r.merged, added: r.added, noop: r.noop };
	});
}

export function defaultMemoryConfig(): MemoryConfig {
	return structuredClone(DEFAULT_MEMORY_CONFIG);
}

/**
 * 压缩归档：被上下文压缩裁掉的早期正文**完整**入剧情库（source=archive）。
 * 与 onNarrativeTurnEnd 的滚动摘要互补——接力摘要管剧情连续性，归档管细节召回：
 * 正文被压掉后，具体对白/细节仍可被 memoryRecallForTurn 按相关性捞回。
 * 由压缩接线层 fire-and-forget 调用；失败只丢召回能力，不影响压缩本身。
 *
 * PLAN-RP-MEMORY：archive 块标注 kind=evidence；可按 entryRefs 携带原文锚点，
 * 供两阶段召回沿 sourceRefs 定位。
 */
/**
 * 压缩归档：被上下文压缩裁掉的早期正文**完整**入剧情库（source=archive）。
 * 与 onNarrativeTurnEnd 的滚动摘要互补——接力摘要管剧情连续性，归档管细节召回。
 *
 * PLAN-RP-MEMORY：archive 块标注 kind=evidence；分两种锚定：
 *  - 旧路径（sourceRefs 平铺）：整段切块，每块带同一整套 sourceRefs（粗粒度）；
 *  - perEntry 路径（推荐）：按 entry 切块并带 (entryId, charFrom, charTo) 精确锚点，
 *    事件→证据两阶段召回返回的原文块能真正对上事件所在段落。
 */
export async function memoryArchiveCompacted(
	cwd: string,
	scope: MemoryScope,
	text: string,
	opts?: { sourceRefs?: MemorySourceRef[] | null; perEntry?: Array<{ entryId: string; entryType?: string; turn?: number; text: string; textBasis?: MemorySourceRef["textBasis"] }> },
): Promise<{ archived: boolean; added?: number; chunks?: number; reason?: string }> {
	if (upstreamDatabaseOwnsAutomaticMemory(cwd)) return { archived: false, reason: "upstream database plugin owns automatic memory" };
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled) return { archived: false, reason: "memory disabled" };
	const store = cfg.stores.find((s) => s.id === "narrative" && s.enabled);
	if (!store) return { archived: false, reason: "narrative store disabled" };
	const sc = normalizeScope(scope);
	const key = lockKey(cwd, memoryScopeId(sc), "narrative");
	return withScopeStoreLock(key, async () => {
		const parts: MemoryStoreInput[] = [];
		if (opts?.perEntry?.length) {
			for (const entry of opts.perEntry) {
				if ((entry.text || "").trim().length < 20) continue;
				for (const part of splitEntryWithOffsets(entry.text, 600)) {
					parts.push({
						text: part.text,
						meta: {
							source: "archive",
							kind: "evidence",
							title: "早期剧情归档",
							sourceRefs: [{ entryId: entry.entryId, entryType: entry.entryType as MemorySourceRef["entryType"], ...(entry.turn ? { turn: entry.turn } : {}), charFrom: part.charFrom, charTo: part.charTo, ...(entry.textBasis ? { textBasis: entry.textBasis } : {}) }],
							sessionId: sc.sessionId,
							card: sc.card,
						},
					});
				}
			}
		} else {
			const raw = text.trim();
			if (raw.length < 20) return { archived: false, reason: "text too short" };
			for (const chunk of splitTextChunks(raw, 600)) {
				parts.push({
					text: chunk,
					meta: {
						source: "archive",
						kind: "evidence",
						title: "早期剧情归档",
						...(opts?.sourceRefs?.length ? { sourceRefs: opts.sourceRefs } : {}),
						sessionId: sc.sessionId,
						card: sc.card,
					},
				});
			}
		}
		if (!parts.length) return { archived: false, reason: "no archiveable text" };
		const r = await upsertTexts(cwd, sc, "narrative", parts, { source: "archive", kind: "evidence", title: "早期剧情归档", sessionId: sc.sessionId, card: sc.card }, store.maxChunks, embedCtxFrom(cfg));
		return { archived: r.added > 0, added: r.added, chunks: parts.length };
	});
}

/**
 * 剧情回合检索：仅搜**当前卡+当前对话**已启用库，供 buildTurnInjection 注入。
 */
export async function memoryRecallForTurn(
	cwd: string,
	scope: MemoryScope,
	query: string,
	visibleEntryIds?: ReadonlySet<string>,
): Promise<MemorySearchHit[]> {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled || !cfg.injectOnTurn) return [];
	const q = query.trim();
	if (q.length < 2) return [];
	const sc = normalizeScope(scope);
	const ctx = embedCtxFrom(cfg);
	const merged: MemorySearchHit[] = [];
	const normalizedQuery = q.normalize("NFKC").toLowerCase();
	for (const chunk of loadChunks(cwd, sc, "narrative")) {
		const event = parseEventChunk(chunk);
		if (!event) continue;
		const hit = { id: chunk.id, text: chunk.text, score: 2, meta: chunk.meta, createdAt: chunk.createdAt } satisfies MemorySearchHit;
		if (!memoryHitVisibleOnBranch(hit, visibleEntryIds)) continue;
		const anchors = [...(event.recallAnchors ?? []), ...(event.tags ?? [])]
			.map((item) => item.normalize("NFKC").toLowerCase().trim())
			.filter((item) => item.length >= 2);
		if (anchors.some((anchor) => normalizedQuery.includes(anchor) || (normalizedQuery.length >= 2 && anchor.includes(normalizedQuery)))) merged.push(hit);
	}
	for (const s of cfg.stores) {
		if (!s.enabled) continue;
		try {
			const hits = await searchStore(cwd, sc, s.id, q, cfg.searchTopK, ctx);
			for (const h of hits) {
				if (!memoryHitVisibleOnBranch(h, visibleEntryIds)) continue;
				merged.push({
					...h,
					meta: { ...h.meta, title: h.meta.title || s.name },
				});
			}
		} catch (e) {
			console.warn("[memory] search store failed", s.id, e);
		}
	}
	merged.sort((a, b) => b.score - a.score);
	const out: MemorySearchHit[] = [];
	for (const h of merged) {
		if (out.some((x) => (h.meta?.eventId && x.meta?.eventId === h.meta.eventId) || x.text.slice(0, 80) === h.text.slice(0, 80))) continue;
		out.push(h);
		if (out.length >= cfg.searchTopK) break;
	}
	return out;
}

export interface MemoryArcRecallBlock {
	arc: string;
	text: string;
	events: number;
}

function eventTurn(event: RpEventDigest): number | undefined {
	return event.turnRange?.from ?? event.sourceRefs.map((ref) => ref.turn).find((turn): turn is number => typeof turn === "number");
}

/** 扫荡型召回：按剧情弧线聚合当前分支可见事件卡，仅返回 L1 骨架，不加载原文。 */
export function memoryArcRecallForTurn(
	cwd: string,
	scope: MemoryScope,
	visibleEntryIds?: ReadonlySet<string>,
	opts?: { maxArcs?: number; maxEventsPerArc?: number; maxChars?: number },
): MemoryArcRecallBlock[] {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled || !cfg.injectOnTurn) return [];
	const sc = normalizeScope(scope);
	const groups = new Map<string, RpEventDigest[]>();
	for (const chunk of loadChunks(cwd, sc, "narrative")) {
		const event = parseEventChunk(chunk);
		if (!event?.arc?.trim()) continue;
		const hit = { id: chunk.id, text: chunk.text, score: 1, meta: chunk.meta, createdAt: chunk.createdAt } satisfies MemorySearchHit;
		if (!memoryHitVisibleOnBranch(hit, visibleEntryIds)) continue;
		const arc = event.arc.trim();
		const list = groups.get(arc) ?? [];
		list.push(event);
		groups.set(arc, list);
	}
	const maxArcs = Math.max(1, Math.min(10, opts?.maxArcs ?? 5));
	const maxEvents = Math.max(1, Math.min(30, opts?.maxEventsPerArc ?? 12));
	const maxChars = Math.max(200, Math.min(4000, opts?.maxChars ?? 1200));
	const ranked = [...groups.entries()].map(([arc, events]) => ({
		arc,
		events: [...events].sort((a, b) => (eventTurn(a) ?? 0) - (eventTurn(b) ?? 0)),
		latest: Math.max(...events.map((event) => event.turnRange?.to ?? eventTurn(event) ?? 0)),
	})).sort((a, b) => b.latest - a.latest).slice(0, maxArcs);
	const out: MemoryArcRecallBlock[] = [];
	let used = 0;
	for (const group of ranked) {
		const shown = group.events.slice(0, maxEvents);
		const turns = group.events.map((event) => eventTurn(event)).filter((turn): turn is number => typeof turn === "number");
		const range = turns.length ? `拍${Math.min(...turns)}–${Math.max(...turns)}` : "拍序未定";
		const resolved = group.events.every((event) => event.status === "resolved" || event.status === "retired");
		const lines = shown.map((event) => {
			const turn = eventTurn(event);
			const summary = event.summary.length > 64 ? `${event.summary.slice(0, 64)}…` : event.summary;
			return `  · ${turn ? `拍${turn} ` : ""}${event.title} — ${summary}`;
		});
		if (group.events.length > shown.length) lines.push(`  · 另有 ${group.events.length - shown.length} 条较早/较细事件未展开`);
		let text = `◆ ${group.arc}（${range} · ${resolved ? "已化解" : "进行中"}）\n${lines.join("\n")}`;
		if (used + text.length > maxChars) {
			const remain = maxChars - used;
			if (remain < 100) break;
			text = `${text.slice(0, remain - 1)}…`;
		}
		out.push({ arc: group.arc, text, events: group.events.length });
		used += text.length;
		if (used >= maxChars) break;
	}
	return out;
}

/**
 * 分支可见性（PLAN-RP-MEMORY §6）：源锚定内容只有**全部 sourceRefs 都落在
 * 当前祖先链**上才可见；无 refs 的非源锚定内容（manual/import）与会话作用域同宽，
 * source-backed 但缺 refs 的内容默认不可见（防跨分支污染）。
 */
function memoryHitVisibleOnBranch(hit: MemorySearchHit, visibleEntryIds?: ReadonlySet<string>): boolean {
	if (!visibleEntryIds) return true;
	const refs = hit.meta?.sourceRefs ?? [];
	if (refs.length === 0) return hit.meta?.evidenceLevel !== "source-backed";
	return refs.every((ref) => visibleEntryIds.has(ref.entryId));
}

/** 探测云端 embedding 是否可用 */
export async function probeCloudEmbed(cwd: string): Promise<{ ok: boolean; dim?: number; error?: string }> {
	const cfg = loadMemoryConfig(cwd);
	try {
		const { embedTextsCloud } = await import("./embed.ts");
		const vecs = await embedTextsCloud(["梨园记忆探测"], cfg.cloudEmbed);
		return { ok: true, dim: vecs[0]?.length };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * PLAN-RP-MEMORY 第二阶段：事件卡 → 原文证据。
 * 给定事件 id，先取事件卡（含 title/tags/recallAnchors/summary），再用其措辞检索
 * narrative 库中 kind=evidence 的原文块。返回 evidence 块（MemorySearchHit）。
 */
export async function memoryEvidenceForEvent(
	cwd: string,
	scope: MemoryScope,
	eventId: string,
	topK = 2,
	visibleEntryIds?: ReadonlySet<string>,
): Promise<MemorySearchHit[]> {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled || !cfg.injectOnTurn) return [];
	const sc = normalizeScope(scope);
	const chunks = loadChunks(cwd, sc, "narrative");
	const card = chunks.find((c) => c.meta?.kind === "event" && c.meta?.eventId === eventId && memoryHitVisibleOnBranch({ id: c.id, text: c.text, score: 1, meta: c.meta, createdAt: c.createdAt }, visibleEntryIds));
	if (!card) return [];
	const cardRefs = card.meta?.sourceRefs ?? [];
	if (cardRefs.length > 0) {
		const refIds = new Set(cardRefs.map((ref) => ref.entryId));
		// 先取与事件**同一 entry 且字符区间重叠**的精确证据；旧数据缺区间时退到同 entry。
		const candidates = chunks
			.filter((chunk) => (chunk.meta?.kind === "evidence" || chunk.meta?.source === "archive") && (chunk.meta?.sourceRefs ?? []).some((ref) => refIds.has(ref.entryId)))
			.filter((chunk) => memoryHitVisibleOnBranch({ id: chunk.id, text: chunk.text, score: 1, meta: chunk.meta, createdAt: chunk.createdAt }, visibleEntryIds));
		const scoreChunk = (chunk: MemoryChunk) => {
			let best = -1;
			for (const ref of chunk.meta?.sourceRefs ?? []) {
				if (!refIds.has(ref.entryId)) continue;
				let overlap = 0;
				for (const cardRef of cardRefs.filter((r) => r.entryId === ref.entryId)) {
					if (typeof ref.charFrom === "number" && typeof cardRef.charFrom === "number" && typeof ref.charTo === "number" && typeof cardRef.charTo === "number") {
						overlap = Math.max(overlap, Math.max(0, Math.min(ref.charTo, cardRef.charTo) - Math.max(ref.charFrom, cardRef.charFrom)));
					}
				}
				const entryMatch = overlap > 0 ? 2 : 1;
				if (entryMatch > best) best = entryMatch;
			}
			return Math.max(best, 0);
		};
		const exact = candidates
			.map((chunk, index) => ({ chunk, rank: scoreChunk(chunk) }))
			.sort((a, b) => b.rank - a.rank || a.chunk.createdAt.localeCompare(b.chunk.createdAt))
			.slice(0, Math.max(1, topK))
			.map(({ chunk }, index) => ({ id: chunk.id, text: chunk.text, score: 1 - index * 0.001, meta: { ...chunk.meta, title: "早期剧情归档" }, createdAt: chunk.createdAt }));
		if (exact.length > 0) return exact;
	}
	let q = "";
	try {
		const e = JSON.parse(card.text) as RpEventDigest;
		q = [e.title, ...(e.tags ?? []), ...(e.recallAnchors ?? []), e.summary].filter(Boolean).join(" ");
	} catch {
		q = card.text.slice(0, 200);
	}
	if (q.trim().length < 2) return [];
	const hits = await searchStore(
		cwd,
		sc,
		"narrative",
		q,
		Math.max(1, topK),
		embedCtxFrom(cfg),
		(chunk) => (chunk.meta?.kind === "evidence" || chunk.meta?.source === "archive") && memoryHitVisibleOnBranch({ id: chunk.id, text: chunk.text, score: 1, meta: chunk.meta, createdAt: chunk.createdAt }, visibleEntryIds),
	);
	return hits.map((h) => ({ ...h, meta: { ...h.meta, title: "早期剧情归档" } }));
}

/** 当前作用域是否存在某事件卡（供旁路判断是否已登记） */
export function memoryHasEvent(cwd: string, scope: MemoryScope, eventId: string): boolean {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled) return false;
	const sc = normalizeScope(scope);
	return loadChunks(cwd, sc, "narrative").some((c) => c.meta?.kind === "event" && c.meta?.eventId === eventId);
}

export type MemoryReembedResult = {
	mode: "local" | "cloud";
	model: string;
	stores: Array<{ storeId: string; name: string; total: number; updated: number; skipped: number }>;
	totalUpdated: number;
	totalChunks: number;
};

/**
 * 用**当前** embed 模式，对本对话全部（或指定）库的已有正文重算向量。
 * 不删文本、不调聊天模型；云端只花 embedding 费用。
 */
export async function memoryReembedScope(
	cwd: string,
	scope: MemoryScope,
	opts?: { storeId?: string },
): Promise<MemoryReembedResult> {
	const cfg = loadMemoryConfig(cwd);
	if (!cfg.enabled) throw new Error("请先启用向量记忆");
	const sc = normalizeScope(scope);
	const ctx = embedCtxFrom(cfg);
	const model = ctx.mode === "cloud" ? ctx.cloud.model || "cloud" : "local-hash-v1";
	if (ctx.mode === "cloud") {
		const base = (ctx.cloud.baseUrl || "").trim();
		const key = (ctx.cloud.apiKey || "").trim();
		const m = (ctx.cloud.model || "").trim();
		if (!base || !key || !m) throw new Error("云端 embedding 未配置完整（Base URL / API Key / 模型）");
	}

	const targets = opts?.storeId
		? cfg.stores.filter((s) => s.id === opts.storeId)
		: cfg.stores;
	if (!targets.length) throw new Error(opts?.storeId ? `库不存在：${opts.storeId}` : "无可用库");

	const stores: MemoryReembedResult["stores"] = [];
	let totalUpdated = 0;
	let totalChunks = 0;
	for (const s of targets) {
		const r = await withScopeStoreLock(lockKey(cwd, memoryScopeId(sc), s.id), () => reembedStore(cwd, sc, s.id, ctx));
		stores.push({
			storeId: s.id,
			name: s.name,
			total: r.total,
			updated: r.updated,
			skipped: r.skipped,
		});
		totalUpdated += r.updated;
		totalChunks += r.total;
	}
	return { mode: ctx.mode, model, stores, totalUpdated, totalChunks };
}
