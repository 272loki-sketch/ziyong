import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DATABASE_PLUGIN_MAX_OBJECT_BYTES,
	DATABASE_PLUGIN_STORE_DIRECTORY,
	DatabasePluginStore,
	DatabasePluginStoreConflictError,
	DatabasePluginStoreValidationError,
	type DatabasePluginHostState,
	type DatabasePluginScope,
} from "../server/database-plugin-store.ts";

const baseState = (): DatabasePluginHostState => ({
	chatMetadata: { current: { mode: "test" } },
	extensionSettings: { plugin: { enabled: true } },
	messages: {
		entry_root: { TavernDB_ACU_IsolatedData: { default: { value: 1 } } },
	},
	worldbooks: { "test-book": { entries: [{ uid: 1, content: "synthetic lore" }] } },
});

function withTempCwd(run: (cwd: string) => Promise<void> | void): Promise<void> {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-database-plugin-store-"));
	return Promise.resolve()
		.then(() => run(cwd))
		.finally(() => rmSync(cwd, { recursive: true, force: true }));
}

const mode = (path: string) => lstatSync(path).mode & 0o777;

test("private root/scopes/files use restrictive permissions; bytes and scope isolation are preserved", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const root = join(cwd, DATABASE_PLUGIN_STORE_DIRECTORY);
	const scope: DatabasePluginScope = { sessionId: "session-a", card: "cards/a.png" };
	const otherScope: DatabasePluginScope = { sessionId: "session-a", card: "cards/b.png" };
	const payload = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
	const saved = await store.putFile(scope, "user/files/TavernDB_ACU_vector_registry", payload.toString("base64"));

	assert.equal(mode(root), 0o700);
	assert.equal(saved.name, "TavernDB_ACU_vector_registry");
	assert.equal(saved.path, "/api/database-plugin/files/TavernDB_ACU_vector_registry");
	assert.equal(saved.sha256, createHash("sha256").update(payload).digest("hex"));
	assert.equal(saved.size, payload.byteLength);
	const read = await store.readFile(scope, "files/TavernDB_ACU_vector_registry");
	assert.ok(read);
	assert.deepEqual(read.data, payload, "file bytes are not JSON-decoded or otherwise transformed");
	assert.equal(read.sha256, saved.sha256);
	assert.equal(await store.readFile(otherScope, saved.name), null, "same name in a different card scope is isolated");
	const list = await store.listFiles(scope);
	assert.deepEqual(list.map((file) => file.name), [saved.name]);

	const scopesRoot = join(root, "scopes");
	const scopeDirectory = join(scopesRoot, (await import("node:crypto")).createHash("sha256")
		.update(JSON.stringify({ sessionId: scope.sessionId, card: scope.card })).digest("hex"));
	const objectPath = join(scopeDirectory, "objects", saved.name);
	assert.equal(mode(scopesRoot), 0o700);
	assert.equal(mode(scopeDirectory), 0o700);
	assert.equal(mode(objectPath), 0o600);
}));

test("delete and list expose only regular plugin objects and preserve missing-file semantics", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const scope = { sessionId: "delete-list" };
	await store.putFile(scope, "index", Buffer.from("registry").toString("base64"));
	await store.putFile(scope, "nested/shard-1", Buffer.from([3, 4]).toString("base64"));
	assert.deepEqual((await store.listFiles(scope)).map((file) => file.name), ["index", "nested/shard-1"]);
	assert.equal(await store.deleteFile(scope, "user/files/index"), true);
	assert.equal(await store.deleteFile(scope, "index"), false);
	assert.deepEqual((await store.listFiles(scope)).map((file) => file.name), ["nested/shard-1"]);
}));

test("scope key separates sessions and cards even when plugin filenames match", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const name = "TavernDB_ACU_vector_registry";
	await store.putFile({ sessionId: "s1", card: "c1" }, name, Buffer.from("one").toString("base64"));
	await store.putFile({ sessionId: "s1", card: "c2" }, name, Buffer.from("two").toString("base64"));
	await store.putFile({ sessionId: "s2", card: "c1" }, name, Buffer.from("three").toString("base64"));
	assert.equal((await store.readFile({ sessionId: "s1", card: "c1" }, name))?.data.toString(), "one");
	assert.equal((await store.readFile({ sessionId: "s1", card: "c2" }, name))?.data.toString(), "two");
	assert.equal((await store.readFile({ sessionId: "s2", card: "c1" }, name))?.data.toString(), "three");
}));

