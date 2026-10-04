import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { novelNodeId, prepareNovelSource } from "../src/novel-play/source.ts";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { saveNovelPackage } from "../src/novel-play/store.ts";
import { saveStageSkill } from "../src/stage/skill-store.ts";
import { createOpeningProposal, startFromConfirmedProposal } from "../src/novel-play/application.ts";
import { handleNovelPlayApiRequest } from "../server/novel-play-api.ts";
import type { RestHost } from "../server/rest.ts";

const cwd = () => join(tmpdir(), `liyuan-novel-api-${Date.now()}-${Math.random().toString(16).slice(2)}`);

function skill(root: string, dir: string, body: string): void {
	saveStageSkill(root, { dir, name: dir, description: "test", resident: false, everyBeat: false, body });
}

function corpus(root: string): { docId: string; text: string } {
	const docId = "doc-safe-id";
	const text = "第一章\n晨钟响起。旅人推开城门。";
	const dir = join(root, ".liyuan", "outline", "research", "corpus");
	mkdirSync(join(dir, "texts"), { recursive: true });
	writeFileSync(join(dir, "documents.json"), JSON.stringify([{ id: docId, title: "测试小说", sourceKind: "upload", originalName: "x.txt", chars: text.length, encoding: "utf-8", chapterCount: 1, chunkCount: 1, status: "ready", cardKey: "card", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]));
	writeFileSync(join(dir, "texts", `${docId}.txt`), text);
	return { docId, text };
}

function stored(root: string, docId: string, text: string): string {
	const source = prepareNovelSource({ id: docId, title: "测试小说", status: "ready", chars: text.length, chunkCount: 1 }, text);
	const quote = "。";
	const start = text.lastIndexOf(quote);
	const ref = { chunkIndex: 0, start, end: start + quote.length, quote };
	const pkg = buildNovelPackage(source, [{ id: "chunk-0", order: 0, title: "第一章" }], [{ id: novelNodeId(source, ref, "bell"), key: "bell", stageId: "chunk-0", order: 0, title: "晨钟", summary: "晨钟响起", visibility: "public", dependsOn: [], sourceRefs: [ref] }]);
	saveNovelPackage(root, source, pkg);
	return pkg.revision;
}

class Response {
	statusCode = 0; headers: Record<string, string> = {}; text = "";
	writeHead(code: number, headers: Record<string, string>): void { this.statusCode = code; this.headers = headers; }
	end(value = ""): void { this.text += value; }
}

async function request(host: RestHost, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
	const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]) as Readable & { method: string; url: string };
	req.method = method; req.url = url;
	const res = new Response();
	assert.equal(await handleNovelPlayApiRequest(req as never, res as never, host), true);
	return { status: res.statusCode, body: JSON.parse(res.text) };
}

