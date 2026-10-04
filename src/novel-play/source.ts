/** Reuse CorpusEngine's stored, cleaned text and chunker. Never re-clean evidence text. */
import { createHash } from "node:crypto";
import { CHUNK_CHARS, chunkText, splitChapters } from "../outline/corpus.ts";
import type { CorpusDocument, TextChunk } from "../outline/corpus.ts";

export interface NovelSource {
	version: 1;
	docId: string;
	title: string;
	fingerprint: string;
	chunkChars: number;
	chunks: TextChunk[];
	workId?: string;
}

export interface NovelEvidence {
	chunkIndex: number;
	/** UTF-16 offsets into the exact stored chunk text, end exclusive. */
	start: number;
	end: number;
	quote: string;
}

export function prepareNovelSource(
	doc: Pick<CorpusDocument, "id" | "title" | "status" | "chars" | "chunkCount" | "workId">,
	storedText: string,
	chunkChars = CHUNK_CHARS,
	chunksOverride?: TextChunk[],
): NovelSource {
	if (doc.status !== "ready") throw new Error("小说尚未消化完成");
	if (!storedText.trim() || storedText.length !== doc.chars) throw new Error("小说原文与文档长度不一致");
	if (!Number.isSafeInteger(chunkChars) || chunkChars <= 0) throw new Error("无效分块大小");
	const chunks = chunksOverride ? chunksOverride.map((chunk, index) => ({ ...chunk, index })) : chunkText(splitChapters(storedText).chapters, chunkChars);
	if (chunks.length !== doc.chunkCount) throw new Error("小说分块布局不一致，需核对消化版本");
	return {
		version: 1, docId: doc.id, title: doc.title,
		fingerprint: createHash("sha256").update(storedText, "utf8").digest("hex"),
		chunkChars, chunks, ...(doc.workId ? { workId: doc.workId } : {}),
	};
}

/** Verifies a locator, not the truth of a model's interpretation of that locator. */
export function assertNovelEvidence(source: NovelSource, ref: NovelEvidence): void {
	const chunk = source.chunks.find(item => item.index === ref.chunkIndex);
	if (!chunk || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end)
		|| ref.start < 0 || ref.end <= ref.start || ref.end > chunk.text.length
		|| !ref.quote.trim() || chunk.text.slice(ref.start, ref.end) !== ref.quote) {
		throw new Error("原著证据定位无效");
	}
}

/** Stable within one source version; independent of extraction array position. */
export function novelNodeId(source: NovelSource, ref: NovelEvidence, key: string): string {
	assertNovelEvidence(source, ref);
	if (!key.trim()) throw new Error("节点键不能为空");
	const identity = [source.fingerprint, source.chunkChars, ref.chunkIndex, ref.start, ref.end, key.trim()];
	return `canon-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
}