test("file names normalize supported prefixes and reject traversal, absolute paths, encodings, and unsafe segments", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const scope = { sessionId: "safe-paths" };
	for (const name of ["../escape", "a/../escape", "/absolute", "C:/absolute", "a\\..\\escape", "user/files/../escape", "%2e%2e/escape", ".hidden", "a//b"]) {
		await assert.rejects(store.putFile(scope, name, "eA=="), DatabasePluginStoreValidationError, name);
	}
	const nested = await store.putFile(scope, "user/files/nested.v1/plugin-index", "eA==");
	assert.equal(nested.path, "/api/database-plugin/files/nested.v1%2Fplugin-index");
	assert.equal((await store.readFile(scope, "files/nested.v1/plugin-index"))?.data.toString(), "x");
	assert.deepEqual((await store.listFiles(scope)).map((file) => file.name), ["nested.v1/plugin-index"]);
}));

test("symlinked store roots and object path parents are rejected", async () => withTempCwd(async (cwd) => {
	const target = join(cwd, "outside");
	mkdirSync(target);
	const linkedCwd = join(cwd, "linked-cwd");
	mkdirSync(linkedCwd);
	symlinkSync(target, join(linkedCwd, DATABASE_PLUGIN_STORE_DIRECTORY), "dir");
	assert.throws(() => new DatabasePluginStore(linkedCwd), /real directory/);

	const store = new DatabasePluginStore(cwd);
	const scope = { sessionId: "symlink-case" };
	await store.putFile(scope, "probe", "eA==");
	const scopes = join(cwd, DATABASE_PLUGIN_STORE_DIRECTORY, "scopes");
	// Discover the opaque hashed scope without depending on its hash implementation.
	const scopeHash = (await readdir(scopes))[0]!;
	const outsideDir = join(cwd, "outside-objects");
	mkdirSync(outsideDir);
	symlinkSync(outsideDir, join(scopes, scopeHash, "objects", "link"), "dir");
	await assert.rejects(store.readFile(scope, "link/object"), /real directory/);
	const outsideFile = join(cwd, "outside-file");
	await writeFile(outsideFile, "do not touch");
	symlinkSync(outsideFile, join(scopes, scopeHash, "objects", "linked-file"), "file");
	await assert.rejects(store.readFile(scope, "linked-file"), /non-regular/);
	await assert.rejects(store.putFile(scope, "linked-file", "eA=="), /non-regular/);
	await assert.rejects(store.deleteFile(scope, "linked-file"), /non-regular/);
	await assert.rejects(store.listFiles(scope), /symbolic link/);
}));

test("base64 is validated and decoded object size is capped at 32 MiB", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	await assert.rejects(store.putFile({ sessionId: "base64" }, "bad", "not base64!"), DatabasePluginStoreValidationError);
	assert.equal(DATABASE_PLUGIN_MAX_OBJECT_BYTES, 32 * 1024 * 1024);
	const atLimit = Buffer.alloc(DATABASE_PLUGIN_MAX_OBJECT_BYTES, 0x5a);
	const saved = await store.putFile({ sessionId: "limit" }, "at-limit", atLimit.toString("base64"));
	assert.equal(saved.size, DATABASE_PLUGIN_MAX_OBJECT_BYTES);
	await assert.rejects(
		store.putFile({ sessionId: "over-limit" }, "over-limit", Buffer.alloc(DATABASE_PLUGIN_MAX_OBJECT_BYTES + 1).toString("base64")),
		DatabasePluginStoreValidationError,
	);
}));

test("state snapshots are branch-visible, retain global and visible revisions separately", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const scope = { sessionId: "branch-session", card: "card-x" };
	const baseline = await store.saveState(scope, undefined, 0, baseState());
	assert.equal(baseline.globalRevision, 1);
	const branchAState = baseState();
	branchAState.chatMetadata = { branch: "A" };
	await store.saveState(scope, "entry-A", 1, branchAState);
	const branchBState = baseState();
	branchBState.chatMetadata = { branch: "B" };
	await store.saveState(scope, "entry-B", 2, branchBState);

	const readA = await store.readState(scope, ["entry-root", "entry-A"]);
	assert.equal(readA.snapshot?.sourceEntryId, "entry-A");
	assert.deepEqual(readA.snapshot?.state.chatMetadata, { branch: "A" });
	assert.equal(readA.visibleRevision, 2);
	assert.equal(readA.globalRevision, 3);

	const readB = await store.readState(scope, new Set(["entry-root", "entry-B"]));
	assert.equal(readB.snapshot?.sourceEntryId, "entry-B");
	assert.deepEqual(readB.snapshot?.state.chatMetadata, { branch: "B" });
	assert.equal(readB.visibleRevision, 3);
	assert.equal(readB.globalRevision, 3);

	const baselineOnly = await store.readState(scope, []);
	assert.equal(baselineOnly.snapshot?.revision, 1, "scope-wide source-less snapshot is visible without branch ancestors");
	assert.equal(baselineOnly.globalRevision, 3);
	assert.equal((await store.readState({ sessionId: "empty" }, [])).snapshot, null);
}));