function host(root: string, model: (system: string, user: string) => string): RestHost {
	let runtimeCard = "assets/cards/default_Qingwu.json";
	let runtimeSession = "test";
	return { cwd: root, isStreaming: () => false, runSideText: async (_step, system, user) => model(system, user), memoryScope: () => ({ sessionId: runtimeSession, card: runtimeCard }), switchToCard: async () => { runtimeCard = JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8")).card; runtimeSession = "created-session"; return "created"; } } as unknown as RestHost;
}

test("build is an in-process bounded job and status never exposes source text", async () => {
	const root = cwd(); const input = corpus(root); skill(root, "小说作品构建", "extract exact events");
	const h = host(root, (_system, user) => { const parsed = JSON.parse(user); const quote = "晨钟响起"; assert.ok(parsed.chunk.text.includes(quote)); return JSON.stringify({ nodes: [{ key: "bell", title: "晨钟", summary: "晨钟响起", visibility: "public", dependsOn: [], quote }] }); });
	const created = await request(h, "POST", "/api/novel-play/build", { docId: input.docId });
	assert.equal(created.status, 202);
	await new Promise((resolve) => setTimeout(resolve, 30));
	const status = await request(h, "GET", `/api/novel-play/status/${created.body.job.id}`);
	assert.equal(status.body.job.status, "succeeded");
	assert.equal(JSON.stringify(status.body).includes(input.text), false);
	assert.equal(status.body.job.result.docId, input.docId);
});

test("GET start returns public node titles and preview token is immutable and single-use", async () => {
	const root = cwd(); const input = corpus(root); const revision = stored(root, input.docId, input.text);
	skill(root, "小说开场提取", "opening extraction"); skill(root, "小说开演边界", "never reveal future canon");
	mkdirSync(join(root, "assets", "cards"), { recursive: true });
	writeFileSync(join(root, "assets", "cards", "default_Qingwu.json"), JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "normal", description: "", personality: "", scenario: "", first_mes: "", mes_example: "", system_prompt: "", post_history_instructions: "", creator_notes: "", alternate_greetings: [], tags: [] } }));
	writeFileSync(join(root, "liyuan.config.json"), JSON.stringify({ card: "assets/cards/default_Qingwu.json", userName: "old", userPersona: "", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 }));
	const h = host(root, () => JSON.stringify({ time: { text: "晨钟响起", quote: "晨钟响起" }, place: { text: "城门", quote: "城门" }, sceneText: { text: "晨钟响起", quote: "晨钟响起" }, openingNarration: { text: "旅人推开城门", quote: "旅人推开城门" }, publicCharacterProfiles: [], publicWorldFacts: [] }));
	const options = await request(h, "GET", `/api/novel-play/start?docId=${input.docId}&revision=${revision}`);
	assert.equal(options.body.package.nodes[0].title, "晨钟");
	assert.equal(options.body.package.nodes[0].summary, "晨钟响起");
	assert.equal(options.body.package.nodes[0].stageTitle, "第一章");
	assert.equal(options.body.package.nodes[0].source.chunkIndex, 0);
	const preview = await request(h, "POST", "/api/novel-play/preview", { docId: input.docId, revision, nodeId: options.body.package.nodes[0].nodeId, position: "before", player: { name: "阿岚", identity: "异乡旅人" } });
	assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(JSON.stringify(preview.body).includes("quote"), false);
	const started = await request(h, "POST", "/api/novel-play/start", { previewToken: preview.body.preview.token, draft: { user: { name: "篡改" } } });
	assert.equal(started.status, 201);
	const card = JSON.parse(readFileSync(join(root, started.body.started.card), "utf8"));
	assert.ok(card.data.description.includes("阿岚"));
	const updatedConfig = JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8"));
	assert.equal(updatedConfig.userName, "阿岚");
	assert.equal(updatedConfig.userPersona, "异乡旅人");
	const replay = await request(h, "POST", "/api/novel-play/start", { previewToken: preview.body.preview.token });
	assert.equal(replay.status, 409);
});

test("uncertain card switch preserves generated recovery state", async () => {
	const root = cwd(); const input = corpus(root); const revision = stored(root, input.docId, input.text);
	skill(root, "小说开场提取", "opening extraction"); skill(root, "小说开演边界", "boundary");
	mkdirSync(join(root, "assets", "cards"), { recursive: true });
	writeFileSync(join(root, "assets", "cards", "default_Qingwu.json"), "{}");
	const original = JSON.stringify({ card: "assets/cards/default_Qingwu.json", userName: "old", userPersona: "", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 });
	writeFileSync(join(root, "liyuan.config.json"), original);
	const h = host(root, () => JSON.stringify({ time: { text: "晨钟响起", quote: "晨钟响起" }, place: { text: "城门", quote: "城门" }, sceneText: { text: "晨钟响起", quote: "晨钟响起" }, openingNarration: { text: "旅人推开城门", quote: "旅人推开城门" }, publicCharacterProfiles: [], publicWorldFacts: [] }));
	(h as unknown as { switchToCard(): Promise<string> }).switchToCard = async () => { throw new Error("switch failed"); };
	const preview = await request(h, "POST", "/api/novel-play/preview", { docId: input.docId, revision, nodeId: (await request(h, "GET", `/api/novel-play/start?docId=${input.docId}&revision=${revision}`)).body.package.nodes[0].nodeId, position: "before", player: { name: "阿岚", identity: "异乡旅人" } });
	const failed = await request(h, "POST", "/api/novel-play/start", { previewToken: preview.body.preview.token });
	assert.equal(failed.status, 202, JSON.stringify(failed.body));
	assert.equal(failed.body.started.session, "recovery-required");
	assert.notEqual(readFileSync(join(root, "liyuan.config.json"), "utf8"), original);
	assert.ok(readFileSync(join(root, failed.body.started.card), "utf8").includes("liyuanNovelPlay"));
});


