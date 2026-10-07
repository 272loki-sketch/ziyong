import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DATABASE_PLUGIN_MAX_BYTES, DATABASE_PLUGIN_MAX_CACHED_SOURCES,
	DEFAULT_DATABASE_PLUGIN_REF, DEFAULT_DATABASE_PLUGIN_SHA256,
	DatabasePluginSourceStore, readDatabasePluginSourceConfig,
} from "../server/database-plugin-source.ts";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const ref = (tag: string) => `https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@${tag}/index.js`;

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function fixture(run: (cwd: string, cleanup: () => void) => Promise<void> | void): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-database-plugin-"));
	const cleanup = () => rmSync(cwd, { recursive: true, force: true });
	return Promise.resolve().then(() => run(cwd, cleanup)).finally(cleanup);
}
function responseFor(bytes: Uint8Array, headers?: HeadersInit): Response {
	return new Response(bytes, { status: 200, headers });
}
function store(cwd: string, fetch: FetchMock, options: { ref?: string; expectedSha256?: string; downloadTimeoutMs?: number } = {}) {
	return new DatabasePluginSourceStore({ cwd, fetch, ...options });
}

const defaultFixture = new TextEncoder().encode("synthetic upstream plugin fixture; not vendor source\n");

test("source defaults and config remain pinned to the requested upstream ref and digest", () => {
	assert.equal(DEFAULT_DATABASE_PLUGIN_REF, "https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/index.js");
	assert.equal(DEFAULT_DATABASE_PLUGIN_SHA256, "ff8981ea9f60bbada765ce79d576bf84963e842c12b683feb6e8fe22b74b8bac");
	assert.deepEqual(readDatabasePluginSourceConfig(), { ref: DEFAULT_DATABASE_PLUGIN_REF, expectedSha256: DEFAULT_DATABASE_PLUGIN_SHA256 });
	assert.deepEqual(readDatabasePluginSourceConfig({ ref: ref("naiv1.2.5"), expectedSha256: "A".repeat(64) }), {
		ref: ref("naiv1.2.5"), expectedSha256: "a".repeat(64),
	});
	assert.throws(() => readDatabasePluginSourceConfig({ ref: "https://evil.example/index.js", expectedSha256: "a".repeat(64) }), /pinned jsDelivr/);
	assert.throws(() => readDatabasePluginSourceConfig({ expectedSha256: "not-a-hash" }), /64-character/);
});

test("rejects cross-host, path variants, credentials, query, fragment and redirects before accepting bytes", async () => fixture(async (cwd) => {
	let fetchCalls = 0;
	const fetch: FetchMock = async () => { fetchCalls++; return responseFor(defaultFixture); };
	const sourceStore = store(cwd, fetch);
	const invalidRefs = [
		"https://evil.example/gh/AlbusKen/shujuku@naiv1.2.4/index.js",
		"https://gcore.jsdelivr.net.evil.example/gh/AlbusKen/shujuku@naiv1.2.4/index.js",
		"http://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/index.js",
		"https://user:pass@gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/index.js",
		"https://gcore.jsdelivr.net:443/gh/AlbusKen/shujuku@naiv1.2.4/index.js",
		"https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/index.js?download=1",
		"https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/index.js#fragment",
		"https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/other.js",
		"https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4/../index.js",
		"https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@naiv1.2.4%2f..%2findex.js/index.js",
		"https://gcore.jsdelivr.net/gh/other/shujuku@naiv1.2.4/index.js",
	];
	for (const candidate of invalidRefs) {
		await assert.rejects(sourceStore.downloadSource({ ref: candidate, expectedSha256: sha(defaultFixture) }));
	}
	assert.equal(fetchCalls, 0, "invalid URL input must be rejected before invoking fetch");

	const redirectStore = store(cwd, async (_input, init) => {
		assert.equal(init?.redirect, "manual", "fetch must not follow redirects");
		return Response.redirect("https://evil.example/payload.js", 302);
	}, { ref: ref("redirect-test"), expectedSha256: sha(defaultFixture) });
	await assert.rejects(redirectStore.downloadSource(), /redirects are forbidden/);
	assert.equal(redirectStore.resolveSource(), null);
}));

