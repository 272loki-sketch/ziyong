import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { entriesToCharacterBook, readCardRawJson } from "../card.ts";
import { loadCorpusDocuments, corpusTextsDir, corpusDigestsDir, type CorpusDocument, type TextChunk } from "../outline/corpus.ts";
import { scanSkillFiles } from "../stage/skill-store.ts";
import { resolveConfigPath } from "../paths.ts";
import { readJsonFile } from "../jsonio.ts";
import type { RpConfig } from "../types.ts";
import { buildNovelPlayCard, type NovelPlayRawCard } from "./card.ts";
import { type NovelAnchor, type NovelPackage } from "./canon.ts";
import { extractNovelCharacterProfiles, extractNovelOpening, type NovelOpeningProposal } from "./opening.ts";
import { buildNovelEvents } from "./service.ts";
import { extendNovelPackage } from "./extend.ts";
import { loadNovelPackage, type StoredNovelPackage } from "./store.ts";
import { prepareNovelSource } from "./source.ts";
import { saveNovelPackage } from "./store.ts";
import { buildNovelCharacterProfileCorpus } from "./profile-service.ts";
import { loadNovelCharacterProfileCorpus, type NovelCharacterProfileCorpus } from "./profile-store.ts";

export interface NovelPlayModelHost {
	cwd: string;
	runSideText(step: "novelDigest", systemPrompt: string, userText: string, options?: { maxTokens?: number; signal?: AbortSignal; forceNonStreaming?: boolean }): Promise<string | { error: string }>;
	switchToCard(): Promise<"switched" | "created">;
	memoryScope(): { sessionId: string; card?: string };
}

export interface NovelPlayBinding { sessionId: string; card: string }
export interface PackagePublicDto { docId: string; title: string; revision: string; stageCount: number; nodeCount: number; builtAt: string }
export interface StartOptionDto { docId: string; revision: string; title: string; capabilities: { playerModes: Array<"new-character" | "existing-character">; startKinds: Array<"node" | "source-end"> }; sourceEnd: { kind: "source-end"; chapterLabel: string; sourceChars: number }; nodes: Array<{ nodeId: string; title: string; summary: string; stageTitle: string; stageOrder: number; nodeOrder: number; source: { chunkIndex: number; chapters: string[] } }> }
export interface PreviewPublicDto {
	token: string;
	expiresAt: string;
	package: { docId: string; revision: string };
	anchor: NovelAnchor;
	draft: NovelOpeningProposal["draft"];
}
export type StartResult =
	| { card: string; session: "created" }
	| { card: string; session: "recovery-required"; recovery: string };

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Ensure novel character profiles also exist as a visible mounted lorebook. */
export function ensureNovelPlayLorebook(cwd: string): string | undefined {
	const configState = loadRawConfig(cwd), cardPath = String(configState.config.card ?? "");
	if (!cardPath) return undefined;
	try {
		const { raw } = readCardRawJson(resolve(cwd, cardPath));
		const data = raw.data as Record<string, unknown>;
		const extension = (data.extensions as Record<string, unknown> | undefined)?.liyuanNovelPlay as Record<string, unknown> | undefined;
		if (!extension?.docId || !extension.revision) return undefined;
		const book = data.character_book && typeof data.character_book === "object" ? data.character_book as Record<string, unknown> : {};
		const entries = book.entries && typeof book.entries === "object" ? book.entries as Record<string, unknown> : {};
		const profileEntries = Object.fromEntries(Object.entries(entries).filter(([, value]) => {
			if (!value || typeof value !== "object") return false;
			const row = value as Record<string, unknown>;
			return Number(row.insertion_order ?? row.order ?? 0) >= 120 && row.selective === true;
		}));
		if (!Object.keys(profileEntries).length) return undefined;
		const relativeLore = `assets/lorebooks/novel-play-${String(extension.docId)}.json`;
		const loreFile = join(cwd, relativeLore);
		mkdirSync(dirname(loreFile), { recursive: true });
		atomicWrite(loreFile, `${JSON.stringify({ entries: profileEntries, extensions: { liyuanNovelPlay: { docId: extension.docId, revision: extension.revision, kind: "character-profiles" } } }, null, "\t")}\n`);
		const mounted = Array.isArray(configState.config.lorebooks) ? [...configState.config.lorebooks] : [];
		if (!mounted.includes(relativeLore)) atomicWrite(configState.path, `${JSON.stringify({ ...configState.config, lorebooks: [...mounted, relativeLore] }, null, "\t")}\n`);
		return relativeLore;
	} catch { return undefined; }
}

