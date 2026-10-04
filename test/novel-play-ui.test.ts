import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	buildNovelPlay, cancelNovelPlayJob, getNovelPlayJob, getNovelPlayStartOptions,
	listNovelPlayJobs, previewNovelPlay, startNovelPlay,
} from "../web/src/planning/novel-play-client.ts";

const client = readFileSync(new URL("../web/src/planning/novel-play-client.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../web/src/planning/novel-play.tsx", import.meta.url), "utf8");
const corpus = readFileSync(new URL("../web/src/planning/modules/CorpusModule.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/novel-play-api.ts", import.meta.url), "utf8");
const application = readFileSync(new URL("../src/novel-play/application.ts", import.meta.url), "utf8");

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("novel play client sends the exact route methods and DTO bodies", async () => {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input); const method = init?.method ?? "GET"; const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ url, method, body });
		if (url === "/api/novel-play/status") return jsonResponse({ jobs: [] });
		if (method === "DELETE") return jsonResponse({ job: { id: "a".repeat(32), docId: "doc id", status: "cancelled", createdAt: "c", updatedAt: "u" } });
		if (url.startsWith("/api/novel-play/status/")) return jsonResponse({ job: { id: "a".repeat(32), docId: "doc id", status: "running", createdAt: "c", updatedAt: "u" } });
		if (method === "GET") return jsonResponse({ package: { docId: "doc id", revision: "rev/value", title: "Book", nodes: [{ nodeId: "public-1", title: "阶段 1 · 节点 1" }] } });
		if (url.endsWith("/build")) return jsonResponse({ job: { id: "a".repeat(32), docId: "doc id", status: "queued", createdAt: "c", updatedAt: "u" } }, 202);
		if (url.endsWith("/preview")) return jsonResponse({ preview: { token: "one-time", expiresAt: "x", package: { docId: "doc id", revision: "rev/value" }, anchor: { packageRevision: "rev/value", nodeId: "public-1", position: "before" }, draft: { user: { name: "N", identity: "I" }, time: "T", place: "P", sceneText: "S", openingNarration: "O", publicCharacterProfiles: [], publicWorldFacts: [] } } });
		return jsonResponse({ started: { card: "card.json", session: "created" } }, 201);
	};
	try {
		assert.equal((await buildNovelPlay("doc id")).job.status, "queued"); await listNovelPlayJobs(); await getNovelPlayJob("a".repeat(32)); await cancelNovelPlayJob("a".repeat(32));
		assert.deepEqual((await getNovelPlayStartOptions("doc id", "rev/value")).package.nodes, [{ nodeId: "public-1", title: "阶段 1 · 节点 1" }]);
		assert.equal((await previewNovelPlay({ docId: "doc id", revision: "rev/value", nodeId: "public-1", position: "before", player: { name: "N", identity: "I" } })).preview.draft.openingNarration, "O");
		assert.equal((await startNovelPlay("one-time")).started.session, "created");
	} finally { globalThis.fetch = originalFetch; }
	assert.deepEqual(calls, [
		{ url: "/api/novel-play/build", method: "POST", body: { docId: "doc id" } }, { url: "/api/novel-play/status", method: "GET", body: undefined },
		{ url: `/api/novel-play/status/${"a".repeat(32)}`, method: "GET", body: undefined }, { url: `/api/novel-play/status/${"a".repeat(32)}`, method: "DELETE", body: undefined },
		{ url: "/api/novel-play/start?docId=doc%20id&revision=rev%2Fvalue", method: "GET", body: undefined },
		{ url: "/api/novel-play/preview", method: "POST", body: { docId: "doc id", revision: "rev/value", nodeId: "public-1", position: "before", player: { name: "N", identity: "I" } } },
		{ url: "/api/novel-play/start", method: "POST", body: { previewToken: "one-time" } },
	]);
});

test("novel play client maps the recovery-required 202 response", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ started: { card: "assets/cards/novel-play-saved.json", session: "recovery-required", recovery: "角色切换未在期限内完成，结果仍不确定。" } }, 202);
	try {
		const response = await startNovelPlay("consumed-token");
		assert.deepEqual(response.started, { card: "assets/cards/novel-play-saved.json", session: "recovery-required", recovery: "角色切换未在期限内完成，结果仍不确定。" });
	} finally { globalThis.fetch = originalFetch; }
});

test("server contract and UI preserve recovery and public-data boundaries", () => {
	assert.match(application, /session: "recovery-required"; recovery: string/);
	assert.match(server, /send\(res, 202, \{ started: instance\.recovery \}\)/);
	assert.match(server, /outcome\.result\.session === "created" \? 201 : 202/);
	assert.match(application, /filter\(node => node\.visibility === "public"\)\.map\(node => \(\{/);
	assert.match(client.match(/interface NovelPlayStartOptions[^\n]+/)?.[0] ?? "", /summary|stageTitle|source/);
	assert.doesNotMatch(client.match(/interface NovelPlayStartOptions[^\n]+/)?.[0] ?? "", /visibility|sourceRefs|dependsOn/);
	assert.match(ui, /response\.started\.session === "created"\) onClose\(\)/);
	assert.match(ui, /setPreview\(null\)/);
	assert.match(ui, /开演令牌已经消耗，请勿重复提交/);
	assert.match(ui, /recovery\.card/);
	assert.match(ui, /recovery\.recovery/);
});

test("novel play UI cleans polls and explains deadlines and session-scoped jobs", () => {
	assert.match(ui, /window\.clearTimeout\(timer\); abort\.abort\(\)/);
	assert.match(ui, /const close = \(\) => \{ invalidate\(\); onClose\(\); \}/);
	assert.match(ui, /模型预览最长约 5 分钟/);
	assert.match(ui, /角色切换最长约 30 秒/);
	assert.match(ui, /构建记录只属于当前会话/);
	assert.match(ui, /selectedNodeIndex === 0 && position === "before"/);
	assert.match(corpus, /<NovelPlayDialog docId=\{playing\.id\}/);
});
