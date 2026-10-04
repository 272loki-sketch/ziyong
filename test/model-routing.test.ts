import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeStepModels, resolveStepModel } from "../src/model-routing.ts";

test("模型插头：默认继承总插头，覆盖项使用指定模型", () => {
	const primary = { key: "primary" };
	const side = { key: "side" };
	assert.equal(resolveStepModel("scribe", undefined, primary, () => undefined).model, primary);
	const resolved = resolveStepModel("scribe", { scribe: { provider: "p", id: "m" } }, primary, (provider, id) => provider === "p" && id === "m" ? side : undefined);
	assert.equal(resolved.model, side);
	assert.equal(resolved.fallback, false);
});

test("模型插头：指定模型失效时安全回退总插头", () => {
	const primary = { key: "primary" };
	const resolved = resolveStepModel("compaction", { compaction: { provider: "gone", id: "gone" } }, primary, () => undefined);
	assert.equal(resolved.model, primary);
	assert.equal(resolved.fallback, true);
	assert.deepEqual(resolved.requested, { provider: "gone", id: "gone" });
});

test("模型插头：渠道改名后按唯一模型 id 自动重定位", () => {
	const primary = { provider: "main", id: "story" };
	const moved = { provider: "new-channel", id: "deepseek-v4-flash" };
	const result = resolveStepModel(
		"compaction",
		{ compaction: { provider: "deleted-channel", id: "deepseek-v4-flash" } },
		primary,
		() => undefined,
		(id) => (id === moved.id ? moved : undefined),
	);
	assert.equal(result.model, moved);
	assert.equal(result.fallback, false);
});

test("模型插头：配置规范化只保留已知步骤和完整复合键", () => {
	assert.deepEqual(normalizeStepModels({
		literaryDirector: { provider: " p ", id: " m " },
		literaryWorld: { provider: " world ", id: " sim " },
		worldProfile: { provider: " profile ", id: " architect " },
		literaryWorldFacts: { provider: " facts ", id: " extractor " },
		literaryWorldAudit: { provider: " audit ", id: " judge " },
		outlineChat: { provider: " outline ", id: " room " },
		ecologyGlobal: { provider: " google ", id: " gemini-3.1-pro " },
		scribe: { provider: "", id: "bad" },
		unknown: { provider: "x", id: "y" },
	}), { literaryDirector: { provider: "p", id: "m" }, literaryWorld: { provider: "world", id: "sim" }, worldProfile: { provider: "profile", id: "architect" }, literaryWorldFacts: { provider: "facts", id: "extractor" }, literaryWorldAudit: { provider: "audit", id: "judge" }, ecologyGlobal: { provider: "google", id: "gemini-3.1-pro" }, outlineChat: { provider: "outline", id: "room" } });
	assert.equal(normalizeStepModels({}), undefined);
});

test("模型插头：novelDigest 未配置时回退 outlineResearch 插头", () => {
	const primary = { key: "primary" };
	const researchModel = { key: "research" };
	const resolved = resolveStepModel(
		"novelDigest",
		{ outlineResearch: { provider: "p", id: "r" } },
		primary,
		(provider, id) => (provider === "p" && id === "r" ? researchModel : undefined),
		undefined,
		["outlineResearch"],
	);
	assert.equal(resolved.model, researchModel);
	assert.equal(resolved.fallback, false);
});

test("模型插头：novelDigest 显式覆盖优先生效；两者皆无回落总插头", () => {
	const primary = { key: "primary" };
	const novel = { key: "novel" };
	const direct = resolveStepModel("novelDigest", { novelDigest: { provider: "n", id: "m" } }, primary, (p, id) => (p === "n" && id === "m" ? novel : undefined), undefined, ["outlineResearch"]);
	assert.equal(direct.model, novel);
	const fallback = resolveStepModel("novelDigest", {}, primary, () => undefined, undefined, ["outlineResearch"]);
	assert.equal(fallback.model, primary);
	assert.equal(fallback.fallback, false);
});

test("模型插头：查找层不暴露失鉴权模型时回退总插头", () => {
	const primary = { key: "primary" };
	const resolved = resolveStepModel("scribe", { scribe: { provider: "p", id: "locked" } }, primary, () => undefined);
	assert.equal(resolved.model, primary);
	assert.equal(resolved.fallback, true);
});
