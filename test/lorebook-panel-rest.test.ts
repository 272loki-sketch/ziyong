import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { exportCardFile, extractPngTextChunks, loadCardFile, readCardJsonFromPng, writeCardJsonToPng } from "../src/card.ts";
import { loadLorebookFile, loreFingerprint } from "../src/lorebook.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { configPath, handleApiRequest, loadConfig, type RestHost } from "../server/rest.ts";

type FixtureEntry = {
	id: number;
	comment: string;
	content: string;
	enabled: boolean;
};

function cardJson(name: string, entries: FixtureEntry[]): Record<string, unknown> {
	return {
		spec: "chara_card_v3",
		spec_version: "3.0",
		fixtureUnknownEnvelopeField: ["preserve", 17],
		data: {
			name,
			description: "合成 REST 回归卡",
			creator_notes: "offline fixture",
			fixtureUnknownCardField: { preserve: "card-level" },
			character_book: {
				name: `${name} 内嵌书`,
				fixtureUnknownBookField: "preserve-book-level",
				entries: entries.map((entry) => ({
					...entry,
					keys: [entry.comment],
					secondary_keys: [],
					constant: false,
					selective: false,
					insertion_order: 10,
					position: "before_char",
					extensions: { fixtureUnknownEntryField: "preserve-entry-level" },
				})),
			},
		},
	};
}

function seedCard(cwd: string, relativePath: string, name: string, entries: FixtureEntry[]): string {
	const path = join(cwd, relativePath);
	writeFileSync(path, `${JSON.stringify(cardJson(name, entries), null, 2)}\n`, "utf8");
	return path;
}

function setCurrentCard(cwd: string, relativePath: string, extra: Record<string, unknown> = {}): void {
	writeFileSync(configPath(cwd), `${JSON.stringify({ ...DEFAULT_CONFIG, card: relativePath, ...extra }, null, 2)}\n`, "utf8");
}

function seedLorebook(cwd: string, relativePath: string, name: string, entries: FixtureEntry[]): string {
	const path = join(cwd, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	const rawEntries: Record<string, unknown> = {};
	entries.forEach((entry, index) => {
		rawEntries[String(index)] = {
			uid: entry.id,
			key: [entry.comment],
			keysecondary: [],
			comment: entry.comment,
			content: entry.content,
			constant: false,
			selective: false,
			disable: !entry.enabled,
			order: 10,
			fixtureUnknownFileEntry: "preserve-file-entry",
		};
	});
	writeFileSync(path, `${JSON.stringify({ name, entries: rawEntries, fixtureUnknownFileBook: "preserve-file-book" }, null, 2)}\n`, "utf8");
	return path;
}

function seedPngCard(cwd: string, relativePath: string, name: string, entries: FixtureEntry[]): string {
	const sourcePath = seedCard(cwd, `${relativePath}.source.json`, name, entries);
	const exported = exportCardFile(sourcePath, { format: "png", loreMode: "embedded" });
	const raw = readCardJsonFromPng(exported.body) as Record<string, any>;
	const data = raw.data as Record<string, any>;
	data.fixtureUnknownPngField = { preserve: "png-card-level" };
	data.character_book.fixtureUnknownBookField = "preserve-book-level";
	data.character_book.fixtureUnknownPngBookField = "preserve-png-book-level";
	data.character_book.entries[0].fixtureUnknownPngEntryField = "preserve-png-entry-level";
	const path = join(cwd, relativePath);
	writeFileSync(path, writeCardJsonToPng(exported.body, raw));
	rmSync(sourcePath, { force: true });
	return path;
}

function cardViewUrl(cardIdentity?: string): string {
	return `/api/lorebook?source=card${cardIdentity ? `&cardIdentity=${encodeURIComponent(cardIdentity)}` : ""}`;
}

function entryUrl(input: { source?: string; fingerprint: string; cardIdentity?: string; path?: string; entryKey?: string }): string {
	const query = new URLSearchParams({ fp: input.fingerprint });
	if (input.source) query.set("source", input.source);
	if (input.cardIdentity) query.set("cardIdentity", input.cardIdentity);
	if (input.path) query.set("path", input.path);
	if (input.entryKey !== undefined) query.set("entryKey", input.entryKey);
	return `/api/lorebook/entry?${query}`;
}

function exportUrl(input: { source?: string; cardIdentity?: string; path?: string } = {}): string {
	const query = new URLSearchParams();
	if (input.source) query.set("source", input.source);
	if (input.cardIdentity) query.set("cardIdentity", input.cardIdentity);
	if (input.path) query.set("path", input.path);
	return `/api/lorebook/export${query.size ? `?${query}` : ""}`;
}

function exportedEntries(response: { body: any }): any[] {
	return Object.values(response.body.json.entries) as any[];
}

function exportedEntry(response: { body: any }, content: string): any {
	return exportedEntries(response).find((entry) => entry.content === content);
}

function pngIdatData(png: Buffer): Buffer[] {
	const chunks: Buffer[] = [];
	let offset = 8;
	while (offset + 12 <= png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const end = offset + 8 + length;
		assert.ok(end + 4 <= png.length, "synthetic PNG chunks must be complete");
		if (type === "IDAT") chunks.push(Buffer.from(png.subarray(offset + 8, end)));
		offset = end + 4;
		if (type === "IEND") break;
	}
	return chunks;
}

function pngTextChunk(png: Buffer, keyword: string): Buffer {
	let offset = 8;
	while (offset + 12 <= png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const start = offset + 8;
		const end = start + length;
		assert.ok(end + 4 <= png.length, "synthetic PNG chunks must be complete");
		if (type === "tEXt") {
			const data = png.subarray(start, end);
			const separator = data.indexOf(0);
			if (separator > 0 && data.toString("latin1", 0, separator) === keyword) return Buffer.from(png.subarray(offset, end + 4));
		}
		offset = end + 4;
		if (type === "IEND") break;
	}
	throw new Error(`synthetic PNG missing tEXt ${keyword}`);
}

function pngTextKeywordCount(png: Buffer, keyword: string): number {
	let count = 0;
	let offset = 8;
	while (offset + 12 <= png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		const start = offset + 8;
		const end = start + length;
		assert.ok(end + 4 <= png.length, "synthetic PNG chunks must be complete");
		if (type === "tEXt") {
			const data = png.subarray(start, end);
			const separator = data.indexOf(0);
			if (separator > 0 && data.toString("latin1", 0, separator) === keyword) count++;
		}
		offset = end + 4;
		if (type === "IEND") break;
	}
	return count;
}

function makePngTextChunk(keyword: "ccv3" | "chara", card: Record<string, unknown>): Buffer {
	const data = Buffer.concat([
		Buffer.from(keyword, "latin1"),
		Buffer.from([0]),
		Buffer.from(Buffer.from(JSON.stringify(card), "utf8").toString("base64"), "latin1"),
	]);
	const type = Buffer.from("tEXt", "ascii");
	const crcInput = Buffer.concat([type, data]);
	let crc = 0xffffffff;
	for (const byte of crcInput) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, type, data, checksum]);
}