test("verified source is cached privately, resolved locally, read-only and activated only explicitly", async () => fixture(async (cwd) => {
	const bytes = new TextEncoder().encode("synthetic plugin source\nwith stable bytes\n");
	const digest = sha(bytes);
	let fetchCalls = 0;
	const sourceStore = store(cwd, async (_input, init) => {
		fetchCalls++;
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "manual");
		return responseFor(bytes);
	}, { ref: ref("candidate-one"), expectedSha256: digest });

	assert.throws(() => sourceStore.readCurrentPinnedJS(), /not ready/);
	const candidate = await sourceStore.downloadSource();
	assert.deepEqual(candidate, {
		ref: ref("candidate-one"), url: ref("candidate-one"), sha256: digest, bytes: bytes.length,
		filePath: join(sourceStore.filesDir, `${digest}.js`), active: false,
	});
	assert.equal(existsSync(sourceStore.activePointerPath), false, "download must not create or change active pointer");
	assert.equal(sourceStore.resolveSource()?.active, false);
	assert.deepEqual(sourceStore.readCurrentPinnedJS(), Buffer.from(bytes));
	assert.equal(fetchCalls, 1, "resolve/read must not cause a network request");
	assert.equal(statSync(sourceStore.cacheDir).mode & 0o777, 0o700);
	assert.equal(statSync(sourceStore.filesDir).mode & 0o777, 0o700);
	assert.equal(statSync(sourceStore.manifestsDir).mode & 0o777, 0o700);
	assert.equal(statSync(candidate.filePath).mode & 0o777, 0o600);
	const manifestFiles = readdirSync(sourceStore.manifestsDir);
	assert.equal(manifestFiles.length, 1);
	assert.equal(statSync(join(sourceStore.manifestsDir, manifestFiles[0])).mode & 0o777, 0o600);

	const active = await sourceStore.activateRef(digest);
	assert.equal(active.active, true);
	assert.equal(sourceStore.resolveSource()?.active, true);
	assert.equal(existsSync(sourceStore.activePointerPath), true);
	assert.equal(statSync(sourceStore.activePointerPath).mode & 0o777, 0o600);
	assert.deepEqual(sourceStore.readCurrentPinnedJS(), Buffer.from(bytes));
	const activePointerBeforeInvalidActivation = readFileSync(sourceStore.activePointerPath);
	await assert.rejects(sourceStore.activateRef("e".repeat(64)), /No verified cached database plugin candidate/);
	assert.deepEqual(readFileSync(sourceStore.activePointerPath), activePointerBeforeInvalidActivation,
		"failed activation must not change the active pointer");
	assert.equal(await sourceStore.rollback(), null, "first activation has no predecessor to roll back to");
}));

test("hash mismatch and declared or streamed oversize responses preserve cached candidates and active source", async () => fixture(async (cwd) => {
	const good = new TextEncoder().encode("known-good-active-plugin\n");
	const goodHash = sha(good);
	const base = store(cwd, async () => responseFor(good), { ref: ref("good"), expectedSha256: goodHash });
	await base.downloadSource();
	await base.activateRef(goodHash);
	const activePointerBefore = readFileSync(base.activePointerPath);

	const mismatch = store(cwd, async () => responseFor(new TextEncoder().encode("not the pinned bytes")), {
		ref: ref("bad-hash"), expectedSha256: sha("different expected bytes"),
	});
	await assert.rejects(mismatch.downloadSource(), /SHA-256 mismatch/);
	assert.equal(mismatch.resolveSource(), null);
	assert.deepEqual(readFileSync(base.activePointerPath), activePointerBefore);
	assert.equal(base.resolveSource()?.active, true);

	const tooLargeDeclared = store(cwd, async () => responseFor(new Uint8Array(), { "content-length": String(DATABASE_PLUGIN_MAX_BYTES + 1) }), {
		ref: ref("large-header"), expectedSha256: sha("never stored"),
	});
	await assert.rejects(tooLargeDeclared.downloadSource(), /exceeds .* byte limit/);
	assert.equal(tooLargeDeclared.resolveSource(), null);

	let canceled = false;
	let emitted = 0;
	const streamed = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (emitted < 12) { emitted++; controller.enqueue(new Uint8Array(1024 * 1024)); }
			else { controller.enqueue(new Uint8Array(1)); }
		},
		cancel() { canceled = true; },
	});
	const tooLargeStreamed = store(cwd, async () => new Response(streamed), {
		ref: ref("large-stream"), expectedSha256: sha("never stored either"),
	});
	await assert.rejects(tooLargeStreamed.downloadSource(), /exceeds .* byte limit/);
	assert.equal(canceled, true);
	assert.equal(tooLargeStreamed.resolveSource(), null);
	assert.deepEqual(readFileSync(base.activePointerPath), activePointerBefore);
	assert.equal(base.resolveSource()?.active, true);
}));

