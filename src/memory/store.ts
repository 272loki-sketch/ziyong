/**
 * SQLite memory store.
 *
 * The public functions intentionally retain the old store.ts contract. This
 * keeps the stage/service layer focused on memory semantics while SQLite
 * provides transactions, indexes, and safe concurrent read-modify-write.
 * Legacy JSONL scopes are imported lazily on first access.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot, memoryScopeId, memoryScopeRoot } from "./config.ts";
import type {
	MemoryChunk,
	MemoryChunkListItem,
	MemoryDiffRecord,
	MemoryScope,
	MemorySearchHit,
	MemoryChunkMeta,
} from "./types.ts";
import { NARRATIVE_MERGE_MAX_CHARS } from "./types.ts";
import { cosine, type EmbedContext, embedMany, embedOne } from "./embed.ts";

type SqliteDatabase = Database.Database;

const dbCache = new Map<string, SqliteDatabase>();
const migratedScopes = new Set<string>();

function dbPath(cwd: string): string {
	return join(memoryRoot(cwd), "memory.sqlite");
}

function openDatabase(cwd: string): SqliteDatabase {
	const path = dbPath(cwd);
	const cached = dbCache.get(path);
	if (cached) return cached;
	const root = memoryRoot(cwd);
	if (!existsSync(root)) mkdirSync(root, { recursive: true });
	const db = new Database(path);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 5000");
	const existingTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_chunks'").get();
	if (existingTable) {
		const pk = db.prepare("PRAGMA table_info(memory_chunks)").all() as Array<{ name: string; pk: number }>;
		if (pk.find((column) => column.name === "id")?.pk === 1 && !pk.some((column) => column.name === "scope_id" && column.pk > 0)) {
			db.transaction(() => {
				db.exec(`
					ALTER TABLE memory_chunks RENAME TO memory_chunks_legacy_pk;
					CREATE TABLE memory_chunks (
						id TEXT NOT NULL, scope_id TEXT NOT NULL, store_id TEXT NOT NULL,
						text TEXT NOT NULL, embedding TEXT NOT NULL, meta TEXT NOT NULL, created_at TEXT NOT NULL,
						PRIMARY KEY (scope_id, store_id, id)
					);
					INSERT INTO memory_chunks SELECT id, scope_id, store_id, text, embedding, meta, created_at FROM memory_chunks_legacy_pk;
					DROP TABLE memory_chunks_legacy_pk;
				`);
			})();
		}
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_chunks (
			id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			store_id TEXT NOT NULL,
			text TEXT NOT NULL,
			embedding TEXT NOT NULL,
			meta TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (scope_id, store_id, id)
		);
		CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope_store
			ON memory_chunks(scope_id, store_id, created_at, id);
		CREATE INDEX IF NOT EXISTS idx_memory_chunks_event
			ON memory_chunks(scope_id, store_id, json_extract(meta, '$.kind'), json_extract(meta, '$.eventId'));
		CREATE TABLE IF NOT EXISTS memory_diff (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			scope_id TEXT NOT NULL,
			ts TEXT NOT NULL,
			op TEXT NOT NULL,
			event_id TEXT NOT NULL,
			title TEXT NOT NULL,
			arc TEXT,
			reason TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_memory_diff_scope_seq ON memory_diff(scope_id, seq);
	`);
	dbCache.set(path, db);
	return db;
}

function parseChunk(line: string): MemoryChunk | null {
	try {
		const c = JSON.parse(line) as MemoryChunk;
		return c?.id && c.text && Array.isArray(c.embedding) ? c : null;
	} catch {
		return null;
	}
}

function parseDiff(line: string): MemoryDiffRecord | null {
	try {
		const row = JSON.parse(line) as MemoryDiffRecord;
		return row?.ts && row?.eventId && row?.op ? row : null;
	} catch {
		return null;
	}
}

function rowToChunk(row: { id: string; text: string; embedding: string; meta: string; created_at: string }): MemoryChunk | null {
	try {
		const embedding = JSON.parse(row.embedding) as unknown;
		const meta = JSON.parse(row.meta) as MemoryChunkMeta;
		if (!Array.isArray(embedding)) return null;
		return { id: row.id, text: row.text, embedding: embedding as number[], meta, createdAt: row.created_at };
	} catch {
		return null;
	}
}

function migrateLegacyScope(cwd: string, scope: MemoryScope): void {
	const scopeId = memoryScopeId(scope);
	const key = `${dbPath(cwd)}|${scopeId}`;
	if (migratedScopes.has(key)) return;
	const db = openDatabase(cwd);
	const existing = db.prepare("SELECT 1 FROM memory_chunks WHERE scope_id = ? LIMIT 1").get(scopeId);
	const legacyRoot = memoryScopeRoot(cwd, scope);
	const legacyStores = join(legacyRoot, "stores");
	const legacyRows: Array<{ storeId: string; chunks: MemoryChunk[] }> = [];
	if (existsSync(legacyStores)) {
		for (const dir of readdirSync(legacyStores, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const path = join(legacyStores, dir.name, "chunks.jsonl");
			if (!existsSync(path)) continue;
			const chunks = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(parseChunk).filter((c): c is MemoryChunk => !!c);
			if (chunks.length) legacyRows.push({ storeId: dir.name, chunks });
		}
	}
	const legacyDiffPath = join(legacyRoot, "memory-diff.jsonl");
	const legacyDiffs = existsSync(legacyDiffPath)
		? readFileSync(legacyDiffPath, "utf8").split(/\r?\n/).filter(Boolean).map(parseDiff).filter((r): r is MemoryDiffRecord => !!r)
		: [];
	if (!existing && (legacyRows.length || legacyDiffs.length)) {
		const insertChunk = db.prepare(`INSERT OR IGNORE INTO memory_chunks
			(id, scope_id, store_id, text, embedding, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		const insertDiff = db.prepare(`INSERT INTO memory_diff
			(scope_id, ts, op, event_id, title, arc, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		db.transaction(() => {
			for (const row of legacyRows) {
				for (const c of row.chunks) insertChunk.run(c.id, scopeId, row.storeId, c.text, JSON.stringify(c.embedding), JSON.stringify(c.meta ?? {}), c.createdAt);
			}
			for (const d of legacyDiffs) insertDiff.run(scopeId, d.ts, d.op, d.eventId, d.title, d.arc ?? null, d.reason);
		})();
	}
	migratedScopes.add(key);
}

function prepareScope(cwd: string, scope: MemoryScope): { db: SqliteDatabase; scopeId: string } {
	const db = openDatabase(cwd);
	migrateLegacyScope(cwd, scope);
	return { db, scopeId: memoryScopeId(scope) };
}

export function ensureStoreDir(_cwd: string, _scope: MemoryScope, _storeId: string): void {
	// Kept for callers that used this helper. SQLite creates its parent on open.
}

export function loadChunks(cwd: string, scope: MemoryScope, storeId: string): MemoryChunk[] {
	const { db, scopeId } = prepareScope(cwd, scope);
	const rows = db.prepare(`SELECT id, text, embedding, meta, created_at FROM memory_chunks
		WHERE scope_id = ? AND store_id = ? ORDER BY rowid`).all(scopeId, storeId) as Array<{ id: string; text: string; embedding: string; meta: string; created_at: string }>;
	return rows.map(rowToChunk).filter((c): c is MemoryChunk => !!c);
}

export function persistChunks(cwd: string, scope: MemoryScope, storeId: string, chunks: MemoryChunk[]): void {
	const { db, scopeId } = prepareScope(cwd, scope);
	const replace = db.transaction(() => {
		db.prepare("DELETE FROM memory_chunks WHERE scope_id = ? AND store_id = ?").run(scopeId, storeId);
		const insert = db.prepare(`INSERT INTO memory_chunks
			(id, scope_id, store_id, text, embedding, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		for (const c of chunks) insert.run(c.id, scopeId, storeId, c.text, JSON.stringify(c.embedding), JSON.stringify(c.meta ?? {}), c.createdAt);
	});
	replace();
}

export function appendMemoryDiff(cwd: string, scope: MemoryScope, record: MemoryDiffRecord): void {
	const { db, scopeId } = prepareScope(cwd, scope);
	db.prepare(`INSERT INTO memory_diff(scope_id, ts, op, event_id, title, arc, reason)
		VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scopeId, record.ts, record.op, record.eventId, record.title, record.arc ?? null, record.reason);
}

export function listMemoryDiff(cwd: string, scope: MemoryScope, limit = 50): MemoryDiffRecord[] {
	const { db, scopeId } = prepareScope(cwd, scope);
	const n = Math.max(1, Math.min(500, Math.floor(limit) || 50));
	const rows = db.prepare(`SELECT ts, op, event_id, title, arc, reason FROM memory_diff
		WHERE scope_id = ? ORDER BY seq DESC LIMIT ?`).all(scopeId, n) as Array<{ ts: string; op: MemoryDiffRecord["op"]; event_id: string; title: string; arc: string | null; reason: string }>;
	return rows.map((r) => ({ ts: r.ts, op: r.op, eventId: r.event_id, title: r.title, ...(r.arc ? { arc: r.arc } : {}), reason: r.reason }));
}

export function countChunks(cwd: string, scope: MemoryScope, storeId: string): number {
	const { db, scopeId } = prepareScope(cwd, scope);
	return Number((db.prepare("SELECT COUNT(*) AS count FROM memory_chunks WHERE scope_id = ? AND store_id = ?").get(scopeId, storeId) as { count: number }).count);
}

export function clearStore(cwd: string, scope: MemoryScope, storeId: string): void {
	const { db, scopeId } = prepareScope(cwd, scope);
	db.prepare("DELETE FROM memory_chunks WHERE scope_id = ? AND store_id = ?").run(scopeId, storeId);
}

export function deleteStoreFiles(cwd: string, scope: MemoryScope, storeId: string): void {
	clearStore(cwd, scope, storeId);
	// Remove only the legacy directory after its data has been imported.
	const legacy = join(memoryScopeRoot(cwd, scope), "stores", storeId);
	if (existsSync(legacy)) rmSync(legacy, { recursive: true, force: true });
}

export function evictionRank(c: MemoryChunk): number {
	const imp = c.meta?.importance;
	const kind = c.meta?.kind;
	if (kind === "event") {
		if (imp === "core" || imp === "major") return 4;
		if (imp === "minor") return 2.5;
		return 3.5;
	}
	switch (imp) {
		case "core":
		case "major": return 3;
		case "normal": return 2;
		default: return 1;
	}
}

export function evictByPriority(chunks: MemoryChunk[], maxChunks: number): MemoryChunk[] {
	if (chunks.length <= maxChunks) return chunks;
	const deletionOrder = [...chunks].sort((a, b) => {
		const rank = evictionRank(a) - evictionRank(b);
		return rank || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
	});
	let n = chunks.length;
	const dropped = new Set<string>();
	for (const c of deletionOrder) {
		if (n <= maxChunks) break;
		if (evictionRank(c) >= 4) continue;
		dropped.add(c.id);
		n--;
	}
	return chunks.filter((c) => !dropped.has(c.id));
}

export function splitTextChunks(text: string, maxLen = 480): string[] {
	const t = text.replace(/\r\n/g, "\n").trim();
	if (!t) return [];
	const paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
	const out: string[] = [];
	let buf = "";
	const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ""; };
	for (const p of paras.length ? paras : [t]) {
		if (p.length <= maxLen) {
			if ((buf + "\n\n" + p).length > maxLen) { flush(); buf = p; }
			else buf = buf ? `${buf}\n\n${p}` : p;
			continue;
		}
		flush();
		for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
	}
	flush();
	return out;
}

export interface EntryEvidencePart {
	text: string;
	charFrom: number;
	charTo: number;
}

/**
 * 按 entry 切证据块，并给每块标出其在**原始 entry 文本**中的绝对字符区间。
 * charFrom/charTo 对齐原始文本（server 回源时按 message.content 切），
 * 存储时裁掉首尾空白但不改坐标——回源切片总会包含本块正文，内容不丢。
 */
