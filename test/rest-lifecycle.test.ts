import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleApiRequest, type RestHost } from "../server/rest.ts";
import { memoryListChunks, persistChunks, updateMemoryConfig } from "../src/memory/index.ts";

// In-process requests only: no HTTP listener, providers, actual configs or user overrides.
const scope = { sessionId: "rest-fixture", card: "fixture-card.json" };
const siblingScope = { sessionId: "rest-sibling", card: "fixture-card.json" };
async function fixture(run: (cwd: string, host: RestHost, notices: string[]) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rest-lifecycle-"));
	const notices: string[] = [];
	const host = {
		cwd, isStreaming: () => false, memoryScope: () => scope,
		notify: (_level: string, text: string) => { notices.push(text); },
	} as unknown as RestHost;
	try { await run(cwd, host, notices); }
	finally { rmSync(cwd, { recursive: true, force: true }); }
}
async function request(host: RestHost, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
	const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as Readable & { method: string; url: string };
	req.method = method; req.url = url;
	let status = 0; let text = "";
	const res = { writeHead(code: number) { status = code; }, end(value = "") { text += value; } };
	assert.equal(await handleApiRequest(req as never, res as never, host), true);
	return { status, body: JSON.parse(text) };
}
function seed(cwd: string, storeId = "external", targetScope = scope): void {
	persistChunks(cwd, targetScope, storeId, [{
		id: "fixture-chunk", text: "离线 REST 生命周期测试内容", embedding: [1, 0],
		meta: { source: "manual" }, createdAt: "2026-01-01T00:00:00.000Z",
	}]);
}
function chunkCount(body: any, storeId: string): number {
	return body.stores.find((store: { id: string }) => store.id === storeId).chunkCount;
}
for (const method of ["DELETE", "POST"] as const) {
	test(`REST memory ${method} chunk delete: response reflects settled deletion, missing chunk is an error`, () => fixture(async (cwd, host, notices) => {
		updateMemoryConfig(cwd, { enabled: true, embedMode: "local" }); seed(cwd); seed(cwd, "external", siblingScope);
		const url = method === "DELETE" ? "/api/memory/chunk?storeId=external&id=fixture-chunk" : "/api/memory/chunk/delete";
		const payload = method === "POST" ? { storeId: "external", id: "fixture-chunk" } : undefined;
		const deleted = await request(host, method, url, payload);
		assert.equal(deleted.status, 200); assert.equal(deleted.body.ok, true);
		assert.equal(chunkCount(deleted.body, "external"), 0); // Without await, the response still counts the old chunk.
		assert.equal(memoryListChunks(cwd, siblingScope, "external").length, 1);
		assert.equal(notices.length, 1);
		const missing = await request(host, method, url, payload);
		assert.equal(missing.status, 400); assert.match(missing.body.error, /条目不存在|已删除/);
		assert.equal(notices.length, 1, "failed deletion must not notify success");
	}));
}
test("REST memory: async delete rejection returns the existing error envelope without a success notice", () => fixture(async (cwd, host, notices) => {
	updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
	const result = await request(host, "DELETE", "/api/memory/chunk?storeId=nonexistent&id=fixture-chunk");
	assert.equal(result.status, 400); assert.match(result.body.error, /库不存在/);
	assert.equal(result.body.ok, undefined); assert.deepEqual(notices, []);
}));
test("REST memory clear: status is sent after clearing only the selected scope", () => fixture(async (cwd, host) => {
	updateMemoryConfig(cwd, { enabled: true, embedMode: "local" }); seed(cwd); seed(cwd, "external", siblingScope);
	const result = await request(host, "POST", "/api/memory/clear", { storeId: "external" });
	assert.equal(result.status, 200); assert.equal(result.body.ok, true);
	assert.equal(chunkCount(result.body, "external"), 0);
	assert.equal(memoryListChunks(cwd, siblingScope, "external").length, 1);
}));
test("REST memory remove: response waits for custom-store config removal and keeps builtin stores", () => fixture(async (cwd, host) => {
	const initial = updateMemoryConfig(cwd, { enabled: true, embedMode: "local" });
	updateMemoryConfig(cwd, { stores: [...initial.stores, { id: "fixture-custom", name: "fixture", kind: "custom", enabled: true, everyNTurns: 0, maxChunks: 100 }] });
	seed(cwd, "fixture-custom");
	const result = await request(host, "DELETE", "/api/memory/store?id=fixture-custom");
	assert.equal(result.status, 200); assert.equal(result.body.ok, true);
	assert.equal(result.body.config.stores.some((store: { id: string }) => store.id === "fixture-custom"), false);
	assert.equal(result.body.stores.some((store: { id: string }) => store.id === "fixture-custom"), false);
	assert.ok(result.body.config.stores.some((store: { id: string }) => store.id === "external"));
}));

