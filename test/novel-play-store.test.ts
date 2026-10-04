import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import type { NovelPackage } from "../src/novel-play/canon.ts";
import { novelNodeId } from "../src/novel-play/source.ts";
import type { NovelSource } from "../src/novel-play/source.ts";
import { loadNovelPackage, novelPackageFile, novelPlayStoreRoot, saveNovelPackage } from "../src/novel-play/store.ts";

const sourceFor = (docId = "novel-1"): NovelSource => ({
	version: 1,
	docId,
	title: "Novel",
	fingerprint: "source-fingerprint",
	chunkChars: 1000,
	chunks: [{ index: 0, chars: 10, chapters: ["Chapter 1"], text: "Alpha text" }],
});

function packageFor(source: NovelSource): NovelPackage {
	const ref = { chunkIndex: 0, start: 0, end: 5, quote: "Alpha" };
	return buildNovelPackage(source, [{ id: "opening", order: 0, title: "Opening" }], [{
		id: novelNodeId(source, ref, "arrival"),
		key: "arrival",
		stageId: "opening",
		order: 0,
		title: "Arrival",
		summary: "The protagonist arrives.",
		visibility: "public",
		dependsOn: [],
		sourceRefs: [ref],
	}]);
}

function withTemp(run: (cwd: string) => void): void {
	const cwd = mkdtempSync(`${tmpdir()}/novel-play-store-`);
	try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("saves and loads a versioned package with source evidence", () => withTemp(cwd => {
	const source = sourceFor();
	const pkg = packageFor(source);
	const file = saveNovelPackage(cwd, source, pkg);
	assert.equal(file, novelPackageFile(cwd, source.docId, pkg.revision));
	assert.deepEqual(loadNovelPackage(cwd, source.docId, pkg.revision), { version: 1, source, package: pkg });
}));

test("save is idempotent for identical immutable content", () => withTemp(cwd => {
	const source = sourceFor();
	const pkg = packageFor(source);
	const first = saveNovelPackage(cwd, source, pkg);
	const before = readFileSync(first, "utf8");
	assert.equal(saveNovelPackage(cwd, source, pkg), first);
	assert.equal(readFileSync(first, "utf8"), before);
}));

test("wrong revision fails explicitly", () => withTemp(cwd => {
	const source = sourceFor();
	const pkg = packageFor(source);
	saveNovelPackage(cwd, source, pkg);
	assert.throws(() => loadNovelPackage(cwd, source.docId, "wrong-revision"), /revision not found/);
}));

test("corrupt package content fails canonical revision validation", () => withTemp(cwd => {
	const source = sourceFor();
	const pkg = packageFor(source);
	const file = saveNovelPackage(cwd, source, pkg);
	const raw = JSON.parse(readFileSync(file, "utf8"));
	raw.package.nodes[0].summary = "Changed without a new revision.";
	writeFileSync(file, JSON.stringify(raw), "utf8");
	assert.throws(() => loadNovelPackage(cwd, source.docId, pkg.revision), /revision does not match/);
}));

test("unsafe identifiers are hashed and cannot traverse the store", () => withTemp(cwd => {
	const source = sourceFor("../../outside/novel");
	const pkg = packageFor(source);
	const file = saveNovelPackage(cwd, source, pkg);
	const root = resolve(novelPlayStoreRoot(cwd));
	const rel = relative(root, resolve(file));
	assert.equal(isAbsolute(rel), false);
	assert.equal(rel.startsWith(".."), false);
	assert.equal(existsSync(resolve(cwd, "outside")), false);
	assert.equal(loadNovelPackage(cwd, source.docId, pkg.revision).source.docId, source.docId);
}));

test("an existing mismatched revision is never overwritten", () => withTemp(cwd => {
	const source = sourceFor();
	const pkg = packageFor(source);
	const file = novelPackageFile(cwd, source.docId, pkg.revision);
	saveNovelPackage(cwd, source, pkg);
	writeFileSync(file, "{}", "utf8");
	assert.throws(() => saveNovelPackage(cwd, source, pkg));
	assert.equal(readFileSync(file, "utf8"), "{}");
}));