export function splitEntryWithOffsets(raw: string, maxLen = 600): EntryEvidencePart[] {
	const t = raw.replace(/\r\n/g, "\n");
	if (!t.trim()) return [];
	const paras = t.split(/(?<=\n\n)/).map((p) => p).filter((p) => p.trim());
	if (!paras.length) paras.push(t);
	const out: EntryEvidencePart[] = [];
	const push = (from: number, to: number) => {
		const slice = t.slice(from, to);
		if (!slice.trim()) return;
		out.push({ text: slice.trim(), charFrom: from, charTo: to });
	};
	let cursor = 0;
	for (const para of paras) {
		const start = t.indexOf(para, cursor);
		if (start < 0) continue;
		cursor = start + para.length;
		if (para.length <= maxLen) { push(start, start + para.length); continue; }
		for (let i = 0; i < para.length; i += maxLen) {
			push(start + i, Math.min(start + para.length, start + i + maxLen));
		}
	}
	return out;
}

export type MemoryStoreInput = string | { text: string; meta?: MemoryChunkMeta };
type ResolvedStoreInput = { text: string; meta: MemoryChunkMeta };

export async function upsertTexts(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	inputs: MemoryStoreInput[],
	baseMeta: MemoryChunkMeta,
	maxChunks: number,
	embedCtx: EmbedContext,
): Promise<{ added: number; total: number }> {
	const chunks = loadChunks(cwd, scope, storeId);
	const now = new Date().toISOString();
	const seen = new Set(chunks.map((c) => c.text));
	const fresh: Array<ResolvedStoreInput & { raw: string }> = [];
	for (const input of inputs) {
		const { text, meta } = typeof input === "string" ? { text: input, meta: {} as MemoryChunkMeta } : input;
		const trimmed = (text ?? "").trim();
		if (trimmed.length < 8 || seen.has(trimmed)) continue;
		const body = trimmed.slice(0, 4000);
		seen.add(body);
		fresh.push({ raw: trimmed, text: body, meta: meta ?? {} });
	}
	if (!fresh.length) return { added: 0, total: chunks.length };
	const vectors = await embedMany(fresh.map((f) => f.text), embedCtx);
	const mode = embedCtx.mode;
	const model = mode === "cloud" ? embedCtx.cloud.model : "local-hash-v1";
	for (let i = 0; i < fresh.length; i++) {
		const item = fresh[i]!;
		chunks.push({ id: cryptoRandomId(), text: item.text, embedding: vectors[i]!, meta: { ...baseMeta, ...item.meta, sessionId: scope.sessionId, card: scope.card, embedMode: mode, embedModel: model }, createdAt: now });
	}
	persistChunks(cwd, scope, storeId, chunks.length > maxChunks ? evictByPriority(chunks, maxChunks) : chunks);
	return { added: fresh.length, total: countChunks(cwd, scope, storeId) };
}

