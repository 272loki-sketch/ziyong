import { createHash } from "node:crypto";
import { buildNovelPackage } from "./canon.ts";
import type { NovelAnchor } from "./canon.ts";
import type { ConfirmedNovelOpeningSnapshot } from "./card.ts";
import type { NovelEvidence } from "./source.ts";
import type { StoredNovelPackage } from "./store.ts";

export type NovelOpeningDraft = Omit<ConfirmedNovelOpeningSnapshot, "confirmed">;

export interface NovelOpeningEvidence {
	field: "time" | "place" | "sceneText" | "openingNarration" | "publicCharacterName" | "publicCharacterProfile" | "publicWorldFact";
	itemIndex?: number;
	/** UTF-16 offsets into sourceRange.text, end exclusive. */
	rangeStart: number;
	rangeEnd: number;
	source: NovelEvidence;
}

export interface NovelOpeningProposal {
	/** A proposal cannot satisfy buildNovelPlayCard until a caller explicitly confirms it. */
	confirmed: false;
	draft: NovelOpeningDraft;
	evidence: NovelOpeningEvidence[];
	digest: string;
	sourceRange: {
		chars: number;
		segments: Array<{ chunkIndex: number; start: number; end: number; rangeStart: number; rangeEnd: number }>;
	};
}

export interface NovelOpeningModelRequest {
	systemPrompt: string;
	userText: string;
	previousValidationError?: string;
}

export interface ExtractNovelOpeningInput {
	stored: StoredNovelPackage;
	anchor: NovelAnchor;
	player: { name: string; identity: string; mode?: "new-character" | "existing-character" };
	/** Body loaded by the caller from skills/小说开场提取/SKILL.md through the existing Skill scanner. */
	skillBody: string;
	modelCall: (request: NovelOpeningModelRequest, options: { signal?: AbortSignal; attempt: number }) => Promise<unknown>;
	signal?: AbortSignal;
	contextChars?: number;
	maxAttempts?: number;
}

export interface ExtractNovelCharacterProfilesInput {
	stored: StoredNovelPackage;
	proposal: NovelOpeningProposal;
	skillBody: string;
	modelCall: (request: NovelOpeningModelRequest, options: { signal?: AbortSignal; attempt: number }) => Promise<unknown>;
	signal?: AbortSignal;
	maxAttempts?: number;
}

interface SourceSegment {
	chunkIndex: number;
	start: number;
	end: number;
	text: string;
	rangeStart: number;
	rangeEnd: number;
}

