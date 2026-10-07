import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("active documentation links resolve and retired author architecture no longer masquerades as current", () => {
	const files = ["README.md", "AGENTS.md", "TESTING.md", ...["docs", "deploy"].flatMap(dir => readdirSync(join(root, dir)).filter(name => name.endsWith(".md")).map(name => `${dir}/${name}`))];
	for (const name of files) {
		const file = join(root, name), text = readFileSync(file, "utf8");
		for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
			const target = match[1].split("#", 1)[0];
			if (!target || /^(?:\w+:\/\/|mailto:)/.test(target)) continue;
			assert.ok(existsSync(resolve(dirname(file), target)), `${name}: missing ${target}`);
		}
		assert.ok(!/PLAN-ASK\.md|PLAN-RP-AGENT(?:-EXEC)?\.md|PLAN-RP-HARNESS\.md|ARCHITECTURE-RP-PIPELINE-20260902\.md|history\/ARCHITECTURE/.test(text), `${name}: retired architecture pointer`);
	}
	const flow = readFileSync(join(root, "docs/PLAN-ROUND-FLOW.md"), "utf8");
	assert.match(flow, /普通文本/); assert.match(flow, /3\/2\/2|三份|三报告/); assert.ok(!flow.includes("第一个动作就 ask"));
});