function appendPngChunkBeforeIend(png: Buffer, chunk: Buffer): Buffer {
	let offset = 8;
	while (offset + 12 <= png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		if (type === "IEND") return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset)]);
		offset += length + 12;
	}
	throw new Error("synthetic PNG missing IEND");
}

function jsonFromPngText(png: Buffer, keyword: "ccv3" | "chara"): Record<string, any> {
	const encoded = extractPngTextChunks(png)[keyword];
	assert.ok(encoded, `PNG should retain ${keyword} card metadata`);
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

async function fixture(run: (cwd: string, host: RestHost, setStreaming: (value: boolean) => void) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-lorebook-panel-rest-"));
	let streaming = false;
	const host = {
		cwd,
		isStreaming: () => streaming,
		softRefreshConfig: async () => undefined,
		notify: () => undefined,
	} as unknown as RestHost;
	try {
		await run(cwd, host, (value) => { streaming = value; });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function request(host: RestHost, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
	const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as Readable & { method: string; url: string };
	req.method = method;
	req.url = url;
	let status = 0;
	let text = "";
	const res = {
		writeHead(code: number) { status = code; },
		end(value = "") { text += value; },
	};
	assert.equal(await handleApiRequest(req as never, res as never, host), true);
	return { status, body: JSON.parse(text) };
}

async function requestWithBodyBarrier(
	host: RestHost,
	method: string,
	url: string,
	payload: unknown,
	whileBodyPending: () => void,
): Promise<{ status: number; body: any }> {
	let bodyStarted!: () => void;
	let releaseBody!: (chunk: Buffer) => void;
	const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
	const body = new Promise<Buffer>((resolve) => { releaseBody = resolve; });
	const source = (async function* () {
		bodyStarted();
		yield await body;
	})();
	const req = Readable.from(source) as Readable & { method: string; url: string };
	req.method = method;
	req.url = url;
	let status = 0;
	let text = "";
	const res = {
		writeHead(code: number) { status = code; },
		end(value = "") { text += value; },
	};
	const handled = handleApiRequest(req as never, res as never, host);
	await started;
	whileBodyPending();
	releaseBody(Buffer.from(JSON.stringify(payload)));
	assert.equal(await handled, true);
	return { status, body: JSON.parse(text) };
}

const seedEntries: FixtureEntry[] = [
	{ id: 1, comment: "默认启用", content: "卡内已启用的合成条目。", enabled: true },
	{ id: 2, comment: "默认关闭", content: "卡内默认关闭但仍可浏览的合成条目。", enabled: false },
	{ id: 3, comment: "第二个关闭项", content: "卡内另一个默认关闭条目。", enabled: false },
];

async function cardDirectory(host: RestHost): Promise<any> {
	const response = await request(host, "GET", "/api/lorebooks");
	assert.equal(response.status, 200);
	assert.ok(response.body.embeddedCard, "目录应包含当前角色卡的内嵌世界书描述");
	return response.body.embeddedCard;
}

test("REST lorebook directory exposes the embedded card book without mounting or writing it", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "合成当前卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const configBefore = readFileSync(configPath(cwd));
	const cardBefore = readFileSync(cardPath);

	const response = await request(host, "GET", "/api/lorebooks");
	assert.equal(response.status, 200);
	const embedded = response.body.embeddedCard;
	assert.deepEqual(readFileSync(configPath(cwd)), configBefore, "只读目录请求不得改写配置或新增挂载");
	assert.deepEqual(readFileSync(cardPath), cardBefore, "只读目录请求不得改写卡文件");
	assert.equal(existsSync(join(cwd, "assets", "lorebooks")), false, "显示内嵌书不应自动导出重复挂载文件");
	assert.ok(embedded, "目录应包含当前角色卡的内嵌世界书描述");
	assert.equal(embedded.path, "fixture-card.json");
	assert.equal(embedded.name, "合成当前卡");
	assert.equal(embedded.entryCount, 3);
	assert.equal(embedded.enabledCount, 1);
	assert.equal(typeof embedded.cardIdentity, "string");
	assert.ok(embedded.cardIdentity.length > 0);
}));

test("REST lorebook card view returns every embedded entry with full content and enabled state", () => fixture(async (cwd, host) => {
	seedCard(cwd, "fixture-card.json", "合成当前卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const embedded = await cardDirectory(host);
	const response = await request(host, "GET", cardViewUrl());

	assert.equal(response.status, 200);
	assert.equal(response.body.viewSource, "card");
	assert.equal(response.body.cardIdentity, embedded.cardIdentity);
	assert.equal(response.body.entries.length, 3, "禁用条目仍须可浏览");
	assert.deepEqual(
		response.body.entries.map((entry: { content: string; enabled: boolean }) => [entry.content, entry.enabled]),
		seedEntries.map((entry) => [entry.content, entry.enabled]),
	);
	assert.ok(response.body.entries.every((entry: { fingerprint?: unknown }) => typeof entry.fingerprint === "string"));
}));

test("REST card toggle changes native enabled state used by card and stage-material loading", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "合成当前卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const embedded = await cardDirectory(host);
	const view = await request(host, "GET", `/api/lorebook?source=card&cardIdentity=${encodeURIComponent(embedded.cardIdentity)}`);
	assert.equal(view.status, 200);
	const target = view.body.entries.find((entry: { content: string }) => entry.content === seedEntries[1].content);
	assert.ok(target, "默认关闭的内嵌条目仍须在来源视图中存在");

	const toggled = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card",
		cardIdentity: embedded.cardIdentity,
		fingerprint: target.fingerprint,
		enabled: true,
	});
	assert.equal(toggled.status, 200);

	assert.equal(loadCardFile(cardPath).book.find((entry) => entry.content === seedEntries[1].content)?.enabled, true,
		"启用操作必须写回卡内原生 enabled 字段，而不只是调整全局 disabledLore");
	assert.equal(loadStageMaterials(cwd).entries.find((entry) => entry.content === seedEntries[1].content)?.enabled, true,
		"原本 enabled:false 的卡内条目在素材加载后必须实际启用");
}));

test("REST lorebook mutations reject a fingerprint without explicit source and identity", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "合成当前卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const before = readFileSync(cardPath);
	const configBefore = readFileSync(configPath(cwd));

	const result = await request(host, "POST", "/api/lorebook/toggle", {
		fingerprint: loreFingerprint(seedEntries[0].content),
		enabled: false,
	});
	assert.ok(result.status < 200 || result.status >= 300, "无来源的 fingerprint 修改必须拒绝，不能猜测命中哪本书");
	assert.deepEqual(readFileSync(cardPath), before);
	assert.deepEqual(readFileSync(configPath(cwd)), configBefore);
}));

