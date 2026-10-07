import assert from "node:assert/strict";
import test from "node:test";
import { apiGet, apiGetCacheClear, apiGetPeek, apiPost } from "../web/src/api.ts";

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function mockFetch(run: (set: (handler: typeof fetch) => void) => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	apiGetCacheClear();
	try { await run((handler) => { globalThis.fetch = handler; }); }
	finally { globalThis.fetch = original; apiGetCacheClear(); }
}

test("card switch invalidates embedded lore directory/list cache and card lore edits invalidate cardfront", () => mockFetch(async (set) => {
	let revision = "A";
	set(async () => response({ revision }));
	await apiGet("/api/lorebooks"); await apiGet("/api/lorebook?source=card"); await apiGet("/api/cardfront");
	revision = "B";
	await apiPost("/api/card/switch", { card: "synthetic-B.json" });
	assert.equal(apiGetPeek("/api/lorebooks"), null);
	assert.equal(apiGetPeek("/api/lorebook?source=card"), null);
	assert.deepEqual(await apiGet("/api/lorebooks"), { revision: "B" });
	await apiGet("/api/cardfront");
	await apiPost("/api/lorebook/toggle", { source: "card", cardIdentity: "fixture", enabled: true });
	assert.equal(apiGetPeek("/api/cardfront"), null);
}));

test("a pre-switch slow GET cannot rehydrate the embedded lore directory with the old card", () => mockFetch(async (set) => {
	let release!: (value: Response) => void;
	set(() => new Promise<Response>((resolve) => { release = resolve; }));
	const old = apiGet("/api/lorebooks");
	apiGetCacheClear("/api/lorebook");
	set(async () => response({ card: "B" }));
	assert.deepEqual(await apiGet("/api/lorebooks"), { card: "B" });
	release(response({ card: "A" }));
	assert.deepEqual(await old, { card: "A" });
	assert.deepEqual(apiGetPeek("/api/lorebooks"), { card: "B" });
}));

test("settling an invalidated GET cannot erase the newer in-flight request used for deduplication", () => mockFetch(async (set) => {
	let releaseOld!: (value: Response) => void, releaseNew!: (value: Response) => void;
	let calls = 0;
	set(() => { calls++; return new Promise<Response>((resolve) => { if (calls === 1) releaseOld = resolve; else releaseNew = resolve; }); });
	const old = apiGet("/api/lorebooks");
	apiGetCacheClear("/api/lorebooks");
	const current = apiGet("/api/lorebooks");
	releaseOld(response({ card: "A" })); await old;
	const joined = apiGet("/api/lorebooks");
	assert.equal(calls, 2);
	releaseNew(response({ card: "B" }));
	assert.deepEqual(await current, { card: "B" }); assert.deepEqual(await joined, { card: "B" });
}));