test("state compare-and-swap is atomic across concurrent writers", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const secondStore = new DatabasePluginStore(cwd);
	const scope = { sessionId: "cas" };
	const results = await Promise.allSettled([
		store.saveState(scope, "entry-a", 0, baseState()),
		secondStore.saveState(scope, "entry-b", 0, baseState()),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected && rejected.status === "rejected");
	assert.ok(rejected.reason instanceof DatabasePluginStoreConflictError);
	assert.equal(rejected.reason.expectedRevision, 0);
	assert.equal(rejected.reason.actualRevision, 1);
	assert.equal((await store.readState(scope, ["entry-a", "entry-b"])).globalRevision, 1);
}));

test("state refuses non-TavernDB message fields, story/thinking payload keys, and non-JSON values", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const scope = { sessionId: "state-validation" };
	const badMessageKey = baseState();
	badMessageKey.messages.entry_root.mes = "must never persist";
	await assert.rejects(store.saveState(scope, "entry", 0, badMessageKey), /forbidden in database-plugin snapshots|not a TavernDB_\* extension field/);

	const thinking = baseState();
	thinking.messages.entry_root.TavernDB_ACU_Custom = { thinking: "private chain" };
	await assert.rejects(store.saveState(scope, "entry", 0, thinking), /thinking is forbidden/);

	const rawNarrative = baseState();
	(rawNarrative.chatMetadata as Record<string, unknown>).rpNarrative = "not allowed";
	await assert.rejects(store.saveState(scope, "entry", 0, rawNarrative), /rpNarrative is forbidden/);

	const withUndefined = baseState();
	(withUndefined.extensionSettings as Record<string, unknown>).invalid = undefined;
	await assert.rejects(store.saveState(scope, "entry", 0, withUndefined), /not JSON-serializable/);

	const oversized = baseState();
	(oversized.chatMetadata as Record<string, unknown>).large = "x".repeat(DATABASE_PLUGIN_MAX_OBJECT_BYTES);
	await assert.rejects(store.saveState(scope, "entry", 0, oversized), /exceeds the 33554432-byte limit/);

	const arrayProperty = baseState();
	const jsonArray = [] as unknown[] & { hidden?: string };
	jsonArray.hidden = "must not be silently dropped";
	(arrayProperty.extensionSettings as Record<string, unknown>).array = jsonArray;
	await assert.rejects(store.saveState(scope, "entry", 0, arrayProperty), /unsupported array property/);

	const circularValue: Record<string, unknown> = {};
	circularValue.self = circularValue;
	const circular = baseState();
	(circular.messages.entry_root as Record<string, unknown>).TavernDB_ACU_Custom = circularValue;
	await assert.rejects(store.saveState(scope, "entry", 0, circular), /circular reference/);
	assert.equal((await store.readState(scope, [])).globalRevision, 0, "rejected state writes do not advance the CAS revision");
}));

test("scope state snapshot and head files are private and concurrent reads return committed JSON", async () => withTempCwd(async (cwd) => {
	const store = new DatabasePluginStore(cwd);
	const scope = { sessionId: "permissions" };
	await store.saveState(scope, "entry-1", 0, baseState());
	const root = join(cwd, DATABASE_PLUGIN_STORE_DIRECTORY, "scopes");
	const scopeHash = (await readdir(root))[0]!;
	const scopeDirectory = join(root, scopeHash);
	const snapshotsDirectory = join(scopeDirectory, "state-snapshots");
	const snapshotName = (await readdir(snapshotsDirectory))[0]!;
	assert.equal(mode(scopeDirectory), 0o700);
	assert.equal(mode(snapshotsDirectory), 0o700);
	assert.equal(mode(join(scopeDirectory, "state-head.json")), 0o600);
	assert.equal(mode(join(snapshotsDirectory, snapshotName)), 0o600);
	const head = JSON.parse(readFileSync(join(scopeDirectory, "state-head.json"), "utf8")) as { globalRevision: number };
	assert.equal(head.globalRevision, 1);
}));