test("REST card mutation rejects an identity from a card that is no longer current", () => fixture(async (cwd, host) => {
	const firstPath = seedCard(cwd, "first-card.json", "第一张合成卡", seedEntries);
	const secondEntries = [{ id: 11, comment: "第二张卡条目", content: "仅属于第二张卡。", enabled: true }];
	const secondPath = seedCard(cwd, "second-card.json", "第二张合成卡", secondEntries);
	setCurrentCard(cwd, "first-card.json");
	const directory = await request(host, "GET", "/api/lorebooks");
	const oldIdentity = directory.body.embeddedCard?.cardIdentity ?? "stale-fixture-card-identity";
	const firstBefore = readFileSync(firstPath);
	const secondBefore = readFileSync(secondPath);

	setCurrentCard(cwd, "second-card.json");
	const result = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card",
		cardIdentity: oldIdentity,
		fingerprint: loreFingerprint(seedEntries[0].content),
		enabled: false,
	});
	assert.ok(result.status < 200 || result.status >= 300, "切卡后旧卡身份的写请求必须拒绝");
	assert.deepEqual(readFileSync(firstPath), firstBefore, "旧卡请求不得继续修改旧卡");
	assert.deepEqual(readFileSync(secondPath), secondBefore, "旧卡请求不得把同 fingerprint 写入当前卡");
}));

test("REST card edit and delete are source-scoped and preserve unknown JSON card fields", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "JSON 未知字段合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const beforeRaw = JSON.parse(readFileSync(cardPath, "utf8"));
	let identity = (await cardDirectory(host)).cardIdentity;
	let view = await request(host, "GET", cardViewUrl());
	const selected = view.body.entries.find((entry: { content: string }) => entry.content === seedEntries[0].content);
	const single = await request(host, "GET", entryUrl({ source: "card", cardIdentity: identity, fingerprint: selected.fingerprint }));
	assert.equal(single.status, 200);
	assert.equal(single.body.content, seedEntries[0].content, "单条 GET 应返回全文");
	assert.equal(single.body.cardIdentity, identity);

	const editedContent = "JSON 合成卡已修改正文，未知字段必须保留。";
	const edited = await request(host, "PUT", "/api/lorebook/entry", {
		source: "card", cardIdentity: identity, fingerprint: selected.fingerprint,
		comment: "JSON 修改后标题", content: editedContent,
	});
	assert.equal(edited.status, 200);
	const afterEdit = JSON.parse(readFileSync(cardPath, "utf8"));
	assert.deepEqual(afterEdit.fixtureUnknownEnvelopeField, beforeRaw.fixtureUnknownEnvelopeField);
	assert.deepEqual(afterEdit.data.fixtureUnknownCardField, beforeRaw.data.fixtureUnknownCardField);
	assert.equal(afterEdit.data.character_book.fixtureUnknownBookField, "preserve-book-level");
	assert.deepEqual(afterEdit.data.character_book.entries[0].extensions, { fixtureUnknownEntryField: "preserve-entry-level" });
	assert.equal(afterEdit.data.character_book.entries.find((entry: any) => entry.content === editedContent)?.comment, "JSON 修改后标题");

	identity = (await cardDirectory(host)).cardIdentity;
	view = await request(host, "GET", cardViewUrl());
	const editedEntry = view.body.entries.find((entry: { content: string }) => entry.content === editedContent);
	const deleted = await request(host, "DELETE", entryUrl({ source: "card", cardIdentity: identity, fingerprint: editedEntry.fingerprint }));
	assert.equal(deleted.status, 200);
	const afterDelete = JSON.parse(readFileSync(cardPath, "utf8"));
	assert.equal(afterDelete.data.character_book.entries.some((entry: any) => entry.content === editedContent), false);
	assert.equal(afterDelete.data.character_book.entries.length, seedEntries.length - 1);
	assert.deepEqual(afterDelete.fixtureUnknownEnvelopeField, beforeRaw.fixtureUnknownEnvelopeField);
	assert.deepEqual(afterDelete.data.fixtureUnknownCardField, beforeRaw.data.fixtureUnknownCardField);
	assert.equal(afterDelete.data.character_book.fixtureUnknownBookField, "preserve-book-level");
}));

test("REST card PNG mutation preserves unknown card fields and pixel IDAT data", () => fixture(async (cwd, host) => {
	const pngPath = seedPngCard(cwd, "fixture-card.png", "PNG 未知字段合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.png");
	const beforePng = readFileSync(pngPath);
	const beforeIdat = pngIdatData(beforePng);
	const beforeRaw = readCardJsonFromPng(beforePng) as Record<string, any>;
	const identity = (await cardDirectory(host)).cardIdentity;
	const view = await request(host, "GET", cardViewUrl());
	const selected = view.body.entries.find((entry: { content: string }) => entry.content === seedEntries[1].content);

	const toggled = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint: selected.fingerprint, enabled: true,
	});
	assert.equal(toggled.status, 200);
	const afterPng = readFileSync(pngPath);
	const afterRaw = readCardJsonFromPng(afterPng) as Record<string, any>;
	assert.deepEqual(pngIdatData(afterPng), beforeIdat, "PNG 像素压缩数据必须逐字节保持不变");
	assert.deepEqual(afterRaw.fixtureUnknownEnvelopeField, beforeRaw.fixtureUnknownEnvelopeField);
	assert.deepEqual(afterRaw.data.fixtureUnknownCardField, beforeRaw.data.fixtureUnknownCardField);
	assert.deepEqual(afterRaw.data.fixtureUnknownPngField, { preserve: "png-card-level" });
	assert.equal(afterRaw.data.character_book.fixtureUnknownBookField, "preserve-book-level");
	assert.equal(afterRaw.data.character_book.fixtureUnknownPngBookField, "preserve-png-book-level");
	assert.equal(afterRaw.data.character_book.entries[0].fixtureUnknownPngEntryField, "preserve-png-entry-level");
	assert.equal(loadCardFile(pngPath).book.find((entry) => entry.content === seedEntries[1].content)?.enabled, true);
}));