function atomicWrite(path: string, bytes: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try { writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx" }); renameSync(temporary, path); }
	catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function loadRawConfig(cwd: string): { path: string; existed: boolean; bytes: string; config: RpConfig } {
	const path = resolveConfigPath(cwd);
	const existed = existsSync(path);
	const bytes = existed ? readFileSync(path, "utf8") : "";
	const config = existed ? JSON.parse(bytes) as RpConfig : { card: "assets/cards/default_Qingwu.json", userName: "用户", userPersona: "", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 } as RpConfig;
	return { path, existed, bytes, config };
}

export function novelPlayBinding(host: NovelPlayModelHost): NovelPlayBinding {
	ensureNovelPlayLorebook(host.cwd);
	const scope = host.memoryScope();
	const sessionId = scope.sessionId;
	const runtimeCard = String(scope.card ?? "");
	const configCard = String(loadRawConfig(host.cwd).config.card ?? "");
	if (!sessionId) throw new Error("当前会话不可用");
	if (!runtimeCard) throw new Error("当前运行时角色卡不可用");
	if (!configCard || runtimeCard !== configCard) throw new Error("运行时角色卡与配置不一致，请刷新或重启服务后重试");
	return { sessionId, card: runtimeCard };
}

export function sameNovelPlayBinding(a: NovelPlayBinding, b: NovelPlayBinding): boolean {
	return a.sessionId === b.sessionId && a.card === b.card;
}

const skill = (cwd: string, dir: string): string => {
	const found = scanSkillFiles(cwd).find(item => item.dir === dir);
	if (!found?.body.trim()) throw new Error(`缺少 ${dir} Skill`);
	return found.body;
};

const modelText = async (host: NovelPlayModelHost, systemPrompt: string, userText: string, signal?: AbortSignal, maxTokens = 8192): Promise<string> => {
	const result = await host.runSideText("novelDigest", systemPrompt, userText, { maxTokens, signal, forceNonStreaming: true });
	if (typeof result !== "string") throw new Error(result.error || "模型调用失败");
	return result;
};

export function readyCorpusSource(cwd: string, docId: string): { document: Pick<CorpusDocument, "id" | "title" | "status" | "chars" | "chunkCount">; text: string } {
	if (typeof docId !== "string" || !docId.trim()) throw new Error("缺少 docId");
	const document = loadCorpusDocuments(cwd).find(item => item.id === docId);
	if (!document) throw new Error("文档不存在");
	if (document.status !== "ready") throw new Error("小说尚未消化完成");
	const root = corpusTextsDir(cwd);
	const textFile = join(root, `${document.id}.txt`);
	if (!resolve(textFile).startsWith(`${resolve(root)}${sep}`)) throw new Error("非法文档标识");
	let realRoot: string; let realTextFile: string;
	try { realRoot = realpathSync(root); realTextFile = realpathSync(textFile); }
	catch { throw new Error("小说原文文件不可用"); }
	const rel = relative(realRoot, realTextFile);
	if (!rel || rel.startsWith("..") || rel.startsWith(sep)) throw new Error("小说原文文件越界");
	if (realTextFile !== join(realRoot, `${document.id}.txt`)) throw new Error("小说原文归属无效");
	const text = readFileSync(realTextFile, "utf8");
	if (!text.trim() || text.length !== document.chars) throw new Error("小说原文与文档长度不一致");
	return { document, text };
}

export async function buildPackage(host: NovelPlayModelHost, docId: string, signal?: AbortSignal): Promise<PackagePublicDto> {
	const { document, text } = readyCorpusSource(host.cwd, docId);
	const pkg = await buildNovelEvents({
		cwd: host.cwd, document, storedText: text, signal,
		modelCall: async input => modelText(host, input.skillBody, JSON.stringify({ source: input.source, chunk: input.chunk, attempt: input.attempt, previous_validation_error: input.previousValidationError }, null, 2), input.signal),
	});
	return packageDto(document.title, pkg);
}

export async function buildPackageWithProgress(host: NovelPlayModelHost, docId: string, signal: AbortSignal | undefined, onProgress: (completed: number, total: number) => void): Promise<PackagePublicDto> {
	const { document, text } = readyCorpusSource(host.cwd, docId);
	const pkg = await buildNovelEvents({
		cwd: host.cwd, document, storedText: text, signal, onProgress,
		modelCall: async input => modelText(host, input.skillBody, JSON.stringify({ source: input.source, chunk: input.chunk, attempt: input.attempt, previous_validation_error: input.previousValidationError }, null, 2), input.signal),
	});
	return packageDto(document.title, pkg);
}

export async function extendPackageWithProgress(host: NovelPlayModelHost, baseDocId: string, baseRevision: string, targetDocId: string, signal: AbortSignal | undefined, onProgress: (completed: number, total: number) => void): Promise<PackagePublicDto & { parentRevision: string; inheritedNodes: number; newNodes: number }> {
	const base = loadNovelPackage(host.cwd, baseDocId, baseRevision);
	const target = readyCorpusSource(host.cwd, targetDocId);
	const extensionSkill = scanSkillFiles(host.cwd).find(item => item.dir === "小说续更事件提取")?.body;
	if (!extensionSkill?.trim()) throw new Error("缺少小说续更事件提取 Skill");
	let layout: TextChunk[] | undefined;
	try {
		const digest = readJsonFile(join(corpusDigestsDir(host.cwd), `${targetDocId}.json`)) as { layout?: TextChunk[] };
		if (Array.isArray(digest.layout)) layout = digest.layout;
	} catch { /* A normal layout is used for legacy corpus documents. */ }
	const targetSource = prepareNovelSource(target.document, target.text, undefined, layout);
	const pkg = await extendNovelPackage({
		base,
		target: { source: targetSource, packageDocId: targetDocId },
		skillBody: extensionSkill,
		signal,
		onProgress,
		modelCall: async input => modelText(host, input.skillBody, JSON.stringify({ source: input.source, chunk: input.chunk, attempt: input.attempt, previous_validation_error: input.previousValidationError }, null, 2), input.signal),
	});
	saveNovelPackage(host.cwd, targetSource, pkg);
	return { ...packageDto(target.document.title, pkg), parentRevision: base.package.revision, inheritedNodes: pkg.lineage?.inheritedNodeIds.length ?? 0, newNodes: pkg.lineage?.newNodeIds.length ?? 0 };
}

export function packageDto(title: string, pkg: NovelPackage): PackagePublicDto {
	return { docId: pkg.docId, title, revision: pkg.revision, stageCount: pkg.stages.length, nodeCount: pkg.nodes.length, builtAt: new Date().toISOString() };
}

export async function buildCharacterProfilesWithProgress(host: NovelPlayModelHost, docId: string, revision: string, signal: AbortSignal | undefined, onProgress: (completed: number, total: number) => void): Promise<{ docId: string; revision: string; profileCount: number; completedChunks: number; totalChunks: number }> {
	const value = stored(host, docId, revision);
	const corpus = await buildNovelCharacterProfileCorpus({
		cwd: host.cwd, source: value.source, revision,
		onProgress,
		modelCall: async (systemPrompt, userText, callSignal) => modelText(host, systemPrompt, userText, callSignal, 16_000),
		signal,
	});
	return { docId, revision, profileCount: corpus.profiles.length, completedChunks: corpus.completedChunks.length, totalChunks: value.source.chunks.length };
}

export function loadCharacterProfiles(host: NovelPlayModelHost, docId: string, revision: string): NovelCharacterProfileCorpus | undefined {
	stored(host, docId, revision);
	return loadNovelCharacterProfileCorpus(host.cwd, docId, revision);
}

export function applyCharacterProfilesToCard(cwd: string, cardPath: string, docId: string, revision: string): { card: string; profileCount: number } {
	const corpus = loadNovelCharacterProfileCorpus(cwd, docId, revision);
	if (!corpus || corpus.completedChunks.length === 0) throw new Error("人物资料库尚未完成");
	const storedPackage = loadNovelPackage(cwd, docId, revision);
	if (corpus.completedChunks.length !== storedPackage.source.chunks.length) throw new Error("人物资料库尚未完成全部原文分块，不能覆盖角色卡");
	const absolute = resolve(cwd, cardPath);
	const cardsRoot = realpathSync(join(cwd, "assets", "cards"));
	const candidate = realpathSync(absolute);
	const relativeCard = relative(cardsRoot, candidate);
	if (!relativeCard || relativeCard.startsWith("..") || relativeCard.startsWith(sep)) throw new Error("角色卡路径不在 cards 目录内");
	const { raw } = readCardRawJson(candidate);
	const data = raw.data as Record<string, unknown>;
	const extensions = (data.extensions as Record<string, unknown> | undefined)?.liyuanNovelPlay as Record<string, unknown> | undefined;
	if (!extensions || extensions.docId !== docId || extensions.revision !== revision) throw new Error("角色卡未绑定指定小说作品包");
	const existing = data.character_book && typeof data.character_book === "object" ? data.character_book as Record<string, unknown> : {};
	const entries = Array.isArray(existing.entries) ? existing.entries.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const row = entry as Record<string, unknown>;
		const order = Number(row.insertion_order ?? row.order ?? 0);
		return order < 120;
	}) : [];
	const profileEntries = corpus.profiles.map((profile, index) => ({ uid: index + 120, keys: profile.keys, secondaryKeys: [], comment: profile.name, content: profile.content, constant: false, enabled: true, selective: true, order: 120 + index }));
	data.character_book = { ...existing, entries: [...entries, ...((entriesToCharacterBook(profileEntries).entries as unknown[]) ?? [])] };
	const temporary = `${candidate}.${randomUUID()}.tmp`;
	try { writeFileSync(temporary, `${JSON.stringify(raw, null, "\t")}\n`, { encoding: "utf8", flag: "wx" }); renameSync(temporary, candidate); } finally { rmSync(temporary, { force: true }); }
	return { card: cardPath, profileCount: corpus.profiles.length };
}

