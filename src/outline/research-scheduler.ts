import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutlineResearchSearchResult } from "./engine.ts";

export interface ResearchSearchAutoSchedule {
	enabled: boolean;
	hour: number;
	minute: number;
	maxPerRun: number;
	topics: string[];
}

export interface ResearchSearchScheduleStatus {
	enabled: boolean;
	running: boolean;
	lastRunAt?: string;
	lastRunDate?: string;
	lastStatus?: "completed" | "partial" | "failed" | "skipped";
	lastTopics?: string[];
	lastCompleted?: number;
	lastErrors?: Array<{ topic: string; message: string }>;
}

export interface ResearchSearchScheduleRun {
	status: "started" | "busy" | "skipped";
	topics: string[];	completed: number;	 errors: Array<{ topic: string; message: string }>;
}

type SearchFn = (topic: string) => Promise<OutlineResearchSearchResult>;

export function millisecondsUntilLocalTime(now: Date, hour: number, minute: number): number {
	const next = new Date(now);
	next.setHours(Math.max(0, Math.min(23, hour)), Math.max(0, Math.min(59, minute)), 0, 0);
	if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
	return Math.max(1, next.getTime() - now.getTime());
}

const localDate = (date: Date): string => {
	const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, "0"), d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
};

export class ResearchSearchScheduler {
	#cwd: string; #schedule: ResearchSearchAutoSchedule; #search: SearchFn; #timer: ReturnType<typeof setTimeout> | undefined; #running = false;
	constructor(cwd: string, schedule: ResearchSearchAutoSchedule, search: SearchFn) { this.#cwd = cwd; this.#schedule = schedule; this.#search = search; }
	#statePath(): string { return join(this.#cwd, ".liyuan", "outline", "research", "search-schedule.json"); }
	#read(): Omit<ResearchSearchScheduleStatus, "enabled" | "running"> { try { return JSON.parse(readFileSync(this.#statePath(), "utf8")); } catch { return {}; } }
	#write(value: object): void { const path = this.#statePath(); mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameSync(tmp, path); }
	status(): ResearchSearchScheduleStatus { return { enabled: this.#schedule.enabled, running: this.#running, ...this.#read() }; }
	start(): void { if (!this.#schedule.enabled || this.#timer) return; this.#arm(); }
	stop(): void { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }
	async runNow(now = new Date(), automatic = false): Promise<ResearchSearchScheduleRun> {
		if (this.#running) return { status: "busy", topics: [], completed: 0, errors: [] };
		const previous = this.#read(), date = localDate(now);
		if (automatic && previous.lastRunDate === date) return { status: "skipped", topics: [], completed: 0, errors: [] };
		this.#running = true;
		const topics = [...new Set(this.#schedule.topics.map((topic) => topic.trim()).filter(Boolean))].slice(0, Math.max(1, Math.min(8, this.#schedule.maxPerRun)));
		const errors: Array<{ topic: string; message: string }> = []; let completed = 0;
		try {
			for (const topic of topics) {
				try { await this.#search(topic); completed++; }
				catch (error) { errors.push({ topic, message: error instanceof Error ? error.message : String(error) }); }
			}
			const runStatus = completed === topics.length ? "completed" : completed ? "partial" : "failed";
			this.#write({ lastRunAt: new Date().toISOString(), lastRunDate: date, lastStatus: runStatus, lastTopics: topics, lastCompleted: completed, lastErrors: errors });
			return { status: "started", topics, completed, errors };
		} finally { this.#running = false; }
	}
	#arm(): void {
		this.#timer = setTimeout(async () => { this.#timer = undefined; try { await this.runNow(new Date(), true); } finally { if (this.#schedule.enabled) this.#arm(); } }, millisecondsUntilLocalTime(new Date(), this.#schedule.hour, this.#schedule.minute));
		this.#timer.unref?.();
	}
}
