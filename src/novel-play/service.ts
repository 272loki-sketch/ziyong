/** Application adapter: reuses corpus input, Skill loading, extraction and immutable storage. */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CorpusDocument } from "../outline/corpus.ts";
import { readJsonFile } from "../jsonio.ts";
import { scanSkillFiles } from "../stage/skill-store.ts";
import { prepareNovelSource } from "./source.ts";
import { extractNovelEvents } from "./extract.ts";
import type { NovelExtractionCheckpoint, NovelExtractionModelCall } from "./extract.ts";
import { novelPlayStoreRoot, saveNovelPackage } from "./store.ts";
import type { NovelPackage } from "./canon.ts";

const active = new Set<string>();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function loadCheckpoint(file: string): NovelExtractionCheckpoint | undefined {
	let raw: unknown;
	try { raw = readJsonFile(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid novel checkpoint");
	const value = raw as Record<string, unknown>;
	if (typeof value.key !== "string" || !value.completed || typeof value.completed !== "object" || Array.isArray(value.completed)) throw new Error("Invalid novel checkpoint");
	const completed: Record<string, string> = {};
	for (const [key, result] of Object.entries(value.completed)) {
		if (!/^\d+$/.test(key) || typeof result !== "string") throw new Error("Invalid novel checkpoint entry");
		completed[key] = result;
	}
	// extractNovelEvents revalidates exact quotes, dependencies and skill/source identity.
	return { key: value.key, completed };
}

export interface BuildNovelEventsInput {
	cwd: string;
	/** The host supplies the document and exact text from its existing CorpusEngine. */
	document: Pick<CorpusDocument, "id" | "title" | "status" | "chars" | "chunkCount">;
	storedText: string;
	modelCall: NovelExtractionModelCall;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number) => void;
}

/**
 * Builds the event layer only. Does not create a playable card or start a session.
 * Serializes builds per document in this process. Completed chunks survive retry/restart.
 * Does not create a second background scheduler or read model credentials.
 */
export async function buildNovelEvents(input: BuildNovelEventsInput): Promise<NovelPackage> {
	const source = prepareNovelSource(input.document, input.storedText);
	const skill = scanSkillFiles(input.cwd).find(item => item.dir === "小说作品构建");
	if (!skill?.body.trim()) throw new Error("缺少小说作品构建 Skill");
	const root = join(novelPlayStoreRoot(input.cwd), "checkpoints");
	const file = join(root, `${hash(source.docId)}.json`);
	if (active.has(file)) throw new Error("该小说已在构建中");
	if (input.signal?.aborted) throw new DOMException("构建已取消", "AbortError");
	active.add(file);
	try {
		mkdirSync(root, { recursive: true });
		const checkpoint = loadCheckpoint(file);
		input.onProgress?.(Object.keys(checkpoint?.completed ?? {}).length, source.chunks.length);
		const result = await extractNovelEvents(source, {
			modelCall: input.modelCall, skillBody: skill.body, signal: input.signal,
			checkpoint,
			onCheckpoint: async checkpoint => {
				input.onProgress?.(Object.keys(checkpoint.completed).length, source.chunks.length);
				const temporary = join(root, `.${randomBytes(16).toString("hex")}.tmp`);
				try {
					writeFileSync(temporary, JSON.stringify(checkpoint), { encoding: "utf8", flag: "wx" });
					renameSync(temporary, file);
				} finally { rmSync(temporary, { force: true }); }
			},
		});
		if (input.signal?.aborted) throw new DOMException("构建已取消", "AbortError");
		saveNovelPackage(input.cwd, source, result.package);
		return result.package;
	} finally { active.delete(file); }
}