const dir = "交班fixture";
function builtin(cwd: string, version: string, body: string): void {
	const folder = join(cwd, "skills", dir); mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "SKILL.md"), `---\nname: ${dir}\ndescription: fixture builtin\nversion: ${version}\nworkflow: writer\nresident: true\nevery-beat: false\n---\n\n${body}\n`);
}
async function getSkill(host: RestHost, name = dir): Promise<any> {
	const result = await request(host, "GET", "/api/stage-skills");
	assert.equal(result.status, 200);
	const found = result.body.skills.find((skill: { dir: string }) => skill.dir === name);
	assert.ok(found, `missing fixture Skill ${name}`); return found;
}
const override = { dir, name: dir, description: "fixture override", workflow: "writer", resident: false, everyBeat: true, body: "用户覆写正文，不可自动替换" };

test("REST Skill GET/POST: public builtin metadata and explicit creation baseline round-trip; ordinary saves do not rebase", () => fixture(async (cwd, host) => {
	builtin(cwd, "1.0", "旧内置正文");
	const original = await getSkill(host);
	assert.equal(original.updateStatus, "current"); assert.equal(original.source, "builtin");
	assert.equal(original.builtin.version, "1.0"); assert.equal(original.builtin.body, "旧内置正文\n");
	assert.match(original.builtin.fingerprint, /^[a-f0-9]{64}$/);
	builtin(cwd, "2.0", "新内置正文");
	const saved = await request(host, "POST", "/api/stage-skills", { ...override, baseBuiltinFingerprint: original.builtin.fingerprint, baseBuiltinVersion: original.builtin.version });
	assert.equal(saved.status, 200);
	const outdated = await getSkill(host);
	assert.equal(outdated.updateStatus, "outdated"); assert.equal(outdated.baseBuiltinFingerprint, original.builtin.fingerprint);
	assert.equal(outdated.baseBuiltinVersion, "1.0"); assert.equal(outdated.builtin.version, "2.0");
	assert.equal(outdated.body, override.body); assert.equal(outdated.chars, override.body.length);
	assert.equal((await request(host, "POST", "/api/stage-skills", { ...override, baseBuiltinFingerprint: outdated.builtin.fingerprint, baseBuiltinVersion: "2.0" })).status, 200);
	assert.equal((await getSkill(host)).updateStatus, "outdated", "ordinary saves must preserve the prior review baseline");
}));
test("REST Skill acknowledge: stale fingerprint is rejected; current acknowledgement preserves body; deleting override reveals builtin", () => fixture(async (cwd, host) => {
	builtin(cwd, "1.0", "旧内置正文"); await request(host, "POST", "/api/stage-skills", override);
	const before = await getSkill(host); builtin(cwd, "2.0", "新内置正文");
	const file = join(cwd, ".liyuan-stage-skills", dir, "SKILL.md"); const raw = readFileSync(file, "utf8");
	const stale = await request(host, "POST", "/api/stage-skills/acknowledge", { dir, builtinFingerprint: before.builtin.fingerprint });
	assert.equal(stale.status, 400); assert.match(stale.body.error, /变化|刷新/); assert.equal(readFileSync(file, "utf8"), raw);
	const current = await getSkill(host);
	const ack = await request(host, "POST", "/api/stage-skills/acknowledge", { dir, builtinFingerprint: current.builtin.fingerprint });
	assert.deepEqual(ack, { status: 200, body: { ok: true, dir } });
	const after = await getSkill(host); assert.equal(after.updateStatus, "current"); assert.equal(after.baseBuiltinVersion, "2.0");
	assert.equal(after.body, before.body); assert.equal(after.resident, before.resident); assert.equal(after.everyBeat, before.everyBeat);
	const bodyBytes = (value: string) => value.slice(value.indexOf("\n---\n") + 5);
	assert.equal(bodyBytes(readFileSync(file, "utf8")), bodyBytes(raw));
	assert.equal((await request(host, "DELETE", `/api/stage-skills?dir=${encodeURIComponent(dir)}`)).status, 200);
	const restored = await getSkill(host); assert.equal(restored.source, "builtin"); assert.equal(restored.body, "新内置正文\n");
}));
test("REST Skill: invalid acknowledgement uses the existing error response and cannot create a user override", () => fixture(async (cwd, host) => {
	builtin(cwd, "1.0", "内置正文"); const original = await getSkill(host);
	for (const payload of [{ dir: "../escape", builtinFingerprint: original.builtin.fingerprint }, { dir }, { dir, builtinFingerprint: original.builtin.fingerprint }]) {
		const result = await request(host, "POST", "/api/stage-skills/acknowledge", payload);
		assert.equal(result.status, 400); assert.equal(typeof result.body.error, "string"); assert.equal(result.body.ok, undefined);
	}
	assert.equal((await getSkill(host)).source, "builtin");
}));
