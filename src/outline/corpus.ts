/**
 * 小说长文消化管道（导演室研究库扩容，PLAN-NOVEL-DIGEST 阶段 1）。
 *
 * 责任边界：
 * - 解码 / 清洗 / 分章 / 分块为确定性纯函数（可导出声测）；
 * - CorpusEngine 串行单飞、断点续跑、预算闸门、暂停/恢复/删除/重试；
 * - 提示词正文零侵入：只读 workflow: novel-digest 的 Skill body。
 * - 产物唯一权威在 `.liyuan/outline/research/`（documents.json / texts / digests）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { firstZipEntry } from "../ziplite.ts";
import type { OutlineResearchExtraction } from "./research.ts";
import type { OutlineEngineDeps } from "./engine.ts";
import { fetchKakuyomuWork, kakuyomuDocumentId, normalizeKakuyomuWorkUrl, type KakuyomuRequest } from "./kakuyomu.ts";

// ---------- 常量与类型 ----------

// GLM 长上下文请求在网关上延迟明显；缩小单块让每次摘要更快返回并便于断点续跑。
export const CHUNK_CHARS = 10000;
export const CHUNK_CHARS_HARD_MAX = 50000;
export const MAX_CHUNKS = 600;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 文档数量不设上限；保留此导出名仅为兼容旧调用方。 */
export const MAX_DOCUMENTS = Number.POSITIVE_INFINITY;
export const ARC_CHUNK_BATCH = 50;
/** One final synopsis and three independent enhancement calls (audit is separate). */
export const ESTIMATE_FORMULA_TAIL = 4;

export type CorpusDocStatus = "pending" | "cleaning" | "mapping" | "reducing" | "extracting" | "ready" | "failed" | "paused";

/** Actual attempts are reserved durably before dispatch; never reset by resume/retry. */
export interface CorpusModelUsage {
	version: 1;
	attempts: number;
	limit: number;
	exhausted?: boolean;
	/** Old documents have unknown historic attempts; the counter starts at the explicit migration. */
	legacyAttemptsUnknown?: boolean;
}

export interface CorpusDocument {
	id: string;
	title: string;
	sourceKind: "upload" | "url";
	originName: string;
	chars: number;
	encoding: string;
	chapterCount: number;
	chunkCount: number;
	status: CorpusDocStatus;
	cardKey: string;
	error?: string;
	/** 大纲上下文投影用：ready 时由引擎写入梗概预览（≤400 字）。 */
	synopsisPreview?: string;
	/** ready 后提炼出的可复用套路条数。 */
	tropeCount?: number;
	/** ready 后提炼出的日常剧情卡条数。 */
	dailyPatternCount?: number;
	/** ready 后提炼出的可调度素材条数。 */
	assetCount?: number;
	createdAt: string;
	updatedAt: string;
	/** Stable work/version metadata. Optional for documents created before v2. */
	workId?: string;
	sourceFingerprint?: string;
	parentDocId?: string;
	sourceVersion?: number;
	updateRelation?: "initial" | "append-only" | "independent";
	modelUsage?: CorpusModelUsage;
	/** Existing document-level retry counter; independent of cumulative model attempts. */
	_retries?: number;
}

export interface CorpusProgress {
	step: CorpusDocStatus;
	done: number;
	total: number;
}

export interface CorpusChunkDigest {
	index: number;
	chars: number;
	chapters: string[];
	summary: string;
	fingerprint?: string;
}

export interface CorpusArcDigest {
	title: string;
	chunkRange: [number, number];
	summary: string;
}

export interface CorpusDigestStructure {
	plotSpine: string;
	characterArcs: string;
	hooksAndPacing: string;
}

type CorpusExtractTask = "digest-extract-mechanisms" | "digest-extract-daily" | "digest-extract-assets";
const EXTRACT_TASKS: CorpusExtractTask[] = ["digest-extract-mechanisms", "digest-extract-daily", "digest-extract-assets"];
type CorpusAuditVerdict = "supported" | "weak" | "unsupported";
interface CorpusPipelineCheckpoint {
	version: 1;
	inputHash: string;
	finalComplete?: boolean;
	extractions: {
		"digest-extract-mechanisms"?: CorpusTrope[] | null;
		"digest-extract-daily"?: CorpusDailyPattern[] | null;
		"digest-extract-assets"?: NarrativeAsset[] | null;
	};
	auditResults?: Array<{ index: number; verdict: CorpusAuditVerdict }>;
	materialized?: boolean;
	onReadyComplete?: boolean;
}

export interface CorpusDigest {
	version: 1;
	docId: string;
	chunks: CorpusChunkDigest[];
	arcs: CorpusArcDigest[];
	synopsis: string;
	structure: CorpusDigestStructure;
	extractedCount: number;
	dailyPatternCount?: number;
	dailyPatterns?: CorpusDailyPattern[];
	assets?: NarrativeAsset[];
	assetCount?: number;
	updatedAt: string;
	audit?: { approved: number; weak: number; rejected: number };
	layout?: TextChunk[];
	/** Optional versioned phase checkpoints; legacy digest/source/layout formats remain unchanged. */
	pipeline?: CorpusPipelineCheckpoint;
}

export interface CorpusTrope {
	mechanism: string;
	appliesWhen: string;
	failureWarning: string;
	locator: string;
	evidenceIds?: string[];
}
export interface CorpusDailyPattern { title: string; setting: string; surfaceActivity: string; initiative: string; sweetBeat: string; friction: string; misunderstanding: string; microChange: string; escalationLimit: string; naturalStop: string; failureWarning: string; locator: string; evidenceIds?: string[] }
export type NarrativeAssetKind = "scene-pattern" | "relationship-beat" | "dialogue-move";
export interface NarrativeAsset {
	kind: NarrativeAssetKind;
	title: string;
	mechanism: string;
	appliesWhen: string;
	failureWarning: string;
	opening: string;
	progression: string[];
	turn: string;
	stopPoint: string;
	relationshipStage: string;
	pressure: string;
	desiredExperience: string;
	locator: string;
	evidenceIds?: string[];
}

export interface CorpusEngineDeps {
	cwd: string;
	runSideModel: OutlineEngineDeps["runSideModel"];
	/** 取 workflow: novel-digest 的 Skill body；缺失返回 undefined（不再做第二次权威）。 */
	loadSkill: () => string | undefined;
	/** 建档时绑定当前卡；后续所有入库/重试/删除使用该快照，不动态读当前卡。 */
	cardKey: () => string;
	/** 提取完成入库钩子：由宿主把套路条目合并进研究库（documents + digests 由引擎自己落盘）。 */
	onReady?: (document: CorpusDocument, digest: CorpusDigest, extractions: OutlineResearchExtraction[]) => Promise<void>;
	/** 删除文档后清理研究库中只被该文档引用的机制条目；返回删除条数。 */
	onRemoved?: (docId: string) => Promise<number>;
	fetchText?: KakuyomuRequest;
}

interface CorpusJob {
	doc: CorpusDocument;
	status: CorpusProgress;
	/** Pause only wakes retry waits; in-flight providers still get to finish. */
	pauseController: AbortController;
}

const cleanText = (value: unknown, max = 2000): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const cleanList = (value: unknown, maxItems = 40, maxChars = 200): string[] => Array.isArray(value)
	? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, maxChars)] : []).slice(0, maxItems)
	: [];

