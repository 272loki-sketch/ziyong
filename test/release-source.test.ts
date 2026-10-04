import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const upstream = read("scripts/update-local.sh");
const installer = read("deploy/install.sh");

test("local updater defaults to fork main and permits LIYUAN_UPSTREAM override", () => {
	assert.match(upstream, /^UPSTREAM="\$\{LIYUAN_UPSTREAM:-origin\/main\}"$/m);
	assert.doesNotMatch(upstream, /origin\/master/);
	assert.match(upstream, /git fetch "\$\{UPSTREAM%%\/\*\}" --tags/);
});

test("local updater keeps clean-tree, backup, merge, and public health-check safeguards", () => {
	assert.match(upstream, /git status --porcelain/);
	assert.match(upstream, /git bundle create .*--all/);
	assert.match(upstream, /tar -czpf/);
	assert.match(upstream, /git merge --no-edit/);
	assert.match(upstream, /\/healthz/);
	assert.doesNotMatch(upstream, /\/api\/config/);
});

test("installer defaults to fork main and retains repository/ref environment and CLI overrides", () => {
	assert.match(installer, /REPO_DEFAULT="https:\/\/github\.com\/272loki-sketch\/ziyong\.git"/);
	assert.match(installer, /REF="\$\{LIYUAN_REF:-main\}"/);
	assert.match(installer, /REPO="\$\{LIYUAN_REPO:-\$REPO_DEFAULT\}"/);
	assert.match(installer, /--repo\) REPO=/);
	assert.match(installer, /--ref\) REF=/);
	assert.doesNotMatch(installer, /weidu12123\/Liyuan|v1\.0\.0/);
});

test("installer checks Node >=22.19.0 without installing Node", () => {
	assert.ok(installer.includes('[[ "$version" =~ ^([0-9]+)\\.([0-9]+)\\.[0-9]+$ ]]'));
	assert.ok(installer.includes('10#$major < 22 || (10#$major == 22 && 10#$minor < 19)'));
	assert.match(installer, /Node\.js >= 22\.19\.0/);
	assert.doesNotMatch(installer, /install_node_if_missing|apt-get install|dnf install|nodesource\.com/);
});

test("online updater defaults to fork repo and honors LIYUAN_UPDATE_REPO", async () => {
	const previous = process.env.LIYUAN_UPDATE_REPO;
	try {
		delete process.env.LIYUAN_UPDATE_REPO;
		const defaults = await import("../src/update.ts?release-source-default");
		assert.equal(defaults.UPDATE_REPO, "272loki-sketch/ziyong");
		process.env.LIYUAN_UPDATE_REPO = "example/override";
		const overridden = await import("../src/update.ts?release-source-override");
		assert.equal(overridden.UPDATE_REPO, "example/override");
	} finally {
		if (previous === undefined) delete process.env.LIYUAN_UPDATE_REPO;
		else process.env.LIYUAN_UPDATE_REPO = previous;
	}
});

test("home badge and title point at fork main", () => {
	const home = read("web/src/components/HomePage.tsx");
	assert.match(home, /https:\/\/github\.com\/272loki-sketch\/ziyong/);
	assert.ok(home.includes('title="GitHub · 272loki-sketch/ziyong · 仓库与版本更新"'));
});

test("installation docs point at fork main", () => {
	for (const path of ["README.md", "deploy/README.md"]) {
		const doc = read(path);
		assert.match(doc, /272loki-sketch\/ziyong\/main\/deploy\/install\.sh/);
		assert.doesNotMatch(doc, /raw\.githubusercontent\.com\/weidu12123\/Liyuan\/v1\.0\.0/);
	}
});
