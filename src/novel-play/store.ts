import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile } from "../jsonio.ts";
import { buildNovelPackage } from "./canon.ts";
import type { NovelNode, NovelPackage, NovelStage } from "./canon.ts";
import type { NovelSource } from "./source.ts";

/** The source is validation evidence and may contain full chunks. It is never writer input. */
export interface StoredNovelPackage {
	version: 1;
	source: NovelSource;
	package: NovelPackage;
}

const STORE_VERSION = 1;
const asRecord = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
};
const asString = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
};
const asInteger = (value: unknown, label: string, minimum = 0): number => {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`);
	return value as number;
};
const asArray = (value: unknown, label: string): unknown[] => {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
};
const asStringArray = (value: unknown, label: string): string[] => asArray(value, label).map((item, index) => asString(item, `${label}[${index}]`));

function parseSource(value: unknown): NovelSource {
	const raw = asRecord(value, "source");
	if (raw.version !== 1) throw new Error("source.version must be 1");
	const chunks = asArray(raw.chunks, "source.chunks").map((value, index) => {
		const chunk = asRecord(value, `source.chunks[${index}]`);
		return {
			index: asInteger(chunk.index, `source.chunks[${index}].index`),
			chars: asInteger(chunk.chars, `source.chunks[${index}].chars`),
			chapters: asStringArray(chunk.chapters, `source.chunks[${index}].chapters`),
			text: asString(chunk.text, `source.chunks[${index}].text`),
		};
	});
	const source: NovelSource = {
		version: 1,
		docId: asString(raw.docId, "source.docId"),
		title: asString(raw.title, "source.title"),
		fingerprint: asString(raw.fingerprint, "source.fingerprint"),
		chunkChars: asInteger(raw.chunkChars, "source.chunkChars", 1),
		chunks,
		...(typeof raw.workId === "string" && raw.workId.trim() ? { workId: raw.workId } : {}),
	};
	const indexes = new Set<number>();
	for (const chunk of source.chunks) {
		if (indexes.has(chunk.index) || chunk.chars !== chunk.text.length) throw new Error("source chunks have invalid indexes or character counts");
		indexes.add(chunk.index);
	}
	return source;
}

function parseStages(value: unknown): NovelStage[] {
	return asArray(value, "package.stages").map((value, index) => {
		const raw = asRecord(value, `package.stages[${index}]`);
		return { id: asString(raw.id, `package.stages[${index}].id`), order: asInteger(raw.order, `package.stages[${index}].order`), title: asString(raw.title, `package.stages[${index}].title`) };
	});
}

function parseNodes(value: unknown): NovelNode[] {
	return asArray(value, "package.nodes").map((value, index) => {
		const raw = asRecord(value, `package.nodes[${index}]`);
		const visibility = raw.visibility;
		if (visibility !== "public" && visibility !== "secret") throw new Error(`package.nodes[${index}].visibility is invalid`);
		const sourceRefs = asArray(raw.sourceRefs, `package.nodes[${index}].sourceRefs`).map((value, refIndex) => {
			const ref = asRecord(value, `package.nodes[${index}].sourceRefs[${refIndex}]`);
			return {
				chunkIndex: asInteger(ref.chunkIndex, `package.nodes[${index}].sourceRefs[${refIndex}].chunkIndex`),
				start: asInteger(ref.start, `package.nodes[${index}].sourceRefs[${refIndex}].start`),
				end: asInteger(ref.end, `package.nodes[${index}].sourceRefs[${refIndex}].end`, 1),
				quote: asString(ref.quote, `package.nodes[${index}].sourceRefs[${refIndex}].quote`),
			};
		});
		return {
			id: asString(raw.id, `package.nodes[${index}].id`),
			key: asString(raw.key, `package.nodes[${index}].key`),
			stageId: asString(raw.stageId, `package.nodes[${index}].stageId`),
			order: asInteger(raw.order, `package.nodes[${index}].order`),
			title: asString(raw.title, `package.nodes[${index}].title`),
			summary: asString(raw.summary, `package.nodes[${index}].summary`),
			visibility,
			dependsOn: asStringArray(raw.dependsOn, `package.nodes[${index}].dependsOn`),
			sourceRefs,
		};
	});
}

function validateStoredNovelPackage(value: unknown): StoredNovelPackage {
	const raw = asRecord(value, "stored novel package");
	if (raw.version !== STORE_VERSION) throw new Error(`stored novel package version must be ${STORE_VERSION}`);
	const source = parseSource(raw.source);
	const pkg = asRecord(raw.package, "package");
	if (pkg.version !== 1) throw new Error("package.version must be 1");
	const declaredRevision = asString(pkg.revision, "package.revision");
	if (asString(pkg.docId, "package.docId") !== source.docId
		|| asString(pkg.sourceFingerprint, "package.sourceFingerprint") !== source.fingerprint
		|| asInteger(pkg.sourceChunkChars, "package.sourceChunkChars", 1) !== source.chunkChars) {
		throw new Error("package source identity does not match stored source evidence");
	}
	let lineage: NovelPackage["lineage"];
	if (pkg.lineage !== undefined) {
		const value = asRecord(pkg.lineage, "package.lineage");
		if (value.relation !== "append-only") throw new Error("package.lineage.relation is invalid");
		lineage = {
			parentDocId: asString(value.parentDocId, "package.lineage.parentDocId"),
			parentRevision: asString(value.parentRevision, "package.lineage.parentRevision"),
			relation: "append-only",
			inheritedNodeIds: asStringArray(value.inheritedNodeIds, "package.lineage.inheritedNodeIds"),
			newNodeIds: asStringArray(value.newNodeIds, "package.lineage.newNodeIds"),
		};
	}
	const rebuilt = buildNovelPackage(source, parseStages(pkg.stages), parseNodes(pkg.nodes), lineage);
	if (rebuilt.revision !== declaredRevision) throw new Error("package revision does not match canonical package content");
	const result: StoredNovelPackage = { version: 1, source, package: rebuilt };
	if (JSON.stringify(raw) !== JSON.stringify(result)) throw new Error("stored novel package is not in canonical form");
	return result;
}

const hashId = (kind: string, value: string): string => createHash("sha256").update(JSON.stringify([kind, value])).digest("hex");

export const novelPlayStoreRoot = (cwd: string): string => join(cwd, ".liyuan", "novel-play");
const packageIndexFile = (cwd: string): string => join(novelPlayStoreRoot(cwd), "package-index.json");
export interface NovelPackageIndexEntry { docId: string; workId?: string; revision: string; sourceFingerprint: string; parentDocId?: string; parentRevision?: string; relation?: "append-only"; stageCount: number; nodeCount: number; createdAt: string; }
export function listNovelPackageIndex(cwd: string): NovelPackageIndexEntry[] {
	const known = new Map<string, NovelPackageIndexEntry>();
	try { const value = JSON.parse(readFileSync(packageIndexFile(cwd), "utf8")); if (Array.isArray(value)) for (const item of value) if (item?.docId && item?.revision) known.set(`${item.docId}:${item.revision}`, item as NovelPackageIndexEntry); } catch { /* Rebuild from immutable package files below. */ }
	const root = join(novelPlayStoreRoot(cwd), "packages");
	const scan = (dir: string): void => {
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) { scan(file); continue; }
			if (!entry.name.endsWith(".json")) continue;
			try {
				const raw = JSON.parse(readFileSync(file, "utf8")) as { source?: NovelSource; package?: NovelPackage };
				if (!raw.source || !raw.package?.docId || !raw.package.revision) continue;
				const pkg = raw.package, key = `${pkg.docId}:${pkg.revision}`, lineage = pkg.lineage;
				known.set(key, { docId: pkg.docId, ...(raw.source.workId ? { workId: raw.source.workId } : {}), revision: pkg.revision, sourceFingerprint: pkg.sourceFingerprint, ...(lineage ? { parentDocId: lineage.parentDocId, parentRevision: lineage.parentRevision, relation: lineage.relation } : {}), stageCount: pkg.stages.length, nodeCount: pkg.nodes.length, createdAt: new Date(0).toISOString() });
			} catch { /* Ignore unrelated or corrupt files; loadNovelPackage remains strict. */ }
		}
	};
	scan(root);
	return [...known.values()];
}
function writePackageIndex(cwd: string, entries: NovelPackageIndexEntry[]): void {
	const file = packageIndexFile(cwd); mkdirSync(dirname(file), { recursive: true }); const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
	try { writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8"); renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
}

/** IDs are only hash inputs. They are never interpreted as file-system paths. */
export function novelPackageFile(cwd: string, docId: string, revision: string): string {
	asString(docId, "docId");
	asString(revision, "revision");
	return join(novelPlayStoreRoot(cwd), "packages", hashId("document", docId), `${hashId("revision", revision)}.json`);
}

export function loadNovelPackage(cwd: string, docId: string, revision: string): StoredNovelPackage {
	const file = novelPackageFile(cwd, docId, revision);
	let raw: unknown;
	try {
		raw = readJsonFile(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`novel package revision not found: ${docId}@${revision}`);
		throw error;
	}
	const stored = validateStoredNovelPackage(raw);
	if (stored.source.docId !== docId || stored.package.revision !== revision) throw new Error("stored novel package does not match requested document and revision");
	return stored;
}

export function saveNovelPackage(cwd: string, source: NovelSource, pkg: NovelPackage): string {
	const stored = validateStoredNovelPackage({ version: 1, source, package: pkg });
	const file = novelPackageFile(cwd, stored.source.docId, stored.package.revision);
	mkdirSync(dirname(file), { recursive: true });
	const serialized = `${JSON.stringify(stored, null, 2)}\n`;
	const temporary = join(dirname(file), `.${randomBytes(16).toString("hex")}.tmp`);
	try {
		writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
		try {
			linkSync(temporary, file);
			const lineage = pkg.lineage;
			const entries = listNovelPackageIndex(cwd).filter(item => !(item.docId === pkg.docId && item.revision === pkg.revision));
			entries.push({ docId: pkg.docId, ...(source.workId ? { workId: source.workId } : {}), revision: pkg.revision, sourceFingerprint: pkg.sourceFingerprint, ...(lineage ? { parentDocId: lineage.parentDocId, parentRevision: lineage.parentRevision, relation: lineage.relation } : {}), stageCount: pkg.stages.length, nodeCount: pkg.nodes.length, createdAt: new Date().toISOString() });
			writePackageIndex(cwd, entries);
			return file;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = loadNovelPackage(cwd, stored.source.docId, stored.package.revision);
			if (JSON.stringify(existing) !== JSON.stringify(stored)) throw new Error("immutable novel package revision already exists with different content");
			return file;
		}
	} finally {
		rmSync(temporary, { force: true });
	}
}