/** Keep actionable provider diagnostics without persisting credentials or unbounded response text. */
const safeModelError = (value: unknown, max = 300): string => {
	const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "未知模型错误");
	return raw
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]")
		.replace(/([?&](?:api[_-]?key|key|token)=)[^&#\s]*/gi, "$1[REDACTED]")
		.replace(/\b(api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max) || "未知模型错误";
};

const parseObject = (text: string): Record<string, unknown> | null => {
	for (const candidate of [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try { const value = JSON.parse(candidate); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
	}
	return null;
};

/** 严格 JSON 失败时，保留模型返回的有效字符串字段。 */
const textField = (raw: string, key: string, max: number): string => {
	const parsed = parseObject(raw);
	const strict = parsed && cleanText(parsed[key], max);
	if (strict) return strict;
	const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "s"))?.[1];
	if (!match) return "";
	try { return JSON.parse(`"${match}"`).trim().slice(0, max); } catch { return match.trim().slice(0, max); }
};

export const corpusRoot = (cwd: string): string => join(cwd, ".liyuan", "outline", "research", "corpus");
export const corpusTextsDir = (cwd: string): string => join(corpusRoot(cwd), "texts");
export const corpusDigestsDir = (cwd: string): string => join(corpusRoot(cwd), "digests");
export const corpusDocumentsFile = (cwd: string): string => join(corpusRoot(cwd), "documents.json");

export function loadCorpusDocuments(cwd: string): CorpusDocument[] {
	try {
		const value = JSON.parse(readFileSync(corpusDocumentsFile(cwd), "utf8"));
		return Array.isArray(value) ? value as CorpusDocument[] : [];
	} catch { return []; }
}

// ---------- 确定性纯函数（导出声测） ----------

/** utf-8 严格优先；失败退 gb18030，再 big5；全会失败按 utf-8(lossy) 兜底。 */
export function decodeText(bytes: Buffer): { text: string; encoding: string } {
	for (const enc of ["utf-8", "gb18030", "big5"] as const) {
		try { return { text: new TextDecoder(enc, { fatal: true }).decode(bytes), encoding: enc }; } catch { /* 下一种 */ }
	}
	return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8(lossy)" };
}

const WATERMARK_BLOCK_RE = /(?:本书首发|首发域名|笔趣|leshu|feiku|最新章节|请记住|无弹窗|广告|域名一|域名二)/i;
const NAV_BLOCK_RE = /(?:上一章|下一章|返回目录|目录\s*页|加入书签|书页|章节错误|点此举报|报错)/i;

/** 逐行过滤站点水印/站内导航/空洞行；不去重、不改写正文。 */
export function cleanTextLayer(text: string): string {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	for (let raw of lines) {
		const line = raw.trim();
		if (!line.length) { kept.push(""); continue; }
		const hit = WATERMARK_BLOCK_RE.test(line) || NAV_BLOCK_RE.test(line);
		if (hit) continue;
		kept.push(raw);
	}
	// 连续空行压成单个换行
	let result = "";
	let blank = 0;
	for (const line of kept) {
		if (!line.trim()) { blank++; if (blank > 1) continue; }
		else blank = 0;
		result += line + "\n";
	}
	return result.replace(/\n{2,}/g, "\n\n").trimEnd() + "\n";
}

const CHAPTER_RE = /^\s*(?:第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章节卷回部集话話幕]|(?:序章|序言|楔子|尾声|后记|番外))\s*[:：\s\S]{0,40}$/;

export interface ChapterBlock { title: string; lines: string[] }

/** 逐行扫描切章；命中 <5 视为无章节结构。 */
export function splitChapters(text: string): { chapters: ChapterBlock[]; detected: boolean } {
	const lines = text.split(/\r?\n/);
	const blocks: ChapterBlock[] = [];
	let current: ChapterBlock | null = null;
	for (const line of lines) {
		if (CHAPTER_RE.test(line)) {
			current = { title: line.trim(), lines: [] };
			blocks.push(current);
			continue;
		}
		if (!current) current = { title: "", lines: [] };
		current.lines.push(line);
	}
	if (!blocks.length && current) blocks.push(current);
	const titles = blocks.map((b) => b.title).filter((t) => !!t);
	if (titles.length < 5) {
		// 无结构：全文当成单节（后续定长切块）
		return { chapters: [{ title: "", lines: lines }], detected: false };
	}
	return { chapters: blocks, detected: true };
}

export interface TextChunk { index: number; chars: number; chapters: string[]; text: string }

/** 贪心装箱分块：整章累加，超限封块；单章超限在段落边界二分。 */
export function chunkText(chapters: ChapterBlock[], chunkChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS): TextChunk[] {
	const chunks: TextChunk[] = [];
	let buffer: string[] = [];
	let bufferChars = 0;
	let currentTitles: string[] = [];
	const flush = () => {
		if (!buffer.length) return;
		const text = buffer.join("\n\n");
		chunks.push({ index: chunks.length, chars: text.length, chapters: [...currentTitles], text });
		buffer = []; bufferChars = 0; currentTitles = [];
	};
	const pushLines = (title: string, lines: string[]) => {
		let text = lines.join("\n").trim();
		if (!text.length) return;
		const pair = title ? `${title}\n${text}` : text;
		if (bufferChars + pair.length <= chunkChars) {
			buffer.push(pair); bufferChars += pair.length;
			if (title && !currentTitles.includes(title)) currentTitles.push(title);
			return;
		}
		// 当前块已满，先封
		flush();
		if (pair.length <= chunkChars) {
			buffer.push(pair); bufferChars += pair.length;
			if (title) currentTitles.push(title);
			return;
		}
		// 单章超限：段落边界二分硬切
		const paragraphs = text.split(/\n\n+/);
		let seg: string[] = [];
		let segChars = 0;
		for (const para of paragraphs) {
			const candidate = seg.length ? `${seg.join("\n\n")}\n\n${para}` : para;
			if (segChars + para.length + 2 > chunkChars && seg.length) {
				flushSeg(title);
				seg = [para]; segChars = para.length;
				continue;
			}
			seg.push(para); segChars += para.length;
		}
		if (seg.length) flushSeg(title);
		function flushSeg(t: string) {
			const part = seg.join("\n\n");
			chunks.push({ index: chunks.length, chars: part.length, chapters: t ? [t] : [], text: part });
			seg = []; segChars = 0;
		}
	};
	for (const chapter of chapters) pushLines(chapter.title, chapter.lines);
	flush();
	if (chunks.length > maxChunks) {
		throw new Error(`文档过大：超过 ${maxChunks} 块上限`);
	}
	return chunks.map((c, index) => ({ ...c, index }));
}

/** epub → 同 txt 结构的纯文本（复用 ziplite，零新依赖）。 */
export function epubToText(data: Buffer): string {
	const container = firstZipEntry(data, (entry) => /^META-INF\/container\.xml$/i.test(entry.name));
	if (!container) throw new Error("epub 缺少 META-INF/container.xml");
	const containerXml = container.data.toString("utf8");
	const opfMatch = /full-path="([^"]+)"/i.exec(containerXml);
	if (!opfMatch) throw new Error("epub container.xml 缺少 opf 路径");
	const opfEntry = firstZipEntry(data, (entry) => entry.name.replace(/\\/g, "/") === opfMatch[1]);
	if (!opfEntry) throw new Error(`epub 缺少 opf：${opfMatch[1]}`);
	const opfXml = opfEntry.data.toString("utf8");
	const manifest = new Map<string, string>();
	for (const m of opfXml.matchAll(/item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)) manifest.set(m[1], m[2]);
	for (const m of opfXml.matchAll(/item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)) manifest.set(m[2], m[1]);
	const spineIds: string[] = [];
	for (const s of opfXml.matchAll(/itemref\s+[^>]*idref="([^"]+)"/g)) spineIds.push(s[1]);
	const base = opfMatch[1].split("/").slice(0, -1).join("/");
	const parts: string[] = [];
	for (const id of spineIds) {
		const href = manifest.get(id);
		if (!href) continue;
		const rel = href.replace(/\\/g, "/");
		const name = base ? `${base}/${rel}` : rel;
		const entry = firstZipEntry(data, (e) => e.name.replace(/\\/g, "/") === name.replace(/^\.\//, ""));
		if (!entry) continue;
		parts.push(spineXhtmlToText(entry.data.toString("utf8")));
	}
	const text = parts.filter((p) => p.trim()).join("\n\n");
	if (text.trim().length < 100) throw new Error("epub 正文过短，无法解析");
	return text;
}

function spineXhtmlToText(xhtml: string): string {
	// 章节标题：h1-h6
	let chapterTitle = "";
	for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xhtml);
		if (m) { chapterTitle = m[1].replace(/<[^>]+>/g, "").trim(); break; }
	}
	const body = decodeHtmlEntities(xhtml
		.replace(/<(?:script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/div>/gi, "\n")
		.replace(/<li>/gi, "\n- ")
		.replace(/<[^>]+>/g, "")
		.trim());
	const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean).join("\n\n");
	return chapterTitle ? `${chapterTitle}\n\n${lines}` : lines;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Successful path only; reserve one possible audit by default, retries spend the hard budget too. */
