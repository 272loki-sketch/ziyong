import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { WebResearchItem } from "../tools/web-research.ts";
import type { CorpusDailyPattern, CorpusDigest, CorpusDocument, NarrativeAsset } from "./corpus.ts";

export interface OutlineResearchSource { id: string; title: string; url: string; accessedAt: string }
export type ResearchConfidence = "legacy-claimed" | "system-grounded" | "audited";
export interface ResearchUsage { selected: number; usedByDirector: number; adopted: number; dismissed: number; lastSelectedAt?: string }
export interface OutlineResearchMechanism { id: string; sourceIds: string[]; mechanism: string; appliesWhen: string; failureWarning: string; locator?: string; evidenceSummary?: string; confidence?: ResearchConfidence; enabled?: boolean; usage?: ResearchUsage }
export interface OutlineResearchCard { version: 1; cardKey: string; mechanismIds: string[]; updatedAt: string }
export interface OutlineResearchView { sources: OutlineResearchSource[]; mechanisms: OutlineResearchMechanism[]; cards: OutlineResearchCard[]; documents: CorpusDocument[]; assets: Array<NarrativeAsset & { docId: string }>; dailyPatterns: Array<CorpusDailyPattern & { docId: string }> }
export interface OutlineResearchExtraction { mechanism: string; appliesWhen: string; failureWarning: string; sourceIds: string[]; locator?: string; evidenceSummary?: string; confidence?: ResearchConfidence }

/** 一次研究搜索的持久化记录：保留来源与提炼结果，供回看与再次提炼。 */
export interface ResearchSearchLog {
	id: string;
	createdAt: string;
	/** 用户输入的话题（截断保留）。 */
	topic: string;
	/** 实际执行的脱敏检索式。 */
	queries: string[];
	/** 搜到的来源行（完整保留，供再次提炼）。 */
	sources: Array<{ id: string; query: string; title: string; url: string; snippet: string }>;
	/** 该次（或最后一次）提炼出的机制。 */
	extracted: OutlineResearchExtraction[];
}

const MAX_SEARCH_LOGS = 30;

const arrayFile = <T>(path: string): T[] => {
	try { const value = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(value) ? value as T[] : []; } catch { return []; }
};

