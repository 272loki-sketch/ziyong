import { createHash } from "node:crypto";
import { buildNovelPackage, type NovelNode, type NovelPackage, type NovelStage } from "./canon.ts";
import { novelNodeId, type NovelEvidence, type NovelSource } from "./source.ts";

export interface NovelExtractionModelInput {
	skillBody: string;
	source: { docId: string; title: string; fingerprint: string };
	chunk: { index: number; chapters: string[]; text: string };
	attempt: number;
	previousValidationError?: string;
	signal?: AbortSignal;
}

export type NovelExtractionModelCall = (input: NovelExtractionModelInput) => Promise<string>;

export interface NovelExtractionCheckpoint {
	key: string;
	/** Validated again before use. Values are raw model JSON, indexed by source chunk. */
	completed: Record<string, string>;
}

export interface ExtractNovelEventsOptions {
	modelCall: NovelExtractionModelCall;
	skillBody: string;
	signal?: AbortSignal;
	/** Values above two are capped at two. Non-finite values are rejected. */
	maxAttempts?: number;
	checkpoint?: NovelExtractionCheckpoint;
	/** Awaited after each cached or live chunk has passed full validation. */
	onCheckpoint?: (checkpoint: NovelExtractionCheckpoint) => Promise<void> | void;
}

export interface NovelExtractionResult {
	package: NovelPackage;
	checkpoint: NovelExtractionCheckpoint;
}

type RawNode = {
	key: string;
	title: string;
	summary: string;
	visibility: "public" | "secret";
	dependsOn: string[];
	quote: string;
};