test("REST lorebook edit synchronizes embedded books in existing ccv3 and chara PNG chunks only", () => fixture(async (cwd, host) => {
	const sourcePath = seedCard(cwd, "dual-source.json", "双副本合成卡", seedEntries);
	const basePng = exportCardFile(sourcePath, { format: "png", loreMode: "embedded" }).body;
	const sourceRaw = JSON.parse(readFileSync(sourcePath, "utf8"));
	const charaCard = structuredClone(sourceRaw) as Record<string, any>;
	charaCard.spec = "chara_card_v2";
	charaCard.spec_version = "2.0";
	charaCard.fixtureChunkEnvelope = "chara-envelope-must-stay";
	charaCard.data.description = "chara 副本专属描述";
	charaCard.data.fixtureChunkCardField = "chara-card-only";
	charaCard.data.character_book.fixtureChunkBookField = "chara-book-only";
	charaCard.data.character_book.entries[1].extensions.fixtureChunkEntryField = "chara-entry-only";
	const withChara = writeCardJsonToPng(basePng, charaCard);

	const ccv3Card = structuredClone(sourceRaw) as Record<string, any>;
	ccv3Card.spec = "chara_card_v3";
	ccv3Card.spec_version = "3.0";
	ccv3Card.fixtureChunkEnvelope = "ccv3-envelope-must-stay";
	ccv3Card.data.description = "ccv3 副本专属描述";
	ccv3Card.data.fixtureChunkCardField = "ccv3-card-only";
	ccv3Card.data.character_book.fixtureChunkBookField = "ccv3-book-only";
	ccv3Card.data.character_book.entries[1].extensions.fixtureChunkEntryField = "ccv3-entry-only";
	const dualPng = appendPngChunkBeforeIend(withChara, makePngTextChunk("ccv3", ccv3Card));
	const cardPath = join(cwd, "dual-card.png");
	writeFileSync(cardPath, dualPng);
	rmSync(sourcePath, { force: true });
	assert.ok(pngTextChunk(dualPng, "chara").length > 0);
	assert.ok(pngTextChunk(dualPng, "ccv3").length > 0);
	assert.equal(pngTextKeywordCount(dualPng, "chara"), 1);
	assert.equal(pngTextKeywordCount(dualPng, "ccv3"), 1);
	setCurrentCard(cwd, "dual-card.png");
	const identity = (await cardDirectory(host)).cardIdentity;
	const targetFingerprint = loreFingerprint(seedEntries[1].content);

	const toggled = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint: targetFingerprint, enabled: true,
	});
	assert.equal(toggled.status, 200);
	const afterPng = readFileSync(cardPath);
	const afterChara = jsonFromPngText(afterPng, "chara");
	const afterCcv3 = jsonFromPngText(afterPng, "ccv3");
	assert.equal(pngTextKeywordCount(afterPng, "chara"), 1, "编辑不得新增 chara 副本");
	assert.equal(pngTextKeywordCount(afterPng, "ccv3"), 1, "编辑不得新增 ccv3 副本");
	for (const [label, copy, spec, version, description] of [
		["chara", afterChara, "chara_card_v2", "2.0", "chara 副本专属描述"],
		["ccv3", afterCcv3, "chara_card_v3", "3.0", "ccv3 副本专属描述"],
	] as const) {
		assert.equal(copy.spec, spec, `${label} 的 spec 不得被另一副本覆盖`);
		assert.equal(copy.spec_version, version, `${label} 的 spec_version 应保留`);
		assert.equal(copy.data.description, description, `${label} 的其它卡字段应保留自身原值`);
		assert.equal(copy.fixtureChunkEnvelope, `${label}-envelope-must-stay`);
		assert.equal(copy.data.fixtureChunkCardField, `${label}-card-only`);
		assert.equal(copy.data.character_book.fixtureChunkBookField, `${label}-book-only`);
		assert.equal(copy.data.character_book.entries[1].extensions.fixtureChunkEntryField, `${label}-entry-only`);
		assert.equal(copy.data.character_book.entries.find((entry: any) => entry.content === seedEntries[1].content)?.enabled, true,
			`${label} 的内嵌书应同步启用状态`);
	}
}));

test("REST card edit follows a JSON symlink and leaves no temporary file behind", () => fixture(async (cwd, host) => {
	const realPath = seedCard(cwd, "real-card.json", "symlink 合成卡", seedEntries);
	const linkPath = join(cwd, "linked-card.json");
	symlinkSync("real-card.json", linkPath);
	setCurrentCard(cwd, "linked-card.json");
	assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
	const modeBefore = statSync(realPath).mode & 0o777;
	const realBytesBefore = readFileSync(realPath);
	const identity = (await cardDirectory(host)).cardIdentity;
	const targetFingerprint = loreFingerprint(seedEntries[1].content);

	const toggled = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint: targetFingerprint, enabled: true,
	});
	assert.equal(toggled.status, 200);
	assert.equal(lstatSync(linkPath).isSymbolicLink(), true, "写入后用户软链接仍应存在");
	assert.equal(readlinkSync(linkPath), "real-card.json", "软链接目标不得改写");
	assert.notDeepEqual(readFileSync(realPath), realBytesBefore, "真实目标卡应被更新");
	assert.deepEqual(readFileSync(linkPath), readFileSync(realPath), "软链接仍指向已更新的真实卡");
	assert.equal(loadCardFile(realPath).book.find((entry) => entry.content === seedEntries[1].content)?.enabled, true);
	assert.equal(statSync(realPath).mode & 0o777, modeBefore, "原子替换需保留目标权限位");
	assert.deepEqual(readdirSync(cwd).filter((name) => name.startsWith(".liyuan-card-") && name.endsWith(".tmp")), [],
		"成功写入后不得残留原子写临时文件");
}));

test("REST rolls back card toggle when the config backup destination is unwritable", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "toggle 回滚合成卡", seedEntries);
	const fingerprint = loreFingerprint(seedEntries[1].content);
	setCurrentCard(cwd, "fixture-card.json", { disabledLore: [fingerprint] });
	const identity = (await cardDirectory(host)).cardIdentity;
	const cardBefore = readFileSync(cardPath);
	const configBefore = readFileSync(configPath(cwd));
	mkdirSync(`${configPath(cwd)}.bak`);

	const result = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint, enabled: true,
	});
	assert.ok(result.status < 200 || result.status >= 300, "配置备份路径不可写时启用请求必须失败");
	assert.deepEqual(readFileSync(cardPath), cardBefore, "配置备份失败后卡内原生状态必须回滚");
	assert.deepEqual(readFileSync(configPath(cwd)), configBefore, "配置写失败后配置原始字节必须不变");
}));

test("REST rolls back card deletion when override migration cannot back up config", () => fixture(async (cwd, host) => {
	const rows: FixtureEntry[] = [
		{ id: 101, comment: "删除失败时保留的前行", content: "删除回滚前行正文。", enabled: true },
		{ id: 102, comment: "需要移位的后行", content: "删除回滚后行覆盖迁移正文。", enabled: true },
	];
	const cardPath = seedCard(cwd, "fixture-card.json", "delete 回滚合成卡", rows);
	const fingerprints = rows.map((entry) => loreFingerprint(entry.content));
	setCurrentCard(cwd, "fixture-card.json", { disabledLore: fingerprints });
	let identity = (await cardDirectory(host)).cardIdentity;
	const establishOverride = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint: fingerprints[1], entryKey: "1", enabled: true,
	});
	assert.equal(establishOverride.status, 200);
	const backupPath = `${configPath(cwd)}.bak`;
	rmSync(backupPath, { force: true });
	const cardBeforeDelete = readFileSync(cardPath);
	const configBeforeDelete = readFileSync(configPath(cwd));
	identity = (await cardDirectory(host)).cardIdentity;
	mkdirSync(backupPath);

	const result = await request(host, "DELETE", entryUrl({
		source: "card", cardIdentity: identity, fingerprint: fingerprints[0], entryKey: "0",
	}));
	assert.ok(result.status < 200 || result.status >= 300, "来源覆盖行键迁移无法备份配置时删除必须失败");
	assert.deepEqual(readFileSync(cardPath), cardBeforeDelete, "配置备份失败后删除的卡条目必须原子恢复");
	assert.deepEqual(readFileSync(configPath(cwd)), configBeforeDelete, "配置字节不得因失败的覆盖迁移而改变");
	assert.equal(loadCardFile(cardPath).book.length, rows.length, "回滚后两条原始卡条目都须存在");
}));