export class OutlineResearchStore {
	#root: string;
	#write = Promise.resolve();
	constructor(cwd: string) { this.#root = join(cwd, ".liyuan", "outline", "research"); }

	view(cardKey?: string): OutlineResearchView {
		const cardsDir = join(this.#root, "cards");
		const cards: OutlineResearchCard[] = [];
		if (existsSync(cardsDir)) {
			for (const name of readdirSync(cardsDir)) {
				if (!name.endsWith(".json")) continue;
				try { cards.push(JSON.parse(readFileSync(join(cardsDir, name), "utf8")) as OutlineResearchCard); } catch {}
			}
		}
		const allSources = arrayFile<OutlineResearchSource>(join(this.#root, "sources.json"));
		const usage = new Map(arrayFile<{ id: string; usage: ResearchUsage }>(join(this.#root, "usage.json")).map((row) => [row.id, row.usage]));
		const allMechanisms = arrayFile<OutlineResearchMechanism>(join(this.#root, "mechanisms.json")).map((row) => ({ ...normalizeMechanism(row), ...(usage.has(row.id) ? { usage: usage.get(row.id) } : {}) }));
		const documents = this.#documents();
		if (!cardKey) return { sources: allSources, mechanisms: allMechanisms, cards, documents, assets: this.#assets(documents), dailyPatterns: this.#dailyPatterns(documents) };
		const card = cards.find((row) => row.cardKey === cardKey);
		const sourceIds = new Set(allMechanisms.flatMap((row) => row.sourceIds));
		// 小说消化素材是抽象可复用套路，跨卡共享：玄幻里的争风吃醋同样适用都市。
		// 所以机制/文档/素材一律全量返回；cardKey 只用于给出当前卡的关联记录（cards 字段）。
		return {
			sources: allSources.filter((row) => sourceIds.has(row.id)),
			mechanisms: allMechanisms,
			cards: card ? [card] : [],
			documents,
			assets: this.#assets(documents),
			dailyPatterns: this.#dailyPatterns(documents),
		};
	}

	#documents(): CorpusDocument[] {
		try {
			const value = JSON.parse(readFileSync(join(this.#root, "corpus", "documents.json"), "utf8"));
			return Array.isArray(value) ? value as CorpusDocument[] : [];
		} catch { return []; }
	}

	#assets(documents: CorpusDocument[]): Array<NarrativeAsset & { docId: string }> {
		const assets: Array<NarrativeAsset & { docId: string }> = [];
		for (const document of documents) {
			if (document.status !== "ready") continue;
			try {
				const digest = JSON.parse(readFileSync(join(this.#root, "corpus", "digests", `${document.id}.json`), "utf8")) as CorpusDigest;
				if (Array.isArray(digest.assets)) assets.push(...digest.assets.map((asset) => ({ ...asset, docId: document.id })));
			} catch {}
		}
		return assets;
	}

	#dailyPatterns(documents: CorpusDocument[]): Array<CorpusDailyPattern & { docId: string }> {
		const patterns: Array<CorpusDailyPattern & { docId: string }> = [];
		for (const document of documents) {
			if (document.status !== "ready") continue;
			try {
				const digest = JSON.parse(readFileSync(join(this.#root, "corpus", "digests", `${document.id}.json`), "utf8")) as CorpusDigest;
				if (Array.isArray(digest.dailyPatterns)) patterns.push(...digest.dailyPatterns.map((pattern) => ({ ...pattern, docId: document.id })));
			} catch {}
		}
		return patterns;
	}

	/** 小说消化完成时把套路条目合并进研究库：mechanisms + card 关联（documents 由 CorpusEngine 自己落盘）。 */
	mergeCorpus(cardKey: string, document: CorpusDocument, _digest: CorpusDigest, extracted: OutlineResearchExtraction[]): Promise<CorpusDocument[]> {
		const task = this.#write.then(() => {
			const current = this.view();
			const mechanisms = new Map(current.mechanisms.map((row) => [row.id, row]));
			const ids: string[] = [];
			for (const item of extracted.slice(0, 80)) {
				const sourceIds = [...new Set(item.sourceIds)].filter((id) => id.startsWith("doc-"));
				if (!sourceIds.length || !item.mechanism.trim()) continue;
				const mechanism = item.mechanism.trim().slice(0, 600), appliesWhen = item.appliesWhen.trim().slice(0, 500), failureWarning = item.failureWarning.trim().slice(0, 500);
				const locator = item.locator?.trim().slice(0, 240), evidenceSummary = item.evidenceSummary?.trim().slice(0, 800);
				const mechanismId = `mech-${createHash("sha256").update(`${mechanism}\n${sourceIds.sort().join(",")}\n${locator ?? ""}`).digest("hex").slice(0, 16)}`;
				mechanisms.set(mechanismId, { id: mechanismId, sourceIds, mechanism, appliesWhen, failureWarning, confidence: item.confidence ?? "system-grounded", enabled: true, ...(locator ? { locator } : {}), ...(evidenceSummary ? { evidenceSummary } : {}) });
				ids.push(mechanismId);
			}
			const oldCard = current.cards.find((row) => row.cardKey === cardKey);
			const card: OutlineResearchCard = { version: 1, cardKey, mechanismIds: [...new Set([...(oldCard?.mechanismIds ?? []), ...ids])].slice(-100), updatedAt: new Date().toISOString() };
			this.#atomic(join(this.#root, "mechanisms.json"), [...mechanisms.values()]);
			this.#atomic(join(this.#root, "cards", `${safeKey(cardKey)}.json`), card);
			const scoped = this.view(cardKey);
			return scoped.documents;
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	/** 删除只被该文档引用（sourceIds 全部指向该 doc-*）的机制条目；被 Web 来源共同支撑的保留。返回删除条数。 */
	removeCorpus(docId: string): Promise<number> {
		const task = this.#write.then(() => {
			const current = this.view();
			const removed = new Set<string>();
			const kept = current.mechanisms.filter((row) => {
				if (row.sourceIds.includes(docId) && row.sourceIds.every((id) => id.startsWith("doc-"))) {
					// 仅该 doc 支撑：删除（除非还挂在其他 doc-* —— corpus 机制不会跨文档）
					if (row.sourceIds.length === 1) { removed.add(row.id); return false; }
				}
				return true;
			});
			if (!removed.size) return 0;
			this.#atomic(join(this.#root, "mechanisms.json"), kept);
			// 卡关联也清理
			for (const card of current.cards) {
				const next = card.mechanismIds.filter((id) => !removed.has(id));
				if (next.length !== card.mechanismIds.length) {
					this.#atomic(join(this.#root, "cards", `${safeKey(card.cardKey)}.json`), { ...card, mechanismIds: next, updatedAt: new Date().toISOString() });
				}
			}
			return removed.size;
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	merge(cardKey: string, rows: WebResearchItem[], extracted: OutlineResearchExtraction[] = []): Promise<OutlineResearchView> {
		const task = this.#write.then(() => {
			const current = this.view();
			const sources = new Map(current.sources.map((row) => [row.url, row]));
			const mechanisms = new Map(current.mechanisms.map((row) => [row.id, row]));
			const ids: string[] = [], fetchedSourceIds = new Set<string>();
			for (const item of rows) for (const result of item.results ?? []) {
				let url: string;
				try { url = new URL(result.url).toString(); } catch { continue; }
				const sourceId = `src-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
				sources.set(url, { id: sourceId, title: result.title.trim().slice(0, 180), url, accessedAt: new Date().toISOString() });
				fetchedSourceIds.add(sourceId);
			}
			for (const item of extracted.slice(0, 80)) {
				const sourceIds = [...new Set(item.sourceIds)].filter((id) => fetchedSourceIds.has(id));
				if (!sourceIds.length || !item.mechanism.trim()) continue;
				const mechanism = item.mechanism.trim().slice(0, 600), appliesWhen = item.appliesWhen.trim().slice(0, 500), failureWarning = item.failureWarning.trim().slice(0, 500);
				const mechanismId = `mech-${createHash("sha256").update(`${mechanism}\n${sourceIds.sort().join(",")}`).digest("hex").slice(0, 16)}`;
				mechanisms.set(mechanismId, { id: mechanismId, sourceIds, mechanism, appliesWhen, failureWarning, confidence: "system-grounded", enabled: true });
				ids.push(mechanismId);
			}
			const oldCard = current.cards.find((row) => row.cardKey === cardKey);
			const card: OutlineResearchCard = { version: 1, cardKey, mechanismIds: [...new Set([...(oldCard?.mechanismIds ?? []), ...ids])].slice(-100), updatedAt: new Date().toISOString() };
			this.#atomic(join(this.#root, "sources.json"), [...sources.values()]);
			this.#atomic(join(this.#root, "mechanisms.json"), [...mechanisms.values()]);
			this.#atomic(join(this.#root, "cards", `${safeKey(cardKey)}.json`), card);
			const scoped = this.view(cardKey);
			if (scoped.sources.length || scoped.mechanisms.length) return scoped;
			return { sources: [...sources.values()].filter((row) => fetchedSourceIds.has(row.id)), mechanisms: [], cards: [card], documents: [], assets: [], dailyPatterns: [] };
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	/** 研究搜索历史（倒序，最多 30 条）。 */
	searchHistory(): ResearchSearchLog[] { return arrayFile<ResearchSearchLog>(join(this.#root, "search-logs.json")).slice(-MAX_SEARCH_LOGS).reverse(); }

	appendSearchLog(log: ResearchSearchLog): void {
		const logs = [...arrayFile<ResearchSearchLog>(join(this.#root, "search-logs.json")).filter((row) => row.id !== log.id), log].slice(-MAX_SEARCH_LOGS);
		this.#atomic(join(this.#root, "search-logs.json"), logs);
	}

	/** 记录某条搜索历史的重新提炼结果；找不到返回 null。 */
	updateSearchLogExtracted(id: string, extracted: OutlineResearchExtraction[]): ResearchSearchLog | null {
		const logs = arrayFile<ResearchSearchLog>(join(this.#root, "search-logs.json"));
		const hit = logs.find((row) => row.id === id);
		if (!hit) return null;
		hit.extracted = extracted;
		this.#atomic(join(this.#root, "search-logs.json"), logs);
		return hit;
	}

	recordUsage(ids: Iterable<string>, kind: "selected" | "usedByDirector" | "adopted" | "dismissed"): Promise<void> {
		const task = this.#write.then(() => {
			const rows = new Map(arrayFile<{ id: string; usage: ResearchUsage }>(join(this.#root, "usage.json")).map((row) => [row.id, row.usage]));
			for (const id of ids) {
				const usage = rows.get(id) ?? { selected: 0, usedByDirector: 0, adopted: 0, dismissed: 0 };
				usage[kind]++;
				if (kind === "selected") usage.lastSelectedAt = new Date().toISOString();
				rows.set(id, usage);
			}
			this.#atomic(join(this.#root, "usage.json"), [...rows].map(([id, usage]) => ({ id, usage })));
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	#atomic(path: string, value: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}
}

function safeKey(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }

function normalizeMechanism(row: OutlineResearchMechanism): OutlineResearchMechanism {
	const normalized = { ...row, confidence: row.confidence ?? (row.evidenceSummary ? "system-grounded" : "legacy-claimed"), enabled: row.enabled !== false };
	if (normalized.locator) return normalized;
	const match = row.mechanism.match(/\s*[（(]出处[：:]\s*([^）)]+)[）)]\s*$/);
	if (!match) return normalized;
	return { ...normalized, mechanism: row.mechanism.slice(0, match.index).trim(), locator: match[1].trim(), confidence: "legacy-claimed" };
}