export function listChunks(cwd: string, scope: MemoryScope, storeId: string): MemoryChunkListItem[] {
	return loadChunks(cwd, scope, storeId).map((c) => ({ id: c.id, text: c.text, textLen: c.text.length, meta: c.meta, createdAt: c.createdAt }));
}

export function deleteChunkById(cwd: string, scope: MemoryScope, storeId: string, chunkId: string): boolean {
	const { db, scopeId } = prepareScope(cwd, scope);
	const result = db.prepare("DELETE FROM memory_chunks WHERE scope_id = ? AND store_id = ? AND id = ?").run(scopeId, storeId, chunkId.trim());
	return result.changes > 0;
}

export async function mergeNarrativeText(
	cwd: string,
	scope: MemoryScope,
	text: string,
	meta: MemoryChunkMeta,
	maxChunks: number,
	embedCtx: EmbedContext,
	maxEntryChars = NARRATIVE_MERGE_MAX_CHARS,
): Promise<{ merged: boolean; added: number; total: number; id: string; noop?: boolean }> {
	const body = text.trim().slice(0, 4000);
	if (body.length < 8) return { merged: false, added: 0, total: countChunks(cwd, scope, "narrative"), id: "", noop: true };
	const chunks = loadChunks(cwd, scope, "narrative");
	const last = chunks.length ? chunks[chunks.length - 1]! : null;
	if (last && (last.text === body || (body.length >= 24 && last.text.includes(body.slice(0, Math.min(80, body.length)))))) {
		return { merged: true, added: 0, total: chunks.length, id: last.id, noop: true };
	}
	const now = new Date().toISOString();
	const mode = embedCtx.mode;
	const model = mode === "cloud" ? embedCtx.cloud.model : "local-hash-v1";
	if (last && last.meta.source === "narrative" && `${last.text}\n\n${body}`.length <= Math.max(400, maxEntryChars)) {
		last.text = `${last.text}\n\n${body}`;
		last.embedding = await embedOne(last.text, embedCtx);
		last.meta = { ...last.meta, ...meta, sessionId: scope.sessionId, card: scope.card, source: "narrative", embedMode: mode, embedModel: model, mergeCount: (last.meta.mergeCount ?? 1) + 1, updatedAt: now };
		persistChunks(cwd, scope, "narrative", chunks);
		return { merged: true, added: 0, total: chunks.length, id: last.id };
	}
	const id = cryptoRandomId();
	chunks.push({ id, text: body, embedding: await embedOne(body, embedCtx), meta: { ...meta, sessionId: scope.sessionId, card: scope.card, source: "narrative", embedMode: mode, embedModel: model, mergeCount: 1, updatedAt: now }, createdAt: now });
	persistChunks(cwd, scope, "narrative", chunks.length > maxChunks ? evictByPriority(chunks, maxChunks) : chunks);
	return { merged: false, added: 1, total: countChunks(cwd, scope, "narrative"), id };
}

