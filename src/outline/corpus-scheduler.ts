import { discoverKakuyomuWorks, kakuyomuDocumentId, type KakuyomuCandidate, type KakuyomuRequest } from "./kakuyomu.ts";
import type { CorpusEngine } from "./corpus.ts";

export interface NovelDigestAutoSchedule {
	enabled: boolean;
	hour: number;
	minute: number;
	maxPerRun: number;
	queries: string[];
}

export interface CorpusSchedulerDeps {
	engine: CorpusEngine;
	fetchText: KakuyomuRequest;
	schedule: NovelDigestAutoSchedule;
	log?: (message: string) => void;
}

export interface CorpusDiscoveryResult {
	status: "started" | "busy";
	candidateCount: number;
	selected: Array<{ url: string; title: string }>;
	queued: Array<{ url: string; title: string }>;
	errors: Array<{ url: string; message: string }>;
}

export function selectDailyKakuyomuWorks(candidates: KakuyomuCandidate[], existingIds: Set<string>, maxPerRun: number): KakuyomuCandidate[] {
	const selected: KakuyomuCandidate[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const id = kakuyomuDocumentId(candidate.url);
		if (seen.has(id) || existingIds.has(id)) continue;
		seen.add(id);
		selected.push(candidate);
		if (selected.length >= Math.max(1, Math.min(3, maxPerRun))) break;
	}
	return selected;
}

export function millisecondsUntilLocalTime(now: Date, hour: number, minute: number): number {
	const next = new Date(now);
	next.setHours(Math.max(0, Math.min(23, hour)), Math.max(0, Math.min(59, minute)), 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
	return Math.max(1, next.getTime() - now.getTime());
}

function dayNumber(date: Date): number {
	const start = new Date(date.getFullYear(), 0, 1);
	return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}

export class CorpusScheduler {
	#deps: CorpusSchedulerDeps;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;

	constructor(deps: CorpusSchedulerDeps) { this.#deps = deps; }

	start(): void {
		if (!this.#deps.schedule.enabled || this.#timer) return;
		this.#arm();
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async runNow(now = new Date(), maxPerRun = this.#deps.schedule.maxPerRun): Promise<CorpusDiscoveryResult> {
		if (this.#running) return { status: "busy", candidateCount: 0, selected: [], queued: [], errors: [] };
		this.#running = true;
		const result: CorpusDiscoveryResult = { status: "started", candidateCount: 0, selected: [], queued: [], errors: [] };
		try {
			const currentIds = new Set(this.#deps.engine.view().documents.map((doc) => doc.id));
			const page = (dayNumber(now) % 9) + 1;
			const candidates = await discoverKakuyomuWorks(this.#deps.schedule.queries, this.#deps.fetchText, new AbortController().signal, { page, maxResults: 60 });
			const selected = selectDailyKakuyomuWorks(candidates, currentIds, maxPerRun);
			result.candidateCount = candidates.length;
			result.selected = selected.map(({ url, title }) => ({ url, title }));
			this.#deps.log?.(`[corpus-scheduler] ${now.toISOString()} 候选 ${candidates.length} 部，选中 ${selected.length} 部`);
			for (const candidate of selected) {
				try {
					await this.#deps.engine.createUrl(candidate.url);
					result.queued.push({ url: candidate.url, title: candidate.title });
					this.#deps.log?.(`[corpus-scheduler] 已入队：${candidate.title || candidate.url}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					result.errors.push({ url: candidate.url, message });
					this.#deps.log?.(`[corpus-scheduler] 跳过 ${candidate.url}：${message}`);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#deps.log?.(`[corpus-scheduler] 搜索失败：${message}`);
			throw error;
		} finally {
			this.#running = false;
		}
		return result;
	}

	#arm(): void {
		this.#timer = setTimeout(async () => {
			this.#timer = undefined;
			try { await this.runNow(); }
			catch { /* runNow 已记录错误；下一次定时任务仍需继续。 */ }
			finally { if (this.#deps.schedule.enabled) this.#arm(); }
		}, millisecondsUntilLocalTime(new Date(), this.#deps.schedule.hour, this.#deps.schedule.minute));
		this.#timer.unref?.();
	}
}