test("download timeout covers a stalled response body and leaves no partial cache entry", async () => fixture(async (cwd) => {
	let canceled = false;
	const stalled = new ReadableStream<Uint8Array>({
		pull() { return new Promise<void>(() => {}); },
		cancel() { canceled = true; },
	});
	const sourceStore = store(cwd, async () => new Response(stalled), {
		ref: ref("body-timeout"), expectedSha256: sha("not returned"), downloadTimeoutMs: 30,
	});
	await assert.rejects(sourceStore.downloadSource(), /timed out/);
	assert.equal(sourceStore.resolveSource(), null);
	assert.ok(existsSync(sourceStore.filesDir));
	assert.equal(readdirSync(sourceStore.filesDir).length, 0);
	assert.equal(canceled, true);
}));

test("same-hash concurrent candidate downloads publish one complete immutable blob", async () => fixture(async (cwd) => {
	const bytes = new TextEncoder().encode("parallel, synthetic and pinned\n");
	const digest = sha(bytes);
	let calls = 0;
	const sourceStore = store(cwd, async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return responseFor(bytes);
	}, { ref: ref("parallel"), expectedSha256: digest });
	const [one, two] = await Promise.all([sourceStore.downloadSource(), sourceStore.downloadSource()]);
	assert.equal(calls, 2, "both requested downloads are independently verified");
	assert.equal(one.filePath, two.filePath);
	assert.equal(sha(readFileSync(one.filePath)), digest);
	assert.deepEqual(readFileSync(one.filePath), Buffer.from(bytes));
	assert.equal(readdirSync(sourceStore.filesDir).filter((name) => name.endsWith(".js")).length, 1);
	assert.equal(sourceStore.resolveSource()?.sha256, digest);
}));

test("concurrent sibling update candidates never replace a valid active or rollback source", async () => fixture(async (cwd) => {
	const fixtures = new Map<string, Uint8Array>();
	const fetchFor = (bytes: Uint8Array): FetchMock => async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return responseFor(bytes);
	};
	const activeBytes = new TextEncoder().encode("active synthetic source A");
	const activeHash = sha(activeBytes);
	const first = store(cwd, fetchFor(activeBytes), { ref: ref("parallel-active"), expectedSha256: activeHash });
	const active = await first.downloadSource();
	await first.activateRef(activeHash);
	const activeBytesBefore = readFileSync(active.filePath);

	const candidateB = new TextEncoder().encode("candidate B synthetic source");
	const candidateC = new TextEncoder().encode("candidate C synthetic source");
	const hashB = sha(candidateB), hashC = sha(candidateC);
	const refB = ref("parallel-candidate-b"), refC = ref("parallel-candidate-c");
	fixtures.set(refB, candidateB); fixtures.set(refC, candidateC);
	const bStore = store(cwd, async (input) => responseFor(fixtures.get(String(input))!), { ref: refB, expectedSha256: hashB });
	const cStore = store(cwd, async (input) => responseFor(fixtures.get(String(input))!), { ref: refC, expectedSha256: hashC });
	await Promise.all([bStore.downloadSource(), cStore.downloadSource()]);

	assert.equal(first.resolveSource()?.active, true);
	assert.deepEqual(readFileSync(active.filePath), activeBytesBefore);
	assert.deepEqual(first.readCurrentPinnedJS(), Buffer.from(activeBytes));
	await first.activateRef(hashB);
	assert.deepEqual(first.readCurrentPinnedJS(), Buffer.from(candidateB), "the read API follows an explicitly activated candidate");
	assert.deepEqual(readFileSync(active.filePath), activeBytesBefore, "activating a sibling candidate keeps prior bytes intact");
	const rollback = await first.rollback();
	assert.equal(rollback?.sha256, activeHash);
	assert.equal(first.resolveSource()?.active, true);
	assert.deepEqual(readFileSync(active.filePath), activeBytesBefore);
}));