test("REST batch toggle is atomic when any card fingerprint is unknown", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "批量原子合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const identity = (await cardDirectory(host)).cardIdentity;
	const cardBefore = readFileSync(cardPath);
	const configBefore = readFileSync(configPath(cwd));
	const result = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity,
		fingerprints: [loreFingerprint(seedEntries[0].content), "ffffffffffff"], enabled: false,
	});
	assert.ok(result.status < 200 || result.status >= 300, "含未知 fingerprint 的批量操作必须整批拒绝");
	assert.deepEqual(readFileSync(cardPath), cardBefore, "原生卡条目不能部分写入");
	assert.deepEqual(readFileSync(configPath(cwd)), configBefore, "配置不能留下部分来源覆盖");
	assert.equal(existsSync(`${cardPath}.bak`), false);
	assert.equal(existsSync(`${configPath(cwd)}.bak`), false);
}));

test("REST rejects a card request whose identity is stale after the card bytes are revised", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "修订令牌合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const oldIdentity = (await cardDirectory(host)).cardIdentity;
	const revised = JSON.parse(readFileSync(cardPath, "utf8"));
	revised.data.fixtureRevision = "external-card-revision";
	writeFileSync(cardPath, `${JSON.stringify(revised, null, 2)}\n`, "utf8");
	const bytesBeforeRequest = readFileSync(cardPath);
	const currentIdentity = (await cardDirectory(host)).cardIdentity;
	assert.notEqual(currentIdentity, oldIdentity, "原始卡字节修订必须产生新身份令牌");
	const result = await request(host, "PUT", "/api/lorebook/entry", {
		source: "card", cardIdentity: oldIdentity,
		fingerprint: loreFingerprint(seedEntries[0].content), content: "不得用旧身份覆盖的新正文。",
	});
	assert.ok(result.status < 200 || result.status >= 300, "修订后旧身份请求必须拒绝");
	assert.deepEqual(readFileSync(cardPath), bytesBeforeRequest, "拒绝旧身份时卡文件必须保持修订后的原始字节");
}));

test("REST rejects a card toggle when configuration switches while the request body is pending", () => fixture(async (cwd, host) => {
	const firstPath = seedCard(cwd, "first-card.json", "body await 第一合成卡", seedEntries);
	const secondPath = seedCard(cwd, "second-card.json", "body await 第二合成卡", [
		{ id: 20, comment: "第二卡独有", content: "body await 第二张卡内容。", enabled: true },
	]);
	setCurrentCard(cwd, "first-card.json");
	const oldIdentity = (await cardDirectory(host)).cardIdentity;
	const firstBefore = readFileSync(firstPath);
	const secondBefore = readFileSync(secondPath);
	const result = await requestWithBodyBarrier(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: oldIdentity,
		fingerprint: loreFingerprint(seedEntries[0].content), enabled: false,
	}, () => setCurrentCard(cwd, "second-card.json"));
	assert.ok(result.status < 200 || result.status >= 300, "body await 期间切卡后必须按新配置复核身份");
	assert.deepEqual(readFileSync(firstPath), firstBefore);
	assert.deepEqual(readFileSync(secondPath), secondBefore);
}));

test("REST exposes an empty embedded book as a visible empty card source", () => fixture(async (cwd, host) => {
	seedCard(cwd, "empty-card.json", "空书合成卡", []);
	setCurrentCard(cwd, "empty-card.json");
	const embedded = await cardDirectory(host);
	assert.equal(embedded.entryCount, 0);
	assert.equal(embedded.enabledCount, 0);
	const response = await request(host, "GET", cardViewUrl());
	assert.equal(response.status, 200);
	assert.equal(response.body.viewSource, "card");
	assert.equal(response.body.entries.length, 0);
}));

test("REST lorebook panel list keeps full text while default search uses merged enabled sources only", () => fixture(async (cwd, host) => {
	const afterPreview = `${"前段材料。".repeat(40)}全文尾部唯一命中 card-tail-9f21。`;
	const hidden = { id: 32, comment: "禁用搜索项", content: "hidden-disabled-marker-b031", enabled: false };
	const cardEntries = [
		{ id: 31, comment: "卡内全文项", content: afterPreview, enabled: true },
		hidden,
	];
	seedCard(cwd, "fixture-card.json", "全文搜索合成卡", cardEntries);
	const fileEntries = [{ id: 33, comment: "挂载书全文项", content: "file-merged-marker-c511", enabled: true }];
	seedLorebook(cwd, "assets/lorebooks/merged.json", "合成挂载书", fileEntries);
	const agentEntry = { id: 34, comment: "agent全文项", content: "agent-merged-marker-a927", enabled: true };
	seedLorebook(cwd, ".liyuan-lore/全文搜索合成卡.json", "合成 agent 补充设定", [agentEntry]);
	setCurrentCard(cwd, "fixture-card.json", { lorebooks: ["assets/lorebooks/merged.json"] });

	const view = await request(host, "GET", cardViewUrl());
	assert.equal(view.status, 200);
	const longEntry = view.body.entries.find((entry: { comment: string }) => entry.comment === "卡内全文项");
	assert.equal(longEntry.content, afterPreview, "列表应提供前 160 字符以外的完整正文供 UI 本地过滤");
	assert.ok(longEntry.preview.length <= 161, "预览字段仍可保持短摘要");

	const enabledHit = await request(host, "GET", `/api/lorebook/search?q=${encodeURIComponent("card-tail-9f21")}`);
	assert.ok(enabledHit.body.hits.some((hit: { comment: string }) => hit.comment === "卡内全文项"), "默认搜索应在卡内全文中命中尾部关键词");
	const fileHit = await request(host, "GET", `/api/lorebook/search?q=${encodeURIComponent("file-merged-marker-c511")}`);
	assert.ok(fileHit.body.hits.some((hit: { comment: string }) => hit.comment === "挂载书全文项"), "默认搜索应合并已挂载独立书");
	const agentHit = await request(host, "GET", `/api/lorebook/search?q=${encodeURIComponent("agent-merged-marker-a927")}`);
	assert.ok(agentHit.body.hits.some((hit: { comment: string }) => hit.comment === "agent全文项"), "默认搜索应合并本卡 agent 补充设定");
	const disabledHit = await request(host, "GET", `/api/lorebook/search?q=${encodeURIComponent("hidden-disabled-marker-b031")}`);
	assert.equal(disabledHit.body.hits.some((hit: { comment: string }) => hit.comment === hidden.comment), false,
		"默认搜索不得命中禁用卡内条目；其它有效合并来源可以命中各自内容");
}));