function stored(host: NovelPlayModelHost, docId: string, revision: string): StoredNovelPackage {
	const source = readyCorpusSource(host.cwd, docId);
	const value = loadNovelPackage(host.cwd, docId, revision);
	if (value.source.fingerprint !== value.package.sourceFingerprint || !value.source.fingerprint) throw new Error("作品包原文身份无效");
	if (value.source.fingerprint !== sha256(source.text)) throw new Error("作品包已过期，请重新构建");
	return value;
}

export function startOptions(host: NovelPlayModelHost, docId: string, revision: string): StartOptionDto {
	const value = stored(host, docId, revision);
	const stages = new Map(value.package.stages.map((stage, index) => [stage.id, { order: index + 1, title: stage.title }]));
	return {
		docId, revision, title: value.source.title,
		capabilities: { playerModes: ["new-character", "existing-character"], startKinds: ["node", "source-end"] },
		sourceEnd: { kind: "source-end", chapterLabel: value.source.chunks.at(-1)?.chapters.join(" / ") || "原文终点", sourceChars: value.source.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) },
		nodes: value.package.nodes.filter(node => node.visibility === "public").map(node => ({
			nodeId: node.id,
			title: node.title,
			summary: node.summary,
			stageTitle: stages.get(node.stageId)?.title ?? `分块 ${node.order + 1}`,
			stageOrder: stages.get(node.stageId)?.order ?? 0,
			nodeOrder: node.order + 1,
			source: { chunkIndex: node.sourceRefs[0]?.chunkIndex ?? 0, chapters: value.source.chunks.find(chunk => chunk.index === node.sourceRefs[0]?.chunkIndex)?.chapters ?? [] },
		})),
	};
}