async function directStartFixture() {
	const root = cwd(); const input = corpus(root); const revision = stored(root, input.docId, input.text);
	skill(root, "小说开场提取", "opening extraction"); skill(root, "小说开演边界", "boundary");
	mkdirSync(join(root, "assets", "cards"), { recursive: true });
	writeFileSync(join(root, "assets", "cards", "default_Qingwu.json"), "{}");
	const original = JSON.stringify({ card: "assets/cards/default_Qingwu.json", userName: "old", userPersona: "old persona", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 });
	writeFileSync(join(root, "liyuan.config.json"), original);
	const h = host(root, () => JSON.stringify({ time: { text: "晨钟响起", quote: "晨钟响起" }, place: { text: "城门", quote: "城门" }, sceneText: { text: "晨钟响起", quote: "晨钟响起" }, openingNarration: { text: "旅人推开城门", quote: "旅人推开城门" }, publicCharacterProfiles: [], publicWorldFacts: [] }));
	const options = await request(h, "GET", `/api/novel-play/start?docId=${input.docId}&revision=${revision}`);
	const generated = await createOpeningProposal(h as never, { docId: input.docId, revision, nodeId: options.body.package.nodes[0].nodeId, position: "before", player: { name: "阿岚", identity: "异乡旅人" } });
	return { root, h, generated, original, expected: { sessionId: "test", card: "assets/cards/default_Qingwu.json" } };
}

test("pre-switch callback failure restores owned config and removes generated card without masking the error", async () => {
	const fixture = await directStartFixture(); let generatedCard = "";
	await assert.rejects(startFromConfirmedProposal(fixture.h as never, fixture.generated, fixture.expected, card => { generatedCard = card; throw new Error("prepared callback failed"); }), /prepared callback failed/);
	assert.equal(readFileSync(join(fixture.root, "liyuan.config.json"), "utf8"), fixture.original);
	assert.equal(existsSync(join(fixture.root, generatedCard)), false);
});

test("pre-switch callback failure preserves external config edits and safely removes an unreferenced generated card", async () => {
	const fixture = await directStartFixture(); let generatedCard = "";
	const external = JSON.stringify({ card: "assets/cards/external.json", userName: "external", userPersona: "external persona" });
	await assert.rejects(startFromConfirmedProposal(fixture.h as never, fixture.generated, fixture.expected, card => { generatedCard = card; writeFileSync(join(fixture.root, "liyuan.config.json"), external); throw new Error("external edit"); }), /external edit/);
	assert.equal(readFileSync(join(fixture.root, "liyuan.config.json"), "utf8"), external);
	assert.equal(existsSync(join(fixture.root, generatedCard)), false);
});

test("created switch with stale runtime binding requires recovery", async () => {
	const fixture = await directStartFixture();
	(fixture.h as unknown as { switchToCard(): Promise<string> }).switchToCard = async () => "created";
	const result = await startFromConfirmedProposal(fixture.h as never, fixture.generated, fixture.expected);
	assert.equal(result.session, "recovery-required");
});

test("upgrade preview token is single-use and cannot be replayed", async () => {
	const fixture = await directStartFixture();
	let commits = 0;
	const upgradeHost = fixture.h as unknown as RestHost & { novelPlayUpgradePreview: RestHost["novelPlayUpgradePreview"]; novelPlayUpgradeCommit: RestHost["novelPlayUpgradeCommit"] };
	upgradeHost.novelPlayUpgradePreview = () => ({ from: { revision: "old" }, to: { revision: "new" }, leafId: "leaf-1", newNodes: 2 });
	upgradeHost.novelPlayUpgradeCommit = (_doc, _revision, leaf) => { commits++; assert.equal(leaf, "leaf-1"); return { ok: true }; };
	const preview = await request(upgradeHost, "POST", "/api/novel-play/upgrade/preview", { targetDocId: "new-doc", targetRevision: "new-revision" });
	assert.equal(preview.status, 200, JSON.stringify(preview.body));
	const token = preview.body.preview.token;
	const committed = await request(upgradeHost, "POST", "/api/novel-play/upgrade/commit", { previewToken: token });
	assert.equal(committed.status, 200, JSON.stringify(committed.body));
	assert.equal(commits, 1);
	const replay = await request(upgradeHost, "POST", "/api/novel-play/upgrade/commit", { previewToken: token });
	assert.equal(replay.status, 409);
});