test("REST explicit card export preserves all enabled states and default merged export includes card entries", () => fixture(async (cwd, host) => {
	seedCard(cwd, "fixture-card.json", "卡内导出合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const identity = (await cardDirectory(host)).cardIdentity;
	const explicit = await request(host, "GET", exportUrl({ source: "card", cardIdentity: identity }));
	assert.equal(explicit.status, 200);
	assert.equal(exportedEntries(explicit).length, seedEntries.length, "显式卡内导出包含全部启用与禁用条目");
	for (const entry of seedEntries) {
		assert.equal(exportedEntry(explicit, entry.content)?.disable, !entry.enabled, `导出应保留 ${entry.comment} 的启用状态`);
	}

	const merged = await request(host, "GET", exportUrl());
	assert.equal(merged.status, 200);
	for (const entry of seedEntries) {
		assert.equal(exportedEntry(merged, entry.content)?.disable, !entry.enabled, `默认合并导出应包含卡内条目 ${entry.comment}`);
	}
}));

test("REST legacy disabledLore exemption is isolated to card source, not same-fingerprint mounted file", () => fixture(async (cwd, host) => {
	const same = { id: 41, comment: "相同正文", content: "卡和独立书共享同一内容指纹。", enabled: true };
	const cardPath = seedCard(cwd, "fixture-card.json", "来源隔离合成卡", [same]);
	const bookRel = "assets/lorebooks/same-content.json";
	const filePath = seedLorebook(cwd, bookRel, "同指纹独立书", [same]);
	const fp = loreFingerprint(same.content);
	setCurrentCard(cwd, "fixture-card.json", { lorebooks: [bookRel], disabledLore: [fp] });
	const identity = (await cardDirectory(host)).cardIdentity;
	const fileBefore = readFileSync(filePath);

	const enabled = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint: fp, enabled: true,
	});
	assert.equal(enabled.status, 200);
	const config = loadConfig(cwd);
	assert.equal(config.disabledLore?.includes(fp), true, "启用卡来源不得清除其他来源仍需的旧全局停用项");
	assert.equal(loadCardFile(cardPath).book[0].enabled, true);
	assert.deepEqual(readFileSync(filePath), fileBefore, "卡来源启停不能改写同指纹独立书");

	const cardView = await request(host, "GET", cardViewUrl());
	assert.equal(cardView.body.entries.find((entry: { fingerprint: string }) => entry.fingerprint === fp)?.enabled, true);
	const fileView = await request(host, "GET", `/api/lorebook?path=${encodeURIComponent(bookRel)}`);
	assert.equal(fileView.status, 200);
	assert.equal(fileView.body.viewSource, "file", "仅提供 path 时应推断 file 来源");
	assert.equal(fileView.body.entries.find((entry: { fingerprint: string }) => entry.fingerprint === fp)?.enabled, false,
		"相同指纹的独立书仍受旧 disabledLore 停用");
	assert.equal(loadStageMaterials(cwd).entries.find((entry) => entry.content === same.content)?.enabled, true,
		"素材合并应先按来源应用豁免，再按 card-first 去重");
}));

test("REST source override is row-scoped when same-card entries share a fingerprint", () => fixture(async (cwd, host) => {
	const same = "同一卡内兄弟行共享 legacy fingerprint。";
	const rows: FixtureEntry[] = [
		{ id: 45, comment: "legacy 兄弟行 A", content: same, enabled: true },
		{ id: 46, comment: "legacy 兄弟行 B", content: same, enabled: true },
	];
	const cardPath = seedCard(cwd, "fixture-card.json", "重复 legacy 来源覆盖卡", rows);
	setCurrentCard(cwd, "fixture-card.json", { disabledLore: [loreFingerprint(same)] });
	assert.deepEqual(loadCardFile(cardPath).book.map((entry) => entry.enabled), [true, true], "两行原生状态初始都启用");
	const identity = (await cardDirectory(host)).cardIdentity;
	const initiallyOff = await request(host, "GET", cardViewUrl());
	assert.deepEqual(initiallyOff.body.entries.map((entry: { enabled: boolean }) => entry.enabled), [false, false]);

	const enabled = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity,
		fingerprint: loreFingerprint(same), entryKey: "1", enabled: true,
	});
	assert.equal(enabled.status, 200);
	const after = await request(host, "GET", cardViewUrl());
	assert.deepEqual(after.body.entries.map((entry: { entryKey: string; enabled: boolean }) => [entry.entryKey, entry.enabled]), [
		["0", false], ["1", true],
	], "四参来源覆盖必须豁免选中的行键，不得因共享 fingerprint 误开兄弟行");
	assert.deepEqual(loadCardFile(cardPath).book.map((entry) => entry.enabled), [true, true], "显式开第二行不应改写首行原生 enabled");
}));

test("REST source override entryKey follows a later enabled row after deleting the preceding array row", () => fixture(async (cwd, host) => {
	const rows: FixtureEntry[] = [
		{ id: 47, comment: "删除前行", content: "先删除的前行独有正文。", enabled: true },
		{ id: 48, comment: "保留后行", content: "后行独有正文，删除前行后应继续生效。", enabled: true },
	];
	const cardPath = seedCard(cwd, "fixture-card.json", "删除迁移覆盖合成卡", rows);
	const fingerprints = rows.map((entry) => loreFingerprint(entry.content));
	setCurrentCard(cwd, "fixture-card.json", { disabledLore: fingerprints });
	let identity = (await cardDirectory(host)).cardIdentity;
	let view = await request(host, "GET", cardViewUrl());
	assert.deepEqual(view.body.entries.map((entry: { enabled: boolean }) => entry.enabled), [false, false]);

	const enabledLater = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint: fingerprints[1], entryKey: "1", enabled: true,
	});
	assert.equal(enabledLater.status, 200);
	identity = (await cardDirectory(host)).cardIdentity;
	view = await request(host, "GET", cardViewUrl());
	assert.deepEqual(view.body.entries.map((entry: { entryKey: string; enabled: boolean }) => [entry.entryKey, entry.enabled]), [
		["0", false], ["1", true],
	]);

	const deleteFirst = await request(host, "DELETE", entryUrl({
		source: "card", cardIdentity: identity, fingerprint: fingerprints[0], entryKey: "0",
	}));
	assert.equal(deleteFirst.status, 200);
	view = await request(host, "GET", cardViewUrl());
	assert.equal(view.body.entries.length, 1);
	assert.equal(view.body.entries[0].entryKey, "0", "保留行的原始数组索引已从 1 移为 0");
	assert.equal(view.body.entries[0].content, rows[1].content);
	assert.equal(view.body.entries[0].enabled, true, "删除前行后，覆盖行键迁移必须继续豁免后行");
	assert.equal(loadCardFile(cardPath).book[0].enabled, true);
}));

test("REST returns 409 when streaming starts while a mutation body is being read", () => fixture(async (cwd, host, setStreaming) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "body读期间开流合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const identity = (await cardDirectory(host)).cardIdentity;
	const cardBefore = readFileSync(cardPath);
	const configBefore = readFileSync(configPath(cwd));

	const result = await requestWithBodyBarrier(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity,
		fingerprint: loreFingerprint(seedEntries[0].content), enabled: false,
	}, () => setStreaming(true));
	assert.equal(result.status, 409, "readBody 等待期间开始流式生成后应拒绝写操作");
	assert.deepEqual(readFileSync(cardPath), cardBefore, "409 时不能写卡");
	assert.deepEqual(readFileSync(configPath(cwd)), configBefore, "409 时不能写配置或来源覆盖");
}));