const LIMITS = {
	contextChars: 24_000,
	maxContextChars: 80_000,
	maxAttempts: 2,
	name: 120,
	identity: 1_500,
	skillBody: 12_000,
	fact: 5_000,
	profiles: 24,
	facts: 40,
} as const;

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
	return value as Record<string, unknown>;
};

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label}字段不符合严格 schema`);
	}
}

function boundedText(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
	if (value.length > max) throw new Error(`${label}超过长度上限 ${max}`);
	return value.replace(/\r\n/g, "\n");
}

function parseObject(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string") throw new Error("开场提取结果不是 JSON 对象");
	const source = value.trim();
	const candidates = [source, source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], source.match(/\{[\s\S]*\}/)?.[0]];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// A provider can wrap one valid JSON object in a fence or short prose.
		}
	}
	throw new Error("开场提取结果无法解析为 JSON 对象");
}

function validateStored(stored: StoredNovelPackage): void {
	if (!stored || stored.version !== 1 || !stored.source || !stored.package) throw new Error("作品包存储结构无效");
	const source = stored.source;
	const pkg = stored.package;
	if (source.version !== 1 || pkg.version !== 1 || source.docId !== pkg.docId
		|| source.fingerprint !== pkg.sourceFingerprint || source.chunkChars !== pkg.sourceChunkChars) {
		throw new Error("作品包与原文身份不匹配");
	}
	const chunks = source.chunks;
	if (!Array.isArray(chunks) || !chunks.length) throw new Error("作品包没有原文分块");
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		if (!chunk || chunk.index !== index || chunk.chars !== chunk.text.length || !chunk.text.length) {
			throw new Error("原文分块顺序或长度无效");
		}
	}
	const rebuilt = buildNovelPackage(source, pkg.stages, pkg.nodes);
	if (rebuilt.revision !== pkg.revision || JSON.stringify(rebuilt) !== JSON.stringify(pkg)) {
		throw new Error("作品包未通过 canonical 校验");
	}
}

function anchorCutoff(stored: StoredNovelPackage, anchor: NovelAnchor): { chunkIndex: number; offset: number } {
	const pkg = stored.package;
	if (!anchor || anchor.packageRevision !== pkg.revision) throw new Error("开演锚点与作品包版本不匹配");
	if (anchor.kind === "source-end") {
		const chunk = stored.source.chunks[stored.source.chunks.length - 1];
		if (!chunk) throw new Error("作品包没有原文分块");
		return { chunkIndex: chunk.index, offset: chunk.text.length };
	}
	if (anchor.position !== "before" && anchor.position !== "after") throw new Error("无效开演位置");
	const node = pkg.nodes.find(item => item.id === anchor.nodeId);
	if (!node) throw new Error("开演节点不存在");
	if (node.visibility !== "public") throw new Error("不能从秘密节点开演");
	if (node.sourceRefs.length !== 1) throw new Error("开演节点含多段证据，无法保证精确防剧透边界");
	const ref = node.sourceRefs[0];
	return { chunkIndex: ref.chunkIndex, offset: anchor.position === "before" ? ref.start : ref.end };
}

function sourceTail(stored: StoredNovelPackage, cutoff: { chunkIndex: number; offset: number }, budget: number): { text: string; segments: SourceSegment[] } {
	const eligible = stored.source.chunks.slice(0, cutoff.chunkIndex + 1).map(chunk => ({
		chunkIndex: chunk.index,
		start: 0,
		end: chunk.index === cutoff.chunkIndex ? cutoff.offset : chunk.text.length,
		text: chunk.text.slice(0, chunk.index === cutoff.chunkIndex ? cutoff.offset : chunk.text.length),
	})).filter(segment => segment.text.length);
	const total = eligible.reduce((sum, segment) => sum + segment.text.length, 0);
	let skip = Math.max(0, total - budget);
	const selected: Array<Omit<SourceSegment, "rangeStart" | "rangeEnd">> = [];
	for (const segment of eligible) {
		if (skip >= segment.text.length) { skip -= segment.text.length; continue; }
		const start = segment.start + skip;
		selected.push({ ...segment, start, text: segment.text.slice(skip) });
		skip = 0;
	}
	let cursor = 0;
	const segments = selected.map(segment => {
		const mapped = { ...segment, rangeStart: cursor, rangeEnd: cursor + segment.text.length };
		cursor = mapped.rangeEnd;
		return mapped;
	});
	return { text: segments.map(segment => segment.text).join(""), segments };
}

function locateQuote(quoteValue: unknown, label: string, sourceText: string, segments: SourceSegment[]): { quote: string; rangeStart: number; rangeEnd: number; source: NovelEvidence } {
	const quote = boundedText(quoteValue, `${label}.quote`, LIMITS.fact);
	const rangeStart = sourceText.indexOf(quote);
	if (rangeStart < 0 || sourceText.lastIndexOf(quote) !== rangeStart) throw new Error(`${label}的原文引句必须在给定范围内精确且唯一`);
	const rangeEnd = rangeStart + quote.length;
	const segment = segments.find(item => rangeStart >= item.rangeStart && rangeEnd <= item.rangeEnd);
	if (!segment) throw new Error(`${label}的原文引句跨越分块边界`);
	const localStart = segment.start + rangeStart - segment.rangeStart;
	return {
		quote, rangeStart, rangeEnd,
		source: { chunkIndex: segment.chunkIndex, start: localStart, end: localStart + quote.length, quote },
	};
}

function quotedFact(value: unknown, label: string, field: NovelOpeningEvidence["field"], sourceText: string, segments: SourceSegment[], itemIndex?: number): { text: string; evidence: NovelOpeningEvidence } {
	const raw = asRecord(value, label);
	exactKeys(raw, ["text", "quote"], label);
	const text = boundedText(raw.text, `${label}.text`, LIMITS.fact);
	const located = locateQuote(raw.quote, label, sourceText, segments);
	if (text !== located.quote) throw new Error(`${label}.text必须与原文引句完全一致，禁止补写原著事实`);
	return { text, evidence: { field, ...(itemIndex === undefined ? {} : { itemIndex }), ...located } };
}

function parseDraft(value: unknown, player: NovelOpeningDraft["user"], sourceText: string, segments: SourceSegment[]): { draft: NovelOpeningDraft; evidence: NovelOpeningEvidence[] } {
	const raw = parseObject(value);
	const allowed = ["time", "place", "sceneText", "openingNarration", "controlledCharacterProfile", "publicCharacterProfiles", "publicWorldFacts", "styleExcerpts", "characterVoiceExcerpts"];
	if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error("开场提取结果字段不符合严格 schema");
	const evidence: NovelOpeningEvidence[] = [];
	const fact = (key: "time" | "place" | "sceneText" | "openingNarration") => {
		const parsed = quotedFact(raw[key], key, key, sourceText, segments);
		evidence.push(parsed.evidence);
		return parsed.text;
	};
	if (!Array.isArray(raw.publicCharacterProfiles) || raw.publicCharacterProfiles.length > LIMITS.profiles) {
		throw new Error(`publicCharacterProfiles必须是最多 ${LIMITS.profiles} 项的数组`);
	}
	const publicCharacterProfiles = raw.publicCharacterProfiles.map((value, itemIndex) => {
		const profile = asRecord(value, `publicCharacterProfiles[${itemIndex}]`);
		exactKeys(profile, ["name", "profile"], `publicCharacterProfiles[${itemIndex}]`);
		const name = quotedFact(profile.name, `publicCharacterProfiles[${itemIndex}].name`, "publicCharacterName", sourceText, segments, itemIndex);
		const detail = quotedFact(profile.profile, `publicCharacterProfiles[${itemIndex}].profile`, "publicCharacterProfile", sourceText, segments, itemIndex);
		evidence.push(name.evidence, detail.evidence);
		return { name: name.text, profile: detail.text };
	});
	if (!Array.isArray(raw.publicWorldFacts) || raw.publicWorldFacts.length > LIMITS.facts) {
		throw new Error(`publicWorldFacts必须是最多 ${LIMITS.facts} 项的数组`);
	}
	const publicWorldFacts = raw.publicWorldFacts.map((value, itemIndex) => {
		const parsed = quotedFact(value, `publicWorldFacts[${itemIndex}]`, "publicWorldFact", sourceText, segments, itemIndex);
		evidence.push(parsed.evidence);
		return parsed.text;
	});
	const excerpts = (key: "styleExcerpts" | "characterVoiceExcerpts") => Array.isArray(raw[key]) ? raw[key].map((item, index) => {
		const row = asRecord(item, `${key}[${index}]`);
		const quote = locateQuote(row.quote, `${key}[${index}]`, sourceText, segments).quote;
		return key === "styleExcerpts" ? quote : { characterName: boundedText(row.characterName, `${key}[${index}].characterName`, LIMITS.name), quote };
	}) : [];
	return {
		draft: { user: player, time: fact("time"), place: fact("place"), sceneText: fact("sceneText"), openingNarration: fact("openingNarration"), publicCharacterProfiles, publicWorldFacts, styleExcerpts: excerpts("styleExcerpts") as string[], characterVoiceExcerpts: excerpts("characterVoiceExcerpts") as Array<{ characterName: string; quote: string }> },
		evidence,
	};
}

function aborted(signal?: AbortSignal): never {
	const error = new Error("开场提取已取消");
	error.name = "AbortError";
	throw error;
}

export async function extractNovelOpening(input: ExtractNovelOpeningInput): Promise<NovelOpeningProposal> {
	validateStored(input.stored);
	const player = {
		name: boundedText(input.player?.name, "用户角色名", LIMITS.name),
		identity: boundedText(input.player?.identity, "用户角色身份", LIMITS.identity),
		...(input.player?.mode === "existing-character" ? { mode: "existing-character" as const } : {}),
	};
	const skillBody = boundedText(input.skillBody, "小说开场提取 Skill 正文", LIMITS.skillBody);
	const contextChars = input.contextChars ?? LIMITS.contextChars;
	if (!Number.isSafeInteger(contextChars) || contextChars < 1 || contextChars > LIMITS.maxContextChars) throw new Error("无效开场原文预算");
	const maxAttempts = input.maxAttempts ?? LIMITS.maxAttempts;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("开场提取尝试次数必须在 1 到 3 之间");
	const cutoff = anchorCutoff(input.stored, input.anchor);
	const range = sourceTail(input.stored, cutoff, contextChars);
	if (!range.text.trim()) throw new Error("锚点之前没有可用于开场提取的原文");
	const requestData = {
		player_identity_external_to_source: player,
		anchor: input.anchor.kind === "source-end" ? { kind: "source-end" } : { nodeId: input.anchor.nodeId, position: input.anchor.position },
		source_range: { text: range.text, segments: range.segments.map(({ text: _text, ...segment }) => segment) },
	};
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (input.signal?.aborted) aborted(input.signal);
		try {
			const output = await input.modelCall({
				systemPrompt: skillBody,
				userText: JSON.stringify({ ...requestData, previous_validation_error: lastError instanceof Error ? lastError.message : undefined }, null, 2),
				...(lastError instanceof Error ? { previousValidationError: lastError.message } : {}),
			}, { signal: input.signal, attempt });
			if (input.signal?.aborted) aborted(input.signal);
			const parsed = parseDraft(output, player, range.text, range.segments);
			const sourceRange = {
				chars: range.text.length,
				segments: range.segments.map(({ text: _text, ...segment }) => segment),
			};
			const digest = createHash("sha256").update(JSON.stringify({
				packageRevision: input.stored.package.revision,
				anchor: input.anchor,
				draft: parsed.draft,
				evidence: parsed.evidence,
				sourceRange,
			})).digest("hex");
			return { confirmed: false, draft: parsed.draft, evidence: parsed.evidence, digest, sourceRange };
		} catch (error) {
			if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) aborted(input.signal);
			lastError = error;
		}
	}
	const detail = lastError instanceof Error ? `：${lastError.message}` : "";
	throw new Error(`开场提取在 ${maxAttempts} 次尝试后失败${detail}`, { cause: lastError });
}

/** Add evidence-backed card-shaped character entries without changing the immutable package. */
export async function extractNovelCharacterProfiles(input: ExtractNovelCharacterProfilesInput): Promise<NovelOpeningProposal> {
	const segments = input.proposal.sourceRange.segments.map(segment => ({ ...segment, text: input.stored.source.chunks[segment.chunkIndex]!.text.slice(segment.start, segment.end) }));
	const sourceText = segments.map(segment => segment.text).join("");
	const maxAttempts = input.maxAttempts ?? 2;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("人物画像尝试次数必须在 1 到 3 之间");
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (input.signal?.aborted) aborted(input.signal);
		try {
			const output = await input.modelCall({ systemPrompt: input.skillBody, userText: JSON.stringify({ source_range: { text: sourceText, segments: input.proposal.sourceRange.segments }, character_profile_template: { commonLayers: ["基本信息", "背景(秘密)", "外貌", "表象性格", "内核性格", "真实能力", "行为模式", "说话风格", "关系与当前状态"], instruction: "按当前小说题材和原文证据自适应增删层级；修炼/魔法、校园/职场、宫廷/组织、科幻等使用各自有意义的领域层，不适用或无证据的层级省略，不要套用其他作品内容。不要生成知情边界、系统规则、运行时指令或提示词。" }, already_extracted: input.proposal.draft.publicCharacterProfiles, previous_validation_error: lastError instanceof Error ? lastError.message : undefined }, null, 2), ...(lastError instanceof Error ? { previousValidationError: lastError.message } : {}) }, { signal: input.signal, attempt });
			const raw = parseObject(output);
			if (!Array.isArray(raw.profiles)) throw new Error("人物画像结果缺少 profiles 数组");
			const profiles = raw.profiles.slice(0, 12).map((value, index) => {
		const row = asRecord(value, `profiles[${index}]`);
		const name = boundedText(row.name, `profiles[${index}].name`, LIMITS.name);
		const keys = Array.isArray(row.keys) ? row.keys.map((key, keyIndex) => boundedText(key, `profiles[${index}].keys[${keyIndex}]`, LIMITS.name)).slice(0, 8) : [name];
		const content = boundedText(row.content, `profiles[${index}].content`, 8_000);
		const contentObject = parseObject(content);
		if (!contentObject[name]) throw new Error(`profiles[${index}].content顶层人物名必须与 name 一致`);
		const forbidden = /知情边界|系统规则|运行时|提示词|不要替|必须调用|未来剧情|后续剧情|candidate|activation|recipient|CoT|prompt/i;
		if (forbidden.test(content)) throw new Error(`profiles[${index}].content含有非人物资料或未来剧情指令`);
		const evidenceQuotes = Array.isArray(row.evidenceQuotes) ? row.evidenceQuotes.map((quote, quoteIndex) => locateQuote(quote, `profiles[${index}].evidenceQuotes[${quoteIndex}]`, sourceText, segments).quote).slice(0, 12) : [];
		if (!evidenceQuotes.length) throw new Error(`profiles[${index}]缺少原文证据`);
		const uniqueKeys = [...new Set([name, ...keys])].slice(0, 8);
		return { name, keys: uniqueKeys, content, evidenceQuotes };
			});
			return { ...input.proposal, draft: { ...input.proposal.draft, characterProfiles: profiles } };
		} catch (error) {
			if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) aborted(input.signal);
			lastError = error;
		}
	}
	const detail = lastError instanceof Error ? `：${lastError.message}` : "";
	throw new Error(`人物画像提取在 ${maxAttempts} 次尝试后失败${detail}`, { cause: lastError });
}