export async function createOpeningProposal(host: NovelPlayModelHost, input: { docId: string; revision: string; nodeId?: string; position?: "before" | "after"; startKind?: "node" | "source-end"; player: { name: string; identity: string; mode?: "new-character" | "existing-character" } }, signal?: AbortSignal): Promise<{ proposal: NovelOpeningProposal; stored: StoredNovelPackage; anchor: NovelAnchor }> {
	const value = stored(host, input.docId, input.revision);
	const anchor: NovelAnchor = input.startKind === "source-end" ? { kind: "source-end", packageRevision: input.revision } : { packageRevision: input.revision, nodeId: input.nodeId!, position: input.position! };
	const proposal = await extractNovelOpening({
		stored: value, anchor, player: input.player, skillBody: skill(host.cwd, "小说开场提取"), signal,
		modelCall: async (request, options) => modelText(host, request.systemPrompt, request.userText, options.signal),
	});
	const profileSkill = scanSkillFiles(host.cwd).find(item => item.dir === "小说人物画像提取")?.body;
	if (!profileSkill) return { proposal, stored: value, anchor };
	const profiled = await extractNovelCharacterProfiles({ stored: value, proposal, skillBody: profileSkill, signal, maxAttempts: 3, modelCall: async (request, options) => modelText(host, request.systemPrompt, request.userText, options.signal, 16_000) });
	return { proposal: profiled, stored: value, anchor };
}

function activeNovelCard(host: NovelPlayModelHost, card: string): boolean {
	if (!card) return false;
	try {
		const cardsRoot = realpathSync(join(host.cwd, "assets", "cards"));
		const candidate = realpathSync(resolve(host.cwd, card));
		const rel = relative(cardsRoot, candidate);
		if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return false;
		const { raw } = readCardRawJson(candidate);
		const data = raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : raw;
		const extensions = data.extensions && typeof data.extensions === "object" ? data.extensions as Record<string, unknown> : {};
		return Boolean(extensions.liyuanNovelPlay);
	} catch { return false; }
}

function configCard(bytes: string): string | undefined {
	try {
		const value = JSON.parse(bytes) as { card?: unknown };
		return typeof value.card === "string" ? value.card : undefined;
	} catch { return undefined; }
}