const MAX_NODES_PER_CHUNK = 100;
const MAX_KEY = 80;
const MAX_TITLE = 160;
const MAX_SUMMARY = 1200;
const MAX_QUOTE = 2000;
const ROOT_KEYS = ["nodes"];
const NODE_KEYS = ["dependsOn", "key", "quote", "summary", "title", "visibility"];

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const ownKeysAre = (value: Record<string, unknown>, keys: string[]): boolean => {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

function checkpointKey(source: NovelSource, skillBody: string): string {
	const layout = source.chunks.map(chunk => ({ index: chunk.index, chars: chunk.chars, chapters: chunk.chapters }));
	return hash(JSON.stringify({
		version: 1,
		fingerprint: source.fingerprint,
		chunkChars: source.chunkChars,
		layout,
		skillHash: hash(skillBody),
	}));
}

function copyCheckpoint(key: string, completed: Record<string, string>): NovelExtractionCheckpoint {
	return { key, completed: { ...completed } };
}

function boundedString(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} invalid`);
	return value.trim();
}

function parseChunkResult(text: string, chunkText: string): RawNode[] {
	let value: unknown;
	const source = text.trim();
	const candidates = [
		source,
		source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
		source.match(/\{[\s\S]*\}/)?.[0],
	].filter((candidate): candidate is string => !!candidate?.trim());
	for (const candidate of candidates) {
		try {
			value = JSON.parse(candidate);
			break;
		} catch {
			// Keep trying only bounded JSON envelopes; strict schema validation follows.
		}
	}
	if (value === undefined) throw new Error("model result is not JSON");
	if (!value || typeof value !== "object" || Array.isArray(value) || !ownKeysAre(value as Record<string, unknown>, ROOT_KEYS)) {
		throw new Error("model result has an invalid root shape");
	}
	const rawNodes = (value as Record<string, unknown>).nodes;
	if (!Array.isArray(rawNodes) || rawNodes.length > MAX_NODES_PER_CHUNK) {
		throw new Error("chunk must contain between 0 and 100 evidenced events");
	}
	const earlierKeys = new Set<string>();
	let previousQuoteStart = -1;
	return rawNodes.map((raw, index): RawNode => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || !ownKeysAre(raw as Record<string, unknown>, NODE_KEYS)) {
			throw new Error(`event ${index} has an invalid shape`);
		}
		const item = raw as Record<string, unknown>;
		const key = boundedString(item.key, `event ${index} key`, MAX_KEY);
		if (earlierKeys.has(key)) throw new Error(`duplicate local event key: ${key}`);
		const visibility = item.visibility;
		if (visibility !== "public" && visibility !== "secret") throw new Error(`event ${key} visibility invalid`);
		if (!Array.isArray(item.dependsOn) || item.dependsOn.length > MAX_NODES_PER_CHUNK
			|| item.dependsOn.some(dep => typeof dep !== "string" || !dep.trim() || dep.length > MAX_KEY)) {
			throw new Error(`event ${key} dependencies invalid`);
		}
		const dependsOn = item.dependsOn.map(dep => (dep as string).trim());
		if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(key)) throw new Error(`event ${key} dependencies invalid`);
		for (const dependency of dependsOn) {
			if (!earlierKeys.has(dependency)) throw new Error(`event ${key} dependency must be an earlier local explicit key: ${dependency}`);
		}
		const quote = boundedString(item.quote, `event ${key} quote`, MAX_QUOTE);
		const first = chunkText.indexOf(quote);
		if (first < 0 || chunkText.indexOf(quote, first + 1) >= 0) throw new Error(`event ${key} quote must occur exactly once in its chunk`);
		if (first < previousQuoteStart) throw new Error(`event ${key} quote occurs before the preceding event in source order`);
		previousQuoteStart = first;
		earlierKeys.add(key);
		return {
			key,
			title: boundedString(item.title, `event ${key} title`, MAX_TITLE),
			summary: boundedString(item.summary, `event ${key} summary`, MAX_SUMMARY),
			visibility,
			dependsOn,
			quote,
		};
	});
}

function abortError(): Error {
	const error = new Error("novel event extraction aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/**
 * Extracts only evidenced events. Character and world extraction remain separate required steps.
 * The supplied skill body is the complete instruction prompt. Source text is passed as data.
 */
export async function extractNovelEvents(source: NovelSource, options: ExtractNovelEventsOptions): Promise<NovelExtractionResult> {
	if (!source.chunks.length) throw new Error("novel source has no chunks");
	if (!options.skillBody.trim()) throw new Error("novel extraction skill body is empty");
	if (options.maxAttempts !== undefined && !Number.isFinite(options.maxAttempts)) throw new Error("maxAttempts must be finite");
	const attempts = Math.max(1, Math.min(2, Math.trunc(options.maxAttempts ?? 2)));
	const key = checkpointKey(source, options.skillBody);
	const completed: Record<string, string> = options.checkpoint?.key === key ? { ...options.checkpoint.completed } : {};
	const stages: NovelStage[] = [];
	const nodes: NovelNode[] = [];
	let order = 0;

	for (const chunk of source.chunks) {
		throwIfAborted(options.signal);
		let parsed: RawNode[] | undefined;
		const cached = completed[String(chunk.index)];
		if (cached !== undefined) {
			try { parsed = parseChunkResult(cached, chunk.text); } catch { delete completed[String(chunk.index)]; }
		}
		let lastError: unknown;
		for (let attempt = 1; !parsed && attempt <= attempts; attempt++) {
			throwIfAborted(options.signal);
			try {
				const raw = await options.modelCall({
					skillBody: options.skillBody,
					source: { docId: source.docId, title: source.title, fingerprint: source.fingerprint },
					chunk: { index: chunk.index, chapters: [...chunk.chapters], text: chunk.text },
					attempt,
					...(lastError instanceof Error ? { previousValidationError: lastError.message } : {}),
					signal: options.signal,
				});
				throwIfAborted(options.signal);
				parsed = parseChunkResult(raw, chunk.text);
				completed[String(chunk.index)] = raw;
			} catch (error) {
				if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
				lastError = error;
			}
		}
		if (!parsed) {
			const detail = lastError instanceof Error ? lastError.message : "unknown model failure";
			throw new Error(`novel event extraction failed for chunk ${chunk.index} after ${attempts} attempt(s): ${detail}`);
		}
		throwIfAborted(options.signal);
		await options.onCheckpoint?.(copyCheckpoint(key, completed));
		throwIfAborted(options.signal);
		if (!parsed.length) continue;

		const stageId = `chunk-${chunk.index}`;
		stages.push({ id: stageId, order: stages.length, title: chunk.chapters.length ? chunk.chapters.join(" / ") : `分块 ${chunk.index + 1}` });
		const localIds = new Map<string, string>();
		for (const raw of parsed) {
			const start = chunk.text.indexOf(raw.quote);
			const ref: NovelEvidence = { chunkIndex: chunk.index, start, end: start + raw.quote.length, quote: raw.quote };
			localIds.set(raw.key, novelNodeId(source, ref, raw.key));
		}
		for (const raw of parsed) {
			const start = chunk.text.indexOf(raw.quote);
			const ref: NovelEvidence = { chunkIndex: chunk.index, start, end: start + raw.quote.length, quote: raw.quote };
			nodes.push({
				id: localIds.get(raw.key)!, key: raw.key, stageId, order: order++, title: raw.title,
				summary: raw.summary, visibility: raw.visibility,
				dependsOn: raw.dependsOn.map(dependency => localIds.get(dependency)!), sourceRefs: [ref],
			});
		}
	}
	if (!nodes.length) throw new Error("novel event extraction found no playable events in the complete source");
	if (!nodes.some(node => node.visibility === "public")) {
		throw new Error("novel event extraction found no public starting point; all evidenced events are secret");
	}
	return { package: buildNovelPackage(source, stages, nodes), checkpoint: copyCheckpoint(key, completed) };
}
