import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { novelPlayStoreRoot } from "./store.ts";
import type { NovelSource } from "./source.ts";

export interface NovelCharacterProfileRecord {
	name: string;
	keys: string[];
	content: string;
	evidence: Array<{ chunkIndex: number; start: number; end: number; quote: string }>;
	firstSeenChunk: number;
	lastSeenChunk: number;
}

export interface NovelCharacterProfileCorpus {
	version: 1;
	docId: string;
	revision: string;
	sourceFingerprint: string;
	completedChunks: number[];
	profiles: NovelCharacterProfileRecord[];
	updatedAt: string;
}

const profileKey = (docId: string, revision: string): string => createHash("sha256").update(JSON.stringify([docId, revision])).digest("hex");
export function novelProfileFile(cwd: string, docId: string, revision: string): string {
	return join(novelPlayStoreRoot(cwd), "profiles", `${profileKey(docId, revision)}.json`);
}

export function loadNovelCharacterProfileCorpus(cwd: string, docId: string, revision: string): NovelCharacterProfileCorpus | undefined {
	const file = novelProfileFile(cwd, docId, revision);
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8")) as NovelCharacterProfileCorpus;
}

export function saveNovelCharacterProfileCorpus(cwd: string, value: NovelCharacterProfileCorpus): void {
	const file = novelProfileFile(cwd, value.docId, value.revision);
	mkdirSync(join(novelPlayStoreRoot(cwd), "profiles"), { recursive: true });
	const temporary = `${file}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try { renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}

export function profileVisibleAt(record: NovelCharacterProfileRecord, source: NovelSource, chunkIndex: number, offset: number): boolean {
	if (record.firstSeenChunk < chunkIndex) return true;
	if (record.firstSeenChunk > chunkIndex) return false;
	return record.evidence.some(ref => ref.chunkIndex < chunkIndex || (ref.chunkIndex === chunkIndex && ref.start < offset));
}