test("REST file path can identify the source for full-entry reads and export", () => fixture(async (cwd, host) => {
	const rel = "assets/lorebooks/path-infers-file.json";
	const entry = { id: 51, comment: "路径来源条目", content: "路径可唯一识别独立世界书。", enabled: true };
	seedCard(cwd, "fixture-card.json", "文件路径合成卡", []);
	setCurrentCard(cwd, "fixture-card.json");
	const filePath = seedLorebook(cwd, rel, "路径来源书", [entry]);
	const fingerprint = loreFingerprint(entry.content);

	const view = await request(host, "GET", `/api/lorebook?path=${encodeURIComponent(rel)}`);
	assert.equal(view.status, 200);
	assert.equal(view.body.viewSource, "file");
	const single = await request(host, "GET", entryUrl({ source: "file", path: rel, fingerprint }));
	assert.equal(single.status, 200);
	assert.equal(single.body.content, entry.content);
	const inferredSingle = await request(host, "GET", entryUrl({ path: rel, fingerprint }));
	assert.equal(inferredSingle.status, 200, "只给 path 的单条 GET 应推断 file 来源");
	const exported = await request(host, "GET", exportUrl({ path: rel }));
	assert.equal(exported.status, 200);
	assert.equal(exportedEntry(exported, entry.content)?.disable, false);
	const changedContent = "路径来源书条目通过 path 完成编辑。";
	const edited = await request(host, "PUT", "/api/lorebook/entry", {
		path: rel, fingerprint, content: changedContent,
	});
	assert.equal(edited.status, 200, "只提供 path 的 PUT 应推断 file 来源");
	const deleted = await request(host, "DELETE", entryUrl({ path: rel, fingerprint: edited.body.fingerprint }));
	assert.equal(deleted.status, 200, "只提供 path 的 DELETE 应推断 file 来源");
	assert.equal(loadLorebookFile(filePath).length, 0);
	assert.ok(existsSync(filePath));
}));

test("REST card identity is mandatory for agent single reads, writes, toggles, deletes, and export", () => fixture(async (cwd, host) => {
	const agentEntry = { id: 61, comment: "agent身份条目", content: "仅用于合成 agent 来源身份校验。", enabled: true };
	seedCard(cwd, "fixture-card.json", "agent 来源合成卡", []);
	setCurrentCard(cwd, "fixture-card.json");
	const agentRel = ".liyuan-lore/agent 来源合成卡.json";
	const agentPath = seedLorebook(cwd, agentRel, "agent 合成补充设定", [agentEntry]);
	const originalBytes = readFileSync(agentPath);
	const fingerprint = loreFingerprint(agentEntry.content);
	const identity = (await cardDirectory(host)).cardIdentity;

	const listing = await request(host, "GET", "/api/lorebook?source=agent");
	assert.equal(listing.status, 200);
	assert.equal(listing.body.entries[0].content, agentEntry.content);
	assert.equal(listing.body.entries[0].entryKey, "0");
	assert.ok((await request(host, "GET", entryUrl({ source: "agent", fingerprint }))).status >= 400);
	assert.equal((await request(host, "GET", entryUrl({ source: "agent", cardIdentity: identity, fingerprint }))).status, 200);
	assert.ok((await request(host, "PUT", "/api/lorebook/entry", {
		source: "agent", fingerprint, comment: "不应写入",
	})).status >= 400);
	assert.ok((await request(host, "POST", "/api/lorebook/toggle", {
		source: "agent", fingerprint, enabled: false,
	})).status >= 400);
	assert.ok((await request(host, "DELETE", entryUrl({ source: "agent", fingerprint }))).status >= 400);
	assert.ok((await request(host, "GET", exportUrl({ source: "agent" }))).status >= 400);
	const exported = await request(host, "GET", exportUrl({ source: "agent", cardIdentity: identity }));
	assert.equal(exported.status, 200);
	assert.equal(exportedEntry(exported, agentEntry.content)?.disable, false);
	assert.deepEqual(readFileSync(agentPath), originalBytes, "所有缺少身份的写请求都不得修改 agent 文件");
}));

test("REST card identity is mandatory for card single reads, writes, deletes, and export", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "卡身份必需合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const fingerprint = loreFingerprint(seedEntries[0].content);
	const before = readFileSync(cardPath);
	const get = await request(host, "GET", entryUrl({ source: "card", fingerprint }));
	assert.ok(get.status >= 400, "卡内单条 GET 缺 cardIdentity 必须拒绝");
	const put = await request(host, "PUT", "/api/lorebook/entry", {
		source: "card", fingerprint, comment: "不应写入",
	});
	assert.ok(put.status >= 400, "卡内 PUT 缺 cardIdentity 必须拒绝");
	const toggle = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", fingerprint, enabled: false,
	});
	assert.ok(toggle.status >= 400, "卡内 toggle 缺 cardIdentity 必须拒绝");
	const del = await request(host, "DELETE", entryUrl({ source: "card", fingerprint }));
	assert.ok(del.status >= 400, "卡内 DELETE 缺 cardIdentity 必须拒绝");
	const exported = await request(host, "GET", exportUrl({ source: "card" }));
	assert.ok(exported.status >= 400, "卡内显式 export 缺 cardIdentity 必须拒绝");
	assert.deepEqual(readFileSync(cardPath), before, "缺身份请求不得修改卡内容");
}));