export async function reembedStore(cwd: string, scope: MemoryScope, storeId: string, embedCtx: EmbedContext, batchSize = 32): Promise<{ total: number; updated: number; skipped: number }> {
	const chunks = loadChunks(cwd, scope, storeId);
	if (!chunks.length) return { total: 0, updated: 0, skipped: 0 };
	const size = Math.max(1, Math.min(64, Math.floor(batchSize) || 32));
	const mode = embedCtx.mode;
	const model = mode === "cloud" ? embedCtx.cloud.model : "local-hash-v1";
	let updated = 0;
	let skipped = 0;
	for (let i = 0; i < chunks.length; i += size) {
		const batch = chunks.slice(i, i + size);
		const vectors = await embedMany(batch.map((c) => c.text), embedCtx);
		for (let j = 0; j < batch.length; j++) {
			const vector = vectors[j];
			if (!vector?.length) { skipped++; continue; }
			batch[j]!.embedding = vector;
			batch[j]!.meta = { ...batch[j]!.meta, embedMode: mode, embedModel: model };
			updated++;
		}
	}
	persistChunks(cwd, scope, storeId, chunks);
	return { total: chunks.length, updated, skipped };
}

export async function searchStore(
	cwd: string,
	scope: MemoryScope,
	storeId: string,
	query: string,
	topK: number,
	embedCtx: EmbedContext,
	predicate?: (chunk: MemoryChunk) => boolean,
): Promise<MemorySearchHit[]> {
	const q = query.trim();
	if (!q) return [];
	const [queryEmbedding] = await embedMany([q], embedCtx);
	if (!queryEmbedding) return [];
	const currentModel = embedCtx.mode === "cloud" ? embedCtx.cloud.model : "local-hash-v1";
	return loadChunks(cwd, scope, storeId)
		.filter((c) => (!predicate || predicate(c)) && c.meta?.embedMode === embedCtx.mode && c.meta?.embedModel === currentModel && c.embedding.length === queryEmbedding.length)
		.map((c) => ({ id: c.id, text: c.text, score: cosine(queryEmbedding, c.embedding), meta: c.meta, createdAt: c.createdAt }))
		.filter((h) => h.score > 0.05)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, Math.max(1, topK));
}

export function listStoreIdsOnDisk(cwd: string, scope: MemoryScope): string[] {
	const db = openDatabase(cwd);
	const scopeId = memoryScopeId(scope);
	const rows = db.prepare("SELECT DISTINCT store_id FROM memory_chunks WHERE scope_id = ? ORDER BY store_id").all(scopeId) as Array<{ store_id: string }>;
	return rows.map((r) => r.store_id);
}

export function listScopeIdsOnDisk(cwd: string): string[] {
	const db = openDatabase(cwd);
	const rows = db.prepare("SELECT DISTINCT scope_id FROM memory_chunks ORDER BY scope_id").all() as Array<{ scope_id: string }>;
	return rows.map((r) => r.scope_id);
}

function cryptoRandomId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