function restoreOwnedPreSwitch(before: ReturnType<typeof loadRawConfig>, ownedBytes: string, relativeCard: string, cardFile: string, host: NovelPlayModelHost, binding: NovelPlayBinding): void {
	let current: string;
	try { current = readFileSync(before.path, "utf8"); } catch { return; }
	let scope: ReturnType<NovelPlayModelHost["memoryScope"]>;
	try { scope = host.memoryScope(); } catch { return; }
	if (scope.sessionId !== binding.sessionId || String(scope.card ?? "") !== binding.card) return;
	if (ownedBytes && current === ownedBytes) {
		try {
			if (before.existed) atomicWrite(before.path, before.bytes); else rmSync(before.path, { force: true });
		} catch { return; }
		try { rmSync(cardFile, { force: true }); } catch { /* Preserve the original start error. */ }
		return;
	}
	const currentCard = configCard(current);
	if (currentCard === undefined || currentCard === relativeCard) return;
	try { rmSync(cardFile, { force: true }); } catch { /* Preserve the original start error. */ }
}

export async function startFromConfirmedProposal(host: NovelPlayModelHost, input: { stored: StoredNovelPackage; anchor: NovelAnchor; proposal: NovelOpeningProposal }, expected: NovelPlayBinding, onSwitchPrepared?: (card: string) => void): Promise<StartResult> {
	if (input.proposal.confirmed !== false) throw new Error("预览状态无效");
	if (!sameNovelPlayBinding(novelPlayBinding(host), expected)) throw new Error("会话或角色卡已变化，请重新预览");
	const before = loadRawConfig(host.cwd);
	if (activeNovelCard(host, before.config.card)) throw new Error("当前已有小说开演会话，请先切到普通角色卡");
	const confirmed = { ...input.proposal.draft, confirmed: true as const };
	const fullProfiles = loadNovelCharacterProfileCorpus(host.cwd, input.stored.package.docId, input.stored.package.revision);
	if (fullProfiles?.profiles.length) {
		confirmed.characterProfiles = fullProfiles.profiles.map(profile => ({ name: profile.name, keys: profile.keys, content: profile.content, evidenceQuotes: profile.evidence.map(item => item.quote).filter(Boolean) }));
	}
	const mode = confirmed.user.mode === "existing-character" ? "existing-character" : "new-character";
	const raw: NovelPlayRawCard = buildNovelPlayCard({ mode, workTitle: input.stored.source.title, pkg: input.stored.package, anchor: input.anchor, snapshot: confirmed, characterProfiles: fullProfiles?.profiles.map(profile => ({ name: profile.name, keys: profile.keys, content: profile.content, evidenceQuotes: profile.evidence.map(item => item.quote).filter(Boolean) })), skillBody: skill(host.cwd, "小说开演边界") });
	const cardsDir = join(host.cwd, "assets", "cards");
	mkdirSync(cardsDir, { recursive: true });
	const relativeCard = `assets/cards/novel-play-${randomUUID()}.json`;
	const absoluteCard = join(host.cwd, relativeCard);
	let ownedBytes = "";
	try {
		writeFileSync(absoluteCard, `${JSON.stringify(raw, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
		const next = { ...before.config, userName: confirmed.user.name, userPersona: confirmed.user.identity, card: relativeCard };
		ownedBytes = `${JSON.stringify(next, null, "\t")}\n`;
		atomicWrite(before.path, ownedBytes);
		const afterScope = host.memoryScope();
		if (afterScope.sessionId !== expected.sessionId || String(afterScope.card ?? "") !== expected.card || readFileSync(before.path, "utf8") !== ownedBytes) throw new Error("配置写入期间会话发生变化");
		onSwitchPrepared?.(relativeCard);
	} catch (error) {
		restoreOwnedPreSwitch(before, ownedBytes, relativeCard, absoluteCard, host, expected);
		throw error;
	}
	try {
		const switched = await host.switchToCard();
		if (switched !== "created") return { card: relativeCard, session: "recovery-required", recovery: "角色切换结果不确定。已保留新角色卡和配置，请检查当前会话。" };
		const actual = novelPlayBinding(host);
		if (actual.card !== relativeCard || actual.sessionId === expected.sessionId) return { card: relativeCard, session: "recovery-required", recovery: "角色切换结果不确定。已保留新角色卡和配置，请检查当前会话。" };
		return { card: relativeCard, session: "created" };
	} catch {
		return { card: relativeCard, session: "recovery-required", recovery: "角色切换可能已部分成功。已保留新角色卡和配置，请检查当前会话后手动恢复。" };
	}
}