test("REST duplicate fingerprints require entryKey and target only the selected card entry", () => fixture(async (cwd, host) => {
	const duplicateContent = "同书内重复正文的合成指纹。";
	const duplicates: FixtureEntry[] = [
		{ id: 71, comment: "重复正文兄弟 A", content: duplicateContent, enabled: false },
		{ id: 72, comment: "重复正文兄弟 B", content: duplicateContent, enabled: false },
	];
	const cardPath = seedCard(cwd, "fixture-card.json", "重复指纹合成卡", duplicates);
	setCurrentCard(cwd, "fixture-card.json");
	let identity = (await cardDirectory(host)).cardIdentity;
	let view = await request(host, "GET", cardViewUrl());
	assert.equal(view.body.entries.length, 2);
	assert.equal(view.body.entries[0].fingerprint, view.body.entries[1].fingerprint);
	assert.deepEqual(view.body.entries.map((entry: { entryKey: string }) => entry.entryKey), ["0", "1"]);
	const fingerprint = view.body.entries[0].fingerprint;
	const beforeAmbiguous = readFileSync(cardPath);
	const ambiguousRead = await request(host, "GET", entryUrl({ source: "card", cardIdentity: identity, fingerprint }));
	assert.ok(ambiguousRead.status >= 400, "同书重复 fingerprint 的单条 GET 没有 entryKey 时必须拒绝歧义");
	const ambiguous = await request(host, "PUT", "/api/lorebook/entry", {
		source: "card", cardIdentity: identity, fingerprint, comment: "不明确目标",
	});
	assert.ok(ambiguous.status >= 400, "同一本书内部重复 fingerprint 在没有 entryKey 时必须拒绝");
	const ambiguousDelete = await request(host, "DELETE", entryUrl({ source: "card", cardIdentity: identity, fingerprint }));
	assert.ok(ambiguousDelete.status >= 400, "同书重复 fingerprint 的 DELETE 没有 entryKey 时必须拒绝歧义");
	const ambiguousToggle = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprint, enabled: true,
	});
	assert.ok(ambiguousToggle.status >= 400, "同书重复 fingerprint 的 toggle 没有 entryKey 时必须拒绝歧义");
	assert.deepEqual(readFileSync(cardPath), beforeAmbiguous);
	const preciseRead = await request(host, "GET", entryUrl({ source: "card", cardIdentity: identity, fingerprint, entryKey: "1" }));
	assert.equal(preciseRead.status, 200);
	assert.equal(preciseRead.body.comment, "重复正文兄弟 B");

	const precise = await request(host, "PUT", "/api/lorebook/entry", {
		source: "card", cardIdentity: identity, fingerprint, entryKey: "1", comment: "只编辑兄弟 B",
	});
	assert.equal(precise.status, 200);
	let raw = JSON.parse(readFileSync(cardPath, "utf8"));
	assert.equal(raw.data.character_book.entries[0].comment, "重复正文兄弟 A");
	assert.equal(raw.data.character_book.entries[1].comment, "只编辑兄弟 B");

	identity = (await cardDirectory(host)).cardIdentity;
	const batch = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, entries: [{ fingerprint, entryKey: "1" }], enabled: true,
	});
	assert.equal(batch.status, 200);
	raw = JSON.parse(readFileSync(cardPath, "utf8"));
	assert.equal(raw.data.character_book.entries[0].enabled, false, "批量精确目标不得误启同指纹兄弟");
	assert.equal(raw.data.character_book.entries[1].enabled, true);
	identity = (await cardDirectory(host)).cardIdentity;
	const preciseDelete = await request(host, "DELETE", entryUrl({ source: "card", cardIdentity: identity, fingerprint, entryKey: "1" }));
	assert.equal(preciseDelete.status, 200);
	raw = JSON.parse(readFileSync(cardPath, "utf8"));
	assert.equal(raw.data.character_book.entries.length, 1);
	assert.equal(raw.data.character_book.entries[0].comment, "重复正文兄弟 A", "精确删除只能移除选择的行键");
}));

test("REST batch toggle validates all entryKey targets before any write", () => fixture(async (cwd, host) => {
	const duplicateContent = "批量 entryKey 原子校验重复正文。";
	const cardPath = seedCard(cwd, "fixture-card.json", "重复批量原子卡", [
		{ id: 81, comment: "批量重复 A", content: duplicateContent, enabled: false },
		{ id: 82, comment: "批量重复 B", content: duplicateContent, enabled: false },
	]);
	setCurrentCard(cwd, "fixture-card.json");
	const identity = (await cardDirectory(host)).cardIdentity;
	const before = readFileSync(cardPath);
	const configBefore = readFileSync(configPath(cwd));
	const result = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity,
		entries: [
			{ fingerprint: loreFingerprint(duplicateContent), entryKey: "1" },
			{ fingerprint: "ffffffffffff", entryKey: "9" },
		],
		enabled: true,
	});
	assert.ok(result.status >= 400, "含未知 entryKey/fingerprint 的新格式批量请求必须拒绝");
	assert.deepEqual(readFileSync(cardPath), before);
	assert.deepEqual(readFileSync(configPath(cwd)), configBefore);
}));

test("REST legacy fingerprints batch remains compatible when every fingerprint is unique", () => fixture(async (cwd, host) => {
	const cardPath = seedCard(cwd, "fixture-card.json", "旧批量兼容合成卡", seedEntries);
	setCurrentCard(cwd, "fixture-card.json");
	const identity = (await cardDirectory(host)).cardIdentity;
	const fingerprints = seedEntries.slice(0, 2).map((entry) => loreFingerprint(entry.content));
	const result = await request(host, "POST", "/api/lorebook/toggle", {
		source: "card", cardIdentity: identity, fingerprints, enabled: false,
	});
	assert.equal(result.status, 200, "旧 fingerprints 批量格式在唯一匹配时继续可用");
	const current = loadCardFile(cardPath).book;
	assert.equal(current[0].enabled, false);
	assert.equal(current[1].enabled, false);
	assert.equal(current[2].enabled, false, "未选中的条目不变");
}));

test("REST file entryKey uses original object keys for duplicate-row edits and toggles", () => fixture(async (cwd, host) => {
	const rel = "assets/lorebooks/object-row-keys.json";
	const duplicate = "对象键重复正文的合成内容。";
	const filePath = seedLorebook(cwd, rel, "对象键重复书", [
		{ id: 91, comment: "对象键兄弟 alpha", content: duplicate, enabled: false },
		{ id: 92, comment: "对象键兄弟 omega", content: duplicate, enabled: false },
	]);
	seedCard(cwd, "fixture-card.json", "对象键合成卡", []);
	setCurrentCard(cwd, "fixture-card.json");
	const initial = JSON.parse(readFileSync(filePath, "utf8"));
	initial.entries = { "row-alpha": initial.entries["0"], "row-omega": initial.entries["1"] };
	writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
	const fingerprint = loreFingerprint(duplicate);
	const view = await request(host, "GET", `/api/lorebook?path=${encodeURIComponent(rel)}`);
	assert.deepEqual(view.body.entries.map((entry: { entryKey: string }) => entry.entryKey), ["row-alpha", "row-omega"]);
	const ambiguous = await request(host, "PUT", "/api/lorebook/entry", {
		path: rel, fingerprint, comment: "不应猜测对象行",
	});
	assert.ok(ambiguous.status >= 400, "重复指纹对象键未带 entryKey 时必须拒绝");

	const edited = await request(host, "PUT", "/api/lorebook/entry", {
		path: rel, fingerprint, entryKey: "row-omega", comment: "只编辑 omega 行",
	});
	assert.equal(edited.status, 200);
	const toggled = await request(host, "POST", "/api/lorebook/toggle", {
		path: rel, entries: [{ fingerprint, entryKey: "row-omega" }], enabled: true,
	});
	assert.equal(toggled.status, 200);
	const after = JSON.parse(readFileSync(filePath, "utf8"));
	assert.deepEqual(Object.keys(after.entries), ["row-alpha", "row-omega"], "写入必须保留原对象键，不得重排/重编号");
	assert.equal(after.entries["row-alpha"].comment, "对象键兄弟 alpha");
	assert.equal(after.entries["row-alpha"].disable, true, "同指纹兄弟保持原禁用状态");
	assert.equal(after.entries["row-omega"].comment, "只编辑 omega 行");
	assert.equal(after.entries["row-omega"].enabled, true);
}));