export function estimateCallsForChunks(chunkCount: number, includeAudit = true): number {
	return chunkCount + Math.ceil(chunkCount / ARC_CHUNK_BATCH) + ESTIMATE_FORMULA_TAIL + (includeAudit ? 1 : 0);
}

// ---------- 文档级有界并行 + 研究库串行提交 ----------

function safeKey(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function textFingerprint(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export class CorpusEngine {
	// 大块摘要请求耗时较长；单飞避免同一网关并发时互相挤掉，三部仍会依次处理。
	static readonly MAX_ACTIVE_DOCUMENTS = 1;
	#deps: CorpusEngineDeps;
	#queue = new Set<string>();
	#jobs = new Map<string, CorpusJob & { promise: Promise<void> }>();
	#abort = new Map<string, AbortController>();
	#removing = new Set<string>();
	#docs: Map<string, CorpusDocument>;
	#maxCallsPerDoc: number;

	constructor(deps: CorpusEngineDeps, maxCallsPerDoc = 800) {
		this.#deps = deps;
		if (!Number.isSafeInteger(maxCallsPerDoc) || maxCallsPerDoc < 0) throw new Error("maxCallsPerDoc 必须为非负安全整数");
		this.#maxCallsPerDoc = maxCallsPerDoc;
		this.#docs = new Map(loadCorpusDocuments(deps.cwd).map((doc) => [doc.id, doc]));
	}

	/** 队列快照：documents + 当前运行进度。 */
	view(): { documents: CorpusDocument[]; running?: Array<{ docId: string; step: string; done: number; total: number }> } {
		const documents = [...this.#docs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const running = [...this.#jobs.values()].map((job) => ({ docId: job.doc.id, step: job.status.step, done: job.status.done, total: job.status.total }));
		return { documents, ...(running.length ? { running } : {}) };
	}

	/** 等待已经入队的文档全部完成（含自动重试产生的新任务）。 */
	async waitIdle(): Promise<void> {
		while (this.#queue.size || this.#jobs.size) {
			const jobs = [...this.#jobs.values()].map((job) => job.promise);
			if (jobs.length) await Promise.all(jobs);
			else await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	getDoc(id: string): CorpusDocument | undefined { return this.#docs.get(id); }

	/** 服务重启恢复：把未完成的活跃任务重新入队（断点续跑，跳过已完成块）。 */
	restore(): void {
		for (const doc of this.#docs.values()) {
			if (["pending", "cleaning", "mapping", "reducing", "extracting"].includes(doc.status)) {
				doc.status = "pending";
				this.#enqueue(doc.id);
			}
		}
	}

	/** GET /corpus/:id 详情：ready 才返回 digest 全文，其余只返回文档与进度。 */
	getDetail(id: string): { doc: CorpusDocument; digest: CorpusDigest | null } {
		const doc = this.#docs.get(id);
		if (!doc) throw new Error("文档不存在");
		return { doc, digest: doc.status === "ready" ? this.#readDigest(doc.id) : null };
	}

	/** 建档：校验存在/类型/大小 → 复制 → 落 documents.json → 唤醒并行池。幂等按 originName+size。 */
	async create(uploadName: string): Promise<{ doc: CorpusDocument; estimatedCalls: number }> {
		const dir = join(this.#deps.cwd, ".liyuan-uploads");
		const stripped = uploadName.replace(/\\/g, "/").replace(/^\.(?:liyuan|rp)-uploads\//, "");
		const base = basename(stripped);
		if (!base || base.includes("/") || base.includes("..") || base.startsWith(".")) throw new Error("非法文件名");
		const src = join(dir, base);
		if (!existsSync(src)) throw new Error("文件不存在（请先经上传区上传）");
		const ext = extname(base).toLowerCase();
		if (![".txt", ".epub"].includes(ext)) throw new Error("仅支持 .txt / .epub");
		const bytes = readFileSync(src);
		if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
		const stableId = `doc-${createHash("sha256").update(`${base}\n${bytes.length}`).digest("hex").slice(0, 16)}`;
		const existing = this.#docs.get(stableId);
		if (existing) return { doc: existing, estimatedCalls: existing.chunkCount ? estimateCallsForChunks(existing.chunkCount) : 0 };
		const { text, encoding } = decodeText(bytes);
		const cleaned = ext === ".epub" ? cleanTextLayer(epubToText(bytes)) : cleanTextLayer(text);
		const sourceFingerprint = textFingerprint(cleaned);
		const { chapters, detected } = splitChapters(cleaned);
		const chunks = chunkText(chapters, CHUNK_CHARS, MAX_CHUNKS);
		const estimatedCalls = estimateCallsForChunks(chunks.length);
		if (estimatedCalls > this.#maxCallsPerDoc) throw new Error(`预计需要约 ${estimatedCalls} 次模型调用，超过上限 ${this.#maxCallsPerDoc}；请换更短文本`);

		const workDir = join(corpusRoot(this.#deps.cwd), "work");
		mkdirSync(workDir, { recursive: true });
		rmSync(join(workDir, `${stableId}.raw`), { force: true });
		writeFileSync(join(workDir, `${stableId}.raw`), bytes);

		const cardKey = this.#deps.cardKey();
		const now = new Date().toISOString();
		const doc: CorpusDocument = {
			id: stableId,
			title: base.replace(/\.[^.]+$/, "").slice(0, 120),
			sourceKind: "upload",
			originName: base,
			chars: cleaned.length,
			encoding,
			chapterCount: detected ? chapters.length : 0,
			chunkCount: chunks.length,
			status: "pending",
			cardKey,
			createdAt: now,
			updatedAt: now,
			workId: `work-${sourceFingerprint.slice(0, 24)}`,
			sourceFingerprint,
			sourceVersion: 1,
			updateRelation: "initial",
			modelUsage: { version: 1, attempts: 0, limit: this.#maxCallsPerDoc },
		};
		this.#docs.set(doc.id, doc);
		this.#persistDocuments();
		this.#enqueue(doc.id);
		return { doc, estimatedCalls };
	}

	/** Creates an immutable append-only source version without touching the parent document. */
	async createVersion(baseDocId: string, uploadName: string): Promise<{ doc: CorpusDocument; estimatedCalls: number; reusedChunks: number; newChunks: number }> {
		const base = this.#docs.get(baseDocId);
		if (!base) throw new Error("基础小说文档不存在");
		if (base.status !== "ready") throw new Error("基础小说尚未消化完成");
		const dir = join(this.#deps.cwd, ".liyuan-uploads");
		const stripped = uploadName.replace(/\\/g, "/").replace(/^\.(?:liyuan|rp)-uploads\//, "");
		const baseName = basename(stripped);
		if (!baseName || baseName.includes("/") || baseName.includes("..") || baseName.startsWith(".")) throw new Error("非法文件名");
		const src = join(dir, baseName);
		if (!existsSync(src)) throw new Error("文件不存在（请先经上传区上传）");
		const ext = extname(baseName).toLowerCase();
		if (![".txt", ".epub"].includes(ext)) throw new Error("仅支持 .txt / .epub");
		const bytes = readFileSync(src);
		if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
		const decoded = decodeText(bytes);
		const cleaned = ext === ".epub" ? cleanTextLayer(epubToText(bytes)) : cleanTextLayer(decoded.text);
		const oldTextPath = join(corpusTextsDir(this.#deps.cwd), `${base.id}.txt`);
		if (!existsSync(oldTextPath)) throw new Error("基础小说原文不存在");
		const oldText = readFileSync(oldTextPath, "utf8");
		if (cleaned === oldText) return { doc: base, estimatedCalls: 0, reusedChunks: base.chunkCount, newChunks: 0 };
		if (!cleaned.startsWith(oldText) || cleaned.length <= oldText.length) throw new Error("新版原文不是旧版原文的逐字追加版本");
		const sourceFingerprint = textFingerprint(cleaned);
		const workId = base.workId ?? `work-${textFingerprint(oldText).slice(0, 24)}`;
		const docId = `doc-${safeKey(JSON.stringify(["corpus-v2", workId, sourceFingerprint])).slice(0, 16)}`;
		const existing = this.#docs.get(docId);
		if (existing) return { doc: existing, estimatedCalls: existing.chunkCount ? estimateCallsForChunks(existing.chunkCount) : 0, reusedChunks: existing.chunkCount, newChunks: 0 };
		const { chapters, detected } = splitChapters(cleaned);
		const oldDigest = this.#readDigest(base.id);
		const oldChunks = oldDigest?.layout?.length ? oldDigest.layout : chunkText(splitChapters(oldText).chapters, CHUNK_CHARS, MAX_CHUNKS);
		const suffixChunks = chunkText([{ title: "", lines: [cleaned.slice(oldText.length)] }], CHUNK_CHARS, MAX_CHUNKS - oldChunks.length)
			.map((chunk, index) => ({ ...chunk, index: oldChunks.length + index }));
		const chunks = [...oldChunks, ...suffixChunks];
		const reused = chunks.reduce((count, chunk, index) => count + (oldChunks[index]?.text === chunk.text && !!oldDigest?.chunks.find(item => item.index === index && !isFailedChunkSummary(item.summary))?.summary ? 1 : 0), 0);
		const estimatedCalls = estimateCallsForChunks(chunks.length) - reused;
		if (estimatedCalls > this.#maxCallsPerDoc) throw new Error(`预计需要约 ${estimatedCalls} 次模型调用，超过上限 ${this.#maxCallsPerDoc}；请换更短文本`);
		const now = new Date().toISOString();
		const doc: CorpusDocument = {
			id: docId, title: base.title, sourceKind: "upload", originName: baseName, chars: cleaned.length,
			encoding: decoded.encoding, chapterCount: detected ? chapters.length : 0, chunkCount: chunks.length,
			status: "pending", cardKey: base.cardKey, createdAt: now, updatedAt: now,
			workId, sourceFingerprint, parentDocId: base.id, sourceVersion: (base.sourceVersion ?? 1) + 1, updateRelation: "append-only",
			modelUsage: { version: 1, attempts: 0, limit: this.#maxCallsPerDoc },
		};
		const workDir = join(corpusRoot(this.#deps.cwd), "work");
		mkdirSync(workDir, { recursive: true });
		writeFileSync(join(workDir, `${docId}.raw`), bytes);
		mkdirSync(corpusTextsDir(this.#deps.cwd), { recursive: true });
		writeFileSync(join(corpusTextsDir(this.#deps.cwd), `${docId}.txt`), cleaned, "utf8");
		const inheritedChunks = chunks.flatMap((chunk, index) => {
			const old = oldChunks[index];
			const digest = oldDigest?.chunks.find(item => item.index === index);
			return old?.text === chunk.text && digest?.summary && !isFailedChunkSummary(digest.summary) ? [{ ...digest, chars: chunk.chars, chapters: chapterTitles(chunk.chapters, chunk.text), fingerprint: textFingerprint(chunk.text) }] : [];
		});
		this.#writeDigest(docId, { version: 1, docId, chunks: inheritedChunks, layout: chunks, arcs: [], synopsis: "", structure: { plotSpine: "", characterArcs: "", hooksAndPacing: "" }, extractedCount: 0, updatedAt: now });
		this.#docs.set(docId, doc); this.#persistDocuments(); this.#enqueue(docId);
		return { doc, estimatedCalls, reusedChunks: reused, newChunks: chunks.length - reused };
	}

	/** 建立 Kakuyomu URL 文档：抓取完成后进入与上传文件相同的消化链。 */
	async createUrl(value: string): Promise<{ doc: CorpusDocument; estimatedCalls: number }> {
		if (!this.#deps.fetchText) throw new Error("当前环境未配置网页抓取能力");
		const normalizedUrl = normalizeKakuyomuWorkUrl(value).toString(), id = kakuyomuDocumentId(normalizedUrl), existing = this.#docs.get(id);
		if (existing) return { doc: existing, estimatedCalls: existing.chunkCount ? estimateCallsForChunks(existing.chunkCount) : 0 };
		const now = new Date().toISOString(), doc: CorpusDocument = { id, title: normalizedUrl.slice(0, 120), sourceKind: "url", originName: normalizedUrl, chars: 0, encoding: "utf-8", chapterCount: 0, chunkCount: 0, status: "pending", cardKey: this.#deps.cardKey(), createdAt: now, updatedAt: now, modelUsage: { version: 1, attempts: 0, limit: this.#maxCallsPerDoc } };
		this.#docs.set(id, doc); this.#persistDocuments(); this.#enqueue(id);
		return { doc, estimatedCalls: 0 };
	}

	status(): { running?: Array<{ docId: string; step: string; done: number; total: number }> } { return this.view(); }

	/** 当前已发出的调用完成并保存 checkpoint 后停；不再启动后续调用或重试。 */
	pause(docId: string): void {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		if (!["pending", "cleaning", "mapping", "reducing", "extracting"].includes(doc.status)) throw new Error("非运行态不可暂停");
		doc.status = "paused"; this.#jobs.get(docId)?.pauseController.abort(); this.#queue.delete(docId); this.#persistDocuments();
	}

	resume(docId: string): void {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		if (!["paused", "failed"].includes(doc.status)) throw new Error("文档当前状态不可恢复");
		const usage = this.#usage(doc);
		if (usage.exhausted && usage.attempts >= usage.limit) {
			this.#persistDocuments();
			throw new Error(`调用预算已耗尽（${usage.attempts}/${usage.limit}）；请明确提高 novelDigest.maxCallsPerDoc 后再恢复`);
		}
		delete usage.exhausted;
		const job = this.#jobs.get(docId);
		if (job?.doc === doc) job.pauseController = new AbortController();
		delete doc.error;
		delete doc._retries;
		doc.status = "pending"; this.#persistDocuments();
		this.#enqueue(docId);
	}

	retry(docId: string): void {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		if (doc.status !== "failed") throw new Error("仅失败文档可重试");
		this.resume(docId);
	}

	async remove(docId: string): Promise<number> {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		// 同 ID 的重建需等旧文档清理结算后才能启动。
		this.#removing.add(docId);
		try {
			this.#abort.get(docId)?.abort();
			this.#docs.delete(docId); this.#queue.delete(docId);
			this.#persistDocuments();
			for (const dir of [corpusTextsDir(this.#deps.cwd), corpusDigestsDir(this.#deps.cwd), join(corpusRoot(this.#deps.cwd), "work")]) {
				rmSync(join(dir, `${docId}.txt`), { force: true });
				rmSync(join(dir, `${docId}.json`), { force: true });
				rmSync(join(dir, `${docId}.raw`), { force: true });
			}
			// An already-started publication cannot be rolled back here. Wait for
			// it before research cleanup, so a late onReady cannot recreate entries.
			const job = this.#jobs.get(docId);
			if (job?.doc === doc) await job.promise;
			try { return await this.#deps.onRemoved?.(docId) ?? 0; } catch { return 0; }
		} finally { this.#removing.delete(docId); this.#pump(); }
	}

	listTexts(): string[] { return existsSync(corpusTextsDir(this.#deps.cwd)) ? readdirSync(corpusTextsDir(this.#deps.cwd)).filter((f) => f.endsWith(".txt")) : []; }

	// ---------- 内部 ----------

	#persistDocuments(): void {
		const path = corpusDocumentsFile(this.#deps.cwd);
		mkdirSync(corpusRoot(this.#deps.cwd), { recursive: true });
		this.#atomic(path, [...this.#docs.values()]);
	}

	#atomic(path: string, value: unknown): void {
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}

	#enqueue(docId: string): void {
		if (!this.#docs.has(docId) || this.#queue.has(docId)) return;
		this.#queue.add(docId);
		this.#pump();
	}

	#pump(): void {
		while (this.#jobs.size < CorpusEngine.MAX_ACTIVE_DOCUMENTS && this.#queue.size) {
			const docId = [...this.#queue].find(id => !this.#jobs.has(id) && !this.#removing.has(id));
			if (!docId) break;
			this.#queue.delete(docId);
			const doc = this.#docs.get(docId);
			if (!doc || doc.status !== "pending") continue;
			const job: CorpusJob & { promise: Promise<void> } = { doc, status: { step: doc.status, done: 0, total: 0 }, pauseController: new AbortController(), promise: Promise.resolve() };
			this.#jobs.set(docId, job);
			this.#abort.set(docId, new AbortController());
			job.promise = Promise.resolve().then(() => this.#process(docId)).catch(error => {
				this.#fail(doc, safeModelError(error), false);
			}).finally(() => {
				this.#jobs.delete(docId);
				this.#abort.delete(docId);
				this.#pump();
			});
		}
	}

	async #process(docId: string): Promise<void> {
		const doc = this.#docs.get(docId);
		if (!doc || !this.#canContinue(doc)) return;
		const usage = this.#usage(doc);
		this.#persistDocuments();
		if (usage.exhausted) { this.#budgetExceeded(doc); return; }
		const skill = this.#deps.loadSkill();
		if (!skill) { this.#fail(doc, "缺少 workflow: novel-digest 的 Skill"); return; }
		const digest: CorpusDigest = this.#readDigest(docId) ?? { version: 1, docId, chunks: [], arcs: [], synopsis: "", structure: { plotSpine: "", characterArcs: "", hooksAndPacing: "" }, extractedCount: 0, updatedAt: new Date().toISOString() };
		if (digest.pipeline && (digest.pipeline.version !== 1 || typeof digest.pipeline.inputHash !== "string" || !digest.pipeline.extractions || typeof digest.pipeline.extractions !== "object" || Array.isArray(digest.pipeline.extractions))) throw new Error("无效或不支持的 Corpus pipeline checkpoint 版本");
		const textsPath = join(corpusTextsDir(this.#deps.cwd), `${docId}.txt`);
		const rawPath = join(corpusRoot(this.#deps.cwd), "work", `${docId}.raw`);
		let rawBytes = existsSync(rawPath) ? readFileSync(rawPath) : null;
		if (doc.sourceKind === "url" && !rawBytes) {
			if (!this.#deps.fetchText) { this.#fail(doc, "当前环境未配置网页抓取能力"); return; }
			if (!this.#advance(doc, "cleaning")) return;
			try {
				const signal = this.#signal(docId);
				const fetched = await withAbort(fetchKakuyomuWork(doc.originName, this.#deps.fetchText, signal), signal);
				if (!this.#isLive(doc)) return;
				rawBytes = Buffer.from(fetched.text, "utf8");
				doc.title = fetched.work.title.slice(0, 120);
				doc.encoding = "utf-8";
				mkdirSync(join(corpusRoot(this.#deps.cwd), "work"), { recursive: true });
				writeFileSync(rawPath, rawBytes);
				this.#persistDocuments();
				if (!this.#canContinue(doc)) return;
			} catch (error) {
				this.#fail(doc, error instanceof Error ? error.message : String(error));
				return;
			}
		}
		let text = existsSync(textsPath) ? readFileSync(textsPath, "utf8") : "";
		if (!text && rawBytes) {
			const { text: decoded } = decodeText(rawBytes);
			if (extname(doc.originName).toLowerCase() === ".epub") text = cleanTextLayer(epubToText(rawBytes));
			else text = cleanTextLayer(decoded);
			mkdirSync(corpusTextsDir(this.#deps.cwd), { recursive: true });
			writeFileSync(textsPath, text, "utf8");
		}
		if (!text) { this.#fail(doc, "清洗后文本为空"); return; }
		const { chapters, detected } = splitChapters(text);
		const chunks = digest.layout?.length ? digest.layout : chunkText(chapters, CHUNK_CHARS, MAX_CHUNKS);
		// 元数据唯一权威是落盘正文：URL 抓取原文与旧版恢复留下的计数都可能偏大，
		// 在进入 mapping 前对齐并落盘，让恢复中的旧元数据自愈。
		const chapterCount = detected ? chapters.length : 0;
		if (doc.chars !== text.length || doc.chunkCount !== chunks.length || doc.chapterCount !== chapterCount) {
			doc.chars = text.length;
			doc.chunkCount = chunks.length;
			doc.chapterCount = chapterCount;
			this.#persistDocuments();
		}

		const job = this.#jobs.get(docId);
		if (!job || !this.#advance(doc, "mapping")) return;
		job.status = { step: "mapping", done: digest.chunks.length, total: chunks.length };

		// Completed calls may checkpoint while paused, but only a live job may write.
		// A pause never authorizes another call/retry or a transition into ready.
		for (const chunk of chunks) {
			if (!this.#canContinue(doc)) return;
			const fingerprint = textFingerprint(chunk.text);
			if (digest.chunks.some(c => c.index === chunk.index && c.fingerprint === fingerprint && !isFailedChunkSummary(c.summary))) continue;
			job.status = { step: "mapping", done: digest.chunks.length, total: chunks.length };
			const summaryOf = (raw: string): string => {
				const parsed = parseObject(raw);
				const summary = parsed && cleanText(parsed.summary, 1500);
				if (summary) return summary;
				const match = raw.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)/s)?.[1];
				if (match) { try { return JSON.parse(`"${match}"`).trim().slice(0, 1500); } catch {} }
				return Array.isArray(parsed?.chapters) ? "（本块无摘要）" : "";
			};
			const request = JSON.stringify({ task: "digest-map", doc_title: doc.title, chunk: { index: chunk.index, chapters: chunk.chapters, text: chunk.text.slice(0, CHUNK_CHARS) } });
			let result = await this.#call(docId, skill, request, 4096);
			if (!this.#isLive(doc)) return;
			let summary = typeof result === "string" ? summaryOf(result) : "";
			// Provider errors already have a bounded retry loop in #call. Parse retries
			// only apply to successful text, and pause/delete/budget stop both loops.
			if (!summary && typeof result === "string" && this.#canContinue(doc)) {
				result = await this.#call(docId, skill, request, 4096);
				if (!this.#isLive(doc)) return;
				summary = typeof result === "string" ? summaryOf(result) : "";
			}
			if (!summary) {
				if (!this.#canContinue(doc)) return;
				const reason = typeof result === "string" ? "模型响应缺少可解析的 summary 字段" : safeModelError(result.error);
				console.error(`[corpus] 块 ${chunk.index} 摘要失败：${reason}`);
				digest.chunks = digest.chunks.filter(c => c.index !== chunk.index);
				digest.chunks.push({ index: chunk.index, chars: chunk.chars, chapters: chapterTitles(chunk.chapters, chunk.text), summary: "(本块摘要生成失败，仅保留章节列表)", fingerprint });
				this.#checkpoint(doc, digest);
				this.#fail(doc, `第 ${chunk.index + 1} 块摘要生成失败：${reason}`);
				return;
			}
			digest.chunks = digest.chunks.filter(c => c.index !== chunk.index);
			digest.chunks.push({ index: chunk.index, chars: chunk.chars, chapters: chapterTitles(chunk.chapters, chunk.text), summary, fingerprint });
			digest.chunks.sort((a, b) => a.index - b.index);
			// A regenerated map invalidates downstream results; immutable appended
			// documents still inherit only their source-matching map checkpoints.
			digest.arcs = []; digest.synopsis = "";
			digest.structure = { plotSpine: "", characterArcs: "", hooksAndPacing: "" };
			delete digest.pipeline;
			this.#checkpoint(doc, digest);
			if (!this.#canContinue(doc)) return;
		}
		if (!this.#canContinue(doc)) return;
		digest.chunks = chunks.map(chunk => digest.chunks.find(c => c.index === chunk.index && c.fingerprint === textFingerprint(chunk.text) && !isFailedChunkSummary(c.summary))!);
		const inputHash = textFingerprint(JSON.stringify(digest.chunks));
		let pipeline = digest.pipeline;
		if (pipeline && pipeline.version !== 1) throw new Error("不支持的 Corpus pipeline checkpoint 版本");
		if (!pipeline || pipeline.inputHash !== inputHash) {
			const legacyFinal = !pipeline && !!digest.synopsis;
			if (pipeline) { digest.arcs = []; digest.synopsis = ""; digest.structure = { plotSpine: "", characterArcs: "", hooksAndPacing: "" }; }
			pipeline = { version: 1, inputHash, ...(legacyFinal ? { finalComplete: true } : {}), extractions: {} };
			digest.pipeline = pipeline;
			this.#checkpoint(doc, digest);
		}

		const phases = pipeline;
		if (!this.#advance(doc, "reducing")) return;
		for (let start = 0; start < chunks.length; start += ARC_CHUNK_BATCH) {
			if (!this.#canContinue(doc)) return;
			const end = Math.min(start + ARC_CHUNK_BATCH, chunks.length) - 1;
			if (digest.arcs.some(arc => arc.chunkRange[0] === start && arc.chunkRange[1] === end && arc.summary)) continue;
			const batch = digest.chunks.slice(start, end + 1).map(chunk => chunk.summary);
			const title = batch.length < ARC_CHUNK_BATCH ? `收尾段（块 ${start}–${end}）` : `第 ${start / ARC_CHUNK_BATCH + 1} 段（块 ${start}–${end}）`;
			const raw = await this.#call(docId, skill, JSON.stringify({ task: "digest-reduce-arc", doc_title: doc.title, arc_title: title, chunk_summaries: batch }), 4096);
			if (!this.#isLive(doc)) return;
			const summary = typeof raw === "string" ? textField(raw, "summary", 2000) : "";
			if (summary) {
				digest.arcs.push({ title, chunkRange: [start, end], summary });
				digest.arcs.sort((a, b) => a.chunkRange[0] - b.chunkRange[0]);
				this.#checkpoint(doc, digest);
			}
			if (!this.#canContinue(doc)) return;
			if (!summary) { this.#fail(doc, "弧线摘要生成失败"); return; }
		}

		if (!this.#advance(doc, "extracting")) return;
		if (!phases.finalComplete) {
			const user = JSON.stringify({ task: "digest-reduce-final", doc_title: doc.title, arc_summaries: digest.arcs.map(arc => arc.summary) });
			let raw = await this.#call(docId, skill, user, 8192);
			if (!this.#isLive(doc)) return;
			let parsed = typeof raw === "string" ? parseObject(raw) : null;
			if (!parsed && typeof raw === "string" && this.#canContinue(doc)) {
				raw = await this.#call(docId, skill, user, 8192);
				if (!this.#isLive(doc)) return;
				parsed = typeof raw === "string" ? parseObject(raw) : null;
			}
			const synopsis = typeof raw === "string" ? textField(raw, "synopsis", 3000) : "";
			if (parsed || synopsis) {
				const structure = parsed?.structure && typeof parsed.structure === "object" && !Array.isArray(parsed.structure) ? parsed.structure as Record<string, unknown> : {};
				digest.synopsis = synopsis;
				digest.structure = { plotSpine: cleanText(structure.plotSpine, 2000), characterArcs: cleanText(structure.characterArcs, 2000), hooksAndPacing: cleanText(structure.hooksAndPacing, 2000) };
				phases.finalComplete = true;
				this.#checkpoint(doc, digest);
			}
			if (!this.#canContinue(doc)) return;
			if (!phases.finalComplete) { this.#fail(doc, "全书梗概生成失败"); return; }
		}
		if (!this.#canContinue(doc)) return;

		const evidenceIndex = [
			...digest.chunks.map(chunk => ({ id: `chunk-${chunk.index + 1}`, kind: "chunk", locator: corpusChunkLocator(chunk), summary: chunk.summary })),
			...digest.arcs.map((arc, index) => ({ id: `arc-${index + 1}`, kind: "arc", locator: corpusArcLocator(arc, digest.chunks), summary: arc.summary })),
		];
		const evidenceById = new Map(evidenceIndex.map(item => [item.id, item]));
		const extractInput = { doc_title: doc.title, synopsis: digest.synopsis, structure: digest.structure, evidence_index: evidenceIndex };
		await Promise.all(EXTRACT_TASKS.map(async task => {
			if (task in phases.extractions || !this.#canContinue(doc)) return;
			const user = JSON.stringify({ task, ...extractInput });
			let raw = await this.#call(docId, skill, user, 8192);
			if (!this.#isLive(doc)) return;
			let parsed = typeof raw === "string" ? parseObject(raw) : null;
			if (!parsed && typeof raw === "string" && this.#canContinue(doc)) {
				raw = await this.#call(docId, skill, user, 8192);
				if (!this.#isLive(doc)) return;
				parsed = typeof raw === "string" ? parseObject(raw) : null;
			}
			// A denied budget reservation/paused failed response is unfinished, not a
			// degraded completed task. Successful siblings may still save their result.
			if (!parsed && !this.#canContinue(doc)) return;
			const part = parsed ? parseCorpusExtractions(parsed, evidenceById) : null;
			if (task === "digest-extract-mechanisms") phases.extractions[task] = part?.tropes ?? null;
			if (task === "digest-extract-daily") phases.extractions[task] = part?.dailyPatterns ?? null;
			if (task === "digest-extract-assets") phases.extractions[task] = part?.assets ?? null;
			this.#checkpoint(doc, digest);
			if (!parsed) console.error(`[corpus] 结构化素材部分降级 doc=${docId}: ${task}`);
		}));
		if (!this.#canContinue(doc)) return;
		const tropes = phases.extractions["digest-extract-mechanisms"] ?? [];
		const dailyPatterns = phases.extractions["digest-extract-daily"] ?? [];
		const assets = phases.extractions["digest-extract-assets"] ?? [];
		const auditRows = [...tropes.map(item => ({ kind: "mechanism", text: item.mechanism, evidenceIds: item.evidenceIds })), ...dailyPatterns.map(item => ({ kind: "daily", text: `${item.title} ${item.surfaceActivity} ${item.microChange}`, evidenceIds: item.evidenceIds })), ...assets.map(item => ({ kind: "asset", text: `${item.title} ${item.mechanism}`, evidenceIds: item.evidenceIds }))];
		if (!phases.auditResults) {
			let parsed: Record<string, unknown> | null = null;
			if (auditRows.length) {
				const raw = await this.#call(docId, skill, JSON.stringify({ task: "digest-audit", evidence_index: evidenceIndex, items: auditRows.map((item, index) => ({ index, ...item })) }), 8192);
				if (!this.#isLive(doc)) return;
				if (typeof raw !== "string" && !this.#canContinue(doc)) return;
				parsed = typeof raw === "string" ? parseObject(raw) : null;
			}
			phases.auditResults = Array.isArray(parsed?.results) ? parsed.results.flatMap((value): Array<{ index: number; verdict: CorpusAuditVerdict }> => {
				if (!value || typeof value !== "object") return [];
				const row = value as Record<string, unknown>;
				return Number.isInteger(row.index) && Number(row.index) >= 0 && Number(row.index) < auditRows.length && ["supported", "weak", "unsupported"].includes(String(row.verdict)) ? [{ index: Number(row.index), verdict: row.verdict as CorpusAuditVerdict }] : [];
			}) : [];
			this.#checkpoint(doc, digest);
		}
		if (!this.#canContinue(doc)) return;
		const auditResult = new Map(phases.auditResults.map(item => [item.index, item.verdict]));
		const verdict = (index: number) => auditResult.get(index) ?? "weak";
		const approvedTropes = tropes.filter((_, index) => verdict(index) !== "unsupported");
		const approvedDaily = dailyPatterns.filter((_, index) => verdict(tropes.length + index) !== "unsupported");
		const approvedAssets = assets.filter((_, index) => verdict(tropes.length + dailyPatterns.length + index) !== "unsupported");
		digest.audit = { approved: auditRows.filter((_, index) => verdict(index) === "supported").length, weak: auditRows.filter((_, index) => verdict(index) === "weak").length, rejected: auditRows.filter((_, index) => verdict(index) === "unsupported").length };
		digest.extractedCount = approvedTropes.length;
		digest.dailyPatterns = approvedDaily; digest.dailyPatternCount = approvedDaily.length;
		digest.assets = approvedAssets; digest.assetCount = approvedAssets.length;
		phases.materialized = true;
		this.#checkpoint(doc, digest);
		if (!this.#canContinue(doc)) return;
		const extractions: OutlineResearchExtraction[] = approvedTropes.map(t => ({
			mechanism: t.mechanism, appliesWhen: t.appliesWhen, failureWarning: t.failureWarning,
			sourceIds: [docId], locator: t.locator,
			evidenceSummary: (t.evidenceIds ?? []).flatMap(id => evidenceById.get(id)?.summary ?? []).join("\n").slice(0, 800),
			confidence: verdict(tropes.indexOf(t)) === "supported" ? "audited" : "system-grounded",
		}));
		if (!phases.onReadyComplete) {
			if (!this.#canContinue(doc)) return;
			try { await this.#deps.onReady?.(doc, digest, extractions); }
			catch (error) { this.#fail(doc, `研究入库失败：${safeModelError(error)}`, false); return; }
			if (!this.#isLive(doc)) return;
			phases.onReadyComplete = true;
			this.#checkpoint(doc, digest);
		}
		if (!this.#canContinue(doc)) return;
		doc.status = "ready"; doc.chunkCount = chunks.length; doc.chapterCount = detected ? chapters.length : 0;
		doc.synopsisPreview = digest.synopsis.slice(0, 400); doc.tropeCount = approvedTropes.length;
		doc.dailyPatternCount = approvedDaily.length; doc.assetCount = approvedAssets.length;
		delete doc.error; delete doc._retries;
		this.#persistDocuments();
	}

	private static readonly MODEL_MAX_RETRIES = 3;
	// GLM 长文本摘要在代理链路上可能超过两分钟；不要在上游仍处理中途掐断。
	private static readonly MODEL_CALL_TIMEOUT_MS = 180_000;

	#signal(docId: string): AbortSignal { return this.#abort.get(docId)?.signal ?? AbortSignal.abort(); }

	/** Identity, not just docId, prevents a deleted/recreated document from receiving an old result. */
	#isLive(doc: CorpusDocument): boolean { return this.#docs.get(doc.id) === doc && !this.#signal(doc.id).aborted; }
	#canContinue(doc: CorpusDocument): boolean { return this.#isLive(doc) && doc.status !== "paused" && doc.status !== "failed"; }
	#advance(doc: CorpusDocument, step: CorpusDocStatus): boolean {
		if (!this.#canContinue(doc)) return false;
		doc.status = step;
		const job = this.#jobs.get(doc.id);
		if (job) job.status = { step, done: 0, total: 0 };
		this.#persistDocuments();
		return true;
	}
	#checkpoint(doc: CorpusDocument, digest: CorpusDigest): boolean {
		if (!this.#isLive(doc)) return false;
		digest.updatedAt = new Date().toISOString();
		this.#writeDigest(doc.id, digest);
		return true;
	}
	#usage(doc: CorpusDocument): CorpusModelUsage {
		if (!doc.modelUsage) {
			// Historic provider retries cannot be reconstructed from chunk summaries.
			// Only subsequent attempts are exact; the unknown history stays explicit.
			doc.modelUsage = { version: 1, attempts: 0, limit: this.#maxCallsPerDoc, legacyAttemptsUnknown: true };
		}
		const usage = doc.modelUsage;
		if (usage.version !== 1 || !Number.isSafeInteger(usage.attempts) || usage.attempts < 0) throw new Error("无效或不支持的 Corpus modelUsage 版本/计数（不会重置预算）");
		usage.limit = this.#maxCallsPerDoc;
		return usage;
	}
	#budgetExceeded(doc: CorpusDocument): string {
		const usage = this.#usage(doc);
		const error = `调用预算已耗尽（${usage.attempts}/${usage.limit}）；请明确提高 novelDigest.maxCallsPerDoc 后再恢复`;
		if (this.#isLive(doc)) {
			usage.exhausted = true; doc.status = "failed"; doc.error = error;
			this.#queue.delete(doc.id); this.#persistDocuments();
		}
		return error;
	}
	/** Synchronous check + durable reservation, before any await: concurrent extracts cannot overspend. */
	#reserveAttempt(doc: CorpusDocument): boolean {
		if (!this.#canContinue(doc)) return false;
		const usage = this.#usage(doc);
		if (usage.exhausted || usage.attempts >= usage.limit) { this.#budgetExceeded(doc); return false; }
		usage.attempts++; doc.updatedAt = new Date().toISOString();
		this.#persistDocuments();
		return true;
	}

	async #call(docId: string, skill: string, user: string, maxTokens: number): Promise<string | { error: string }> {
		const doc = this.#docs.get(docId);
		if (!doc) return { error: "消化任务已取消" };
		let focusedSkill = skill;
		try {
			const task = JSON.parse(user).task;
			if (typeof task === "string") {
				const marker = `## task: ${task}`, start = skill.indexOf(marker);
				if (start >= 0) { const next = skill.indexOf("\n## task:", start + marker.length); focusedSkill = skill.slice(start, next >= 0 ? next : skill.length).trim(); }
			}
		} catch {}
		for (let attempt = 0; attempt <= CorpusEngine.MODEL_MAX_RETRIES; attempt++) {
			if (!this.#reserveAttempt(doc)) return { error: doc.error ?? "消化任务已暂停或取消" };
			const taskSignal = this.#signal(docId);
			const signal = AbortSignal.any([taskSignal, AbortSignal.timeout(CorpusEngine.MODEL_CALL_TIMEOUT_MS)]);
			console.log(`[corpus] 模型调用开始 doc=${docId} attempt=${attempt + 1}/${CorpusEngine.MODEL_MAX_RETRIES + 1}`);
			let result: string | { error: string }, delay = 600 * Math.min(2 ** attempt, 8);
			try {
				result = await withAbort(this.#deps.runSideModel("novelDigest", focusedSkill, user, { maxTokens, signal, forceNonStreaming: true }), signal);
				console.log(`[corpus] 模型调用结束 doc=${docId} attempt=${attempt + 1} result=${typeof result === "string" ? "text" : "error"}`);
				if (typeof result !== "string") console.error(`[corpus] 模型调用错误 doc=${docId} attempt=${attempt + 1}: ${safeModelError(result.error, 500)}`);
			} catch (error) {
				const detail = safeModelError(error);
				console.error(`[corpus] 模型调用异常 doc=${docId} attempt=${attempt + 1}: ${detail}`);
				result = { error: `模型调用异常（${attempt + 1} 次尝试）：${detail}` }; delay = 500;
			}
			if (!this.#isLive(doc)) return { error: "消化任务已取消" };
			if (typeof result === "string" || !this.#canContinue(doc)) return result;
			if (this.#usage(doc).attempts >= this.#maxCallsPerDoc) return { error: this.#budgetExceeded(doc) };
			if (attempt === CorpusEngine.MODEL_MAX_RETRIES) return result;
			await retryDelay(delay, AbortSignal.any([taskSignal, this.#jobs.get(docId)!.pauseController.signal]));
			if (!this.#canContinue(doc)) return { error: doc.error ?? "消化任务已暂停或取消" };
		}
		return { error: "调用异常已耗尽重试" };
	}

	#readDigest(docId: string): CorpusDigest | null {
		const path = join(corpusDigestsDir(this.#deps.cwd), `${docId}.json`);
		try { const value = JSON.parse(readFileSync(path, "utf8")); if (value && typeof value === "object" && value.version === 1 && Array.isArray((value as CorpusDigest).chunks)) return value as CorpusDigest; } catch {}
		return null;
	}

	#writeDigest(docId: string, digest: CorpusDigest): void {
		const dir = corpusDigestsDir(this.#deps.cwd);
		mkdirSync(dir, { recursive: true });
		this.#atomic(join(dir, `${docId}.json`), digest);
	}

	private static readonly DOC_MAX_RETRIES = 3;

	#fail(doc: CorpusDocument, message: string, automaticRetry = true): void {
		if (!this.#canContinue(doc)) return;
		if (automaticRetry && this.#usage(doc).attempts >= this.#maxCallsPerDoc) { this.#budgetExceeded(doc); return; }
		const retries = doc._retries ?? 0;
		if (automaticRetry && retries < CorpusEngine.DOC_MAX_RETRIES) {
			doc._retries = retries + 1;
			doc.status = "pending"; this.#persistDocuments(); this.#queue.add(doc.id);
			return;
		}
		doc.status = "failed"; doc.error = message; delete doc._retries;
		this.#persistDocuments();
	}
}

/** Stop local work on abort even if a provider ignores its signal; late results cannot write checkpoints. */
function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("已取消"));
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
		const timer = setTimeout(done, ms);
		if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
	});
}

function parseCorpusExtractions(extractParsed: Record<string, unknown>, evidenceById: Map<string, { locator: string; summary: string }>): { tropes: CorpusTrope[]; dailyPatterns: CorpusDailyPattern[]; assets: NarrativeAsset[] } {
	const tropes: CorpusTrope[] = Array.isArray(extractParsed?.tropes)
		? extractParsed.tropes.flatMap((item): CorpusTrope[] => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const row = item as Record<string, unknown>;
			const evidenceIds = cleanList(row.evidenceIds, 4, 40).filter((id) => evidenceById.has(id));
			return typeof row.mechanism === "string" && row.mechanism.trim() && evidenceIds.length
				? [{ mechanism: cleanText(row.mechanism, 600), appliesWhen: cleanText(row.appliesWhen, 500), failureWarning: cleanText(row.failureWarning, 500), locator: evidenceLocator(evidenceIds, evidenceById), evidenceIds }]
				: [];
		}).slice(0, 40)
		: [];
	const dailyPatterns: CorpusDailyPattern[] = Array.isArray(extractParsed.dailyPatterns) ? extractParsed.dailyPatterns.flatMap((item): CorpusDailyPattern[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>, value: CorpusDailyPattern = {
			title: cleanText(row.title, 180), setting: cleanText(row.setting, 180), surfaceActivity: cleanText(row.surfaceActivity), initiative: cleanText(row.initiative), sweetBeat: cleanText(row.sweetBeat), friction: cleanText(row.friction), misunderstanding: cleanText(row.misunderstanding), microChange: cleanText(row.microChange), escalationLimit: cleanText(row.escalationLimit), naturalStop: cleanText(row.naturalStop), failureWarning: cleanText(row.failureWarning), locator: "", evidenceIds: cleanList(row.evidenceIds, 4, 40).filter((id) => evidenceById.has(id)),
		};
		value.locator = evidenceLocator(value.evidenceIds ?? [], evidenceById);
		return value.title && value.surfaceActivity && value.microChange && value.evidenceIds?.length ? [value] : [];
	}).slice(0, 20) : [];
	const assets: NarrativeAsset[] = Array.isArray(extractParsed.assets) ? extractParsed.assets.flatMap((item): NarrativeAsset[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const kind = row.kind === "scene-pattern" || row.kind === "relationship-beat" || row.kind === "dialogue-move" ? row.kind : null;
		if (!kind) return [];
		const value: NarrativeAsset = {
			kind,
			title: cleanText(row.title, 180), mechanism: cleanText(row.mechanism, 700),
			appliesWhen: cleanText(row.appliesWhen, 500), failureWarning: cleanText(row.failureWarning, 500),
			opening: cleanText(row.opening, 500), progression: cleanList(row.progression, 6, 300),
			turn: cleanText(row.turn, 500), stopPoint: cleanText(row.stopPoint, 500),
			relationshipStage: cleanText(row.relationshipStage, 180), pressure: cleanText(row.pressure, 180),
			desiredExperience: cleanText(row.desiredExperience, 180), locator: "", evidenceIds: cleanList(row.evidenceIds, 4, 40).filter((id) => evidenceById.has(id)),
		};
		value.locator = evidenceLocator(value.evidenceIds ?? [], evidenceById);
		return value.title && value.mechanism && value.evidenceIds?.length ? [value] : [];
	}).slice(0, 30) : [];
	return { tropes, dailyPatterns, assets };
}

function chapterTitles(chapters: string[], text: string): string[] {
	const t = chapters.filter(Boolean).slice(0, 8).map((c) => c.slice(0, 30));
	return t.length ? t : [];
}

function corpusArcLocator(arc: CorpusArcDigest, chunks: CorpusChunkDigest[]): string {
	const covered = chunks.filter((chunk) => chunk.index >= arc.chunkRange[0] && chunk.index <= arc.chunkRange[1]);
	const chapters = covered.flatMap((chunk) => chunk.chapters).filter(Boolean);
	const chapterPart = chapters.length ? `${chapters[0]}${chapters.length > 1 ? ` 至 ${chapters.at(-1)}` : ""}；` : "";
	return `${chapterPart}块 ${arc.chunkRange[0] + 1}-${arc.chunkRange[1] + 1}`.slice(0, 240);
}

function corpusChunkLocator(chunk: CorpusChunkDigest): string {
	const chapters = chunk.chapters.filter(Boolean);
	const chapterPart = chapters.length ? `${chapters[0]}${chapters.length > 1 ? ` 至 ${chapters.at(-1)}` : ""}；` : "";
	return `${chapterPart}块 ${chunk.index + 1}`.slice(0, 240);
}

function evidenceLocator(ids: string[], index: Map<string, { locator: string }>): string {
	return [...new Set(ids.flatMap((id) => index.get(id)?.locator ?? []))].join("；").slice(0, 240);
}

function isFailedChunkSummary(summary: string): boolean {
	return summary.startsWith("(本块摘要生成失败") || summary.startsWith("（本块摘要生成失败");
}