test("cache quota evicts only old inactive candidates and preserves current plus rollback source", async () => fixture(async (cwd) => {
	const byRef = new Map<string, Uint8Array>();
	const sourceStore = store(cwd, async (input) => {
		const bytes = byRef.get(String(input));
		if (!bytes) return new Response("not found", { status: 404 });
		return responseFor(bytes);
	}, { ref: ref("cache-1"), expectedSha256: "0".repeat(64) });
	const hashes: string[] = [];
	for (let index = 1; index <= DATABASE_PLUGIN_MAX_CACHED_SOURCES + 1; index++) {
		const candidateRef = ref(`cache-${index}`);
		const bytes = new TextEncoder().encode(`synthetic-cache-fixture-${index}`);
		const digest = sha(bytes);
		byRef.set(candidateRef, bytes);
		hashes.push(digest);
		await sourceStore.downloadSource({ ref: candidateRef, expectedSha256: digest });
		if (index === 1 || index === 2) await sourceStore.activateRef(digest);
	}
	const files = readdirSync(sourceStore.filesDir).filter((name) => name.endsWith(".js"));
	assert.ok(files.length <= DATABASE_PLUGIN_MAX_CACHED_SOURCES);
	assert.ok(sourceStore.resolveSource({ ref: ref("cache-1"), expectedSha256: hashes[0] }), "rollback candidate must be retained");
	assert.ok(sourceStore.resolveSource({ ref: ref("cache-2"), expectedSha256: hashes[1] })?.active, "current active source must be retained");
	const cache3 = sourceStore.resolveSource({ ref: ref("cache-3"), expectedSha256: hashes[2] });
	const cache4 = sourceStore.resolveSource({ ref: ref("cache-4"), expectedSha256: hashes[3] });
	assert.ok((cache3 === null) !== (cache4 === null), "one oldest inactive candidate is evicted to satisfy the quota");
	assert.ok(sourceStore.resolveSource({ ref: ref("cache-5"), expectedSha256: hashes[4] }), "new candidate must be cached");
	const rolledBack = await sourceStore.rollback();
	assert.equal(rolledBack?.sha256, hashes[0]);
	assert.equal(sourceStore.resolveSource({ ref: ref("cache-1"), expectedSha256: hashes[0] })?.active, true);
	assert.deepEqual(readFileSync(rolledBack!.filePath), Buffer.from(byRef.get(ref("cache-1"))!));
}));

test("rejects symlinked cache ancestors and symlinked cached blobs", async () => fixture(async (cwd) => {
	const outside = join(cwd, "outside");
	const alias = join(cwd, "alias");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(outside);
	symlinkSync(outside, alias, "dir");
	assert.throws(() => new DatabasePluginSourceStore({ cwd: alias, fetch: async () => responseFor(defaultFixture) }), /Unsafe database plugin cache path component/);

	const sourceStore = store(cwd, async () => responseFor(defaultFixture), {
		ref: ref("symlink-blob"), expectedSha256: sha(defaultFixture),
	});
	const candidate = await sourceStore.downloadSource();
	const backup = `${candidate.filePath}.held`;
	const { renameSync } = await import("node:fs");
	renameSync(candidate.filePath, backup);
	try {
		symlinkSync(backup, candidate.filePath, "file");
		assert.equal(sourceStore.resolveSource(), null);
		await assert.rejects(sourceStore.activateRef(candidate.sha256), /No verified cached/);
		assert.ok(lstatSync(candidate.filePath).isSymbolicLink());
	} finally {
		rmSync(candidate.filePath, { force: true });
		renameSync(backup, candidate.filePath);
	}
}));
