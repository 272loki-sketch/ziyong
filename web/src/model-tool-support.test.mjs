import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const filename = resolve(here, "model-tool-support.ts");
const source = readFileSync(filename, "utf8");
const output = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	fileName: filename,
}).outputText;
const module = { exports: {} };
vm.runInThisContext(`(function(module, exports) { ${output}\n})`, { filename })(module, module.exports);
const { modelSupportsTools, withConfigModelToolsSupport, withModelToolsSupport } = module.exports;

test("model compat overrides provider compat and missing support defaults true", () => {
	assert.equal(modelSupportsTools(undefined), true);
	assert.equal(modelSupportsTools({}, { supportsTools: false }), false);
	assert.equal(modelSupportsTools({ compat: { supportsTools: true } }, { supportsTools: false }), true);
	assert.equal(modelSupportsTools({ compat: { supportsTools: false } }, { supportsTools: true }), false);
	assert.equal(modelSupportsTools({ compat: { supportsTools: "false" } }, { supportsTools: false }), false);
});

test("model toggle preserves other compat, thinking, capacity, and unknown fields", () => {
	const model = {
		id: "m1",
		thinkingLevel: "high",
		contextWindow: 512000,
		maxTokens: 32768,
		customModelField: { keep: true },
		compat: { supportsTools: false, streaming: false, customCompat: "keep" },
	};
	const enabled = withModelToolsSupport(model, true);
	assert.deepEqual(enabled, { ...model, compat: { ...model.compat, supportsTools: true } });
	assert.deepEqual(model.compat, { supportsTools: false, streaming: false, customCompat: "keep" });
});

test("active config toggle updates only the selected model and preserves surrounding config", () => {
	const config = {
		version: 1,
		customTopLevel: { keep: true },
		defaultProvider: "p",
		defaultModel: "m2",
		defaultThinkingLevel: "off",
		stepModels: { writer: { provider: "other", id: "special-writer" } },
		providers: {
			p: {
				baseUrl: "https://example.invalid",
				compat: { supportsTools: false, streaming: false, customProvider: 7 },
				models: [
					{ id: "m1", thinkingLevel: "high", contextWindow: 64000, custom: 1, compat: { supportsTools: false, custom: 2 } },
					{ id: "m2", maxTokens: 4096, compat: { streaming: false } },
				],
			},
			other: { baseUrl: "https://other.invalid", customProvider: "untouched", models: [{ id: "other-model", custom: true }] },
		},
	};
	const updated = withConfigModelToolsSupport(config, "p", "m1", true);
	assert.equal(updated.providers.p.models[0].compat.supportsTools, true);
	assert.deepEqual(updated.providers.p.models[0], { ...config.providers.p.models[0], compat: { supportsTools: true, custom: 2 } });
	assert.deepEqual(updated.providers.p.compat, config.providers.p.compat);
	assert.deepEqual(updated.providers.p.models[1], config.providers.p.models[1]);
	assert.deepEqual(updated.customTopLevel, config.customTopLevel);
	assert.equal(updated.defaultProvider, "p");
	assert.equal(updated.defaultModel, "m2");
	assert.deepEqual(updated.defaultThinkingLevel, "off");
	assert.deepEqual(updated.stepModels, config.stepModels);
	assert.deepEqual(updated.providers.other, config.providers.other);
	assert.equal(config.providers.p.models[0].compat.supportsTools, false);
});

test("active config toggle creates just the missing model override", () => {
	const config = { providers: { p: { compat: { supportsTools: true, other: "kept" }, models: [{ id: "m1", custom: 1 }] } } };
	const updated = withConfigModelToolsSupport(config, "p", "new-model", false);
	assert.deepEqual(updated.providers.p.models, [
		{ id: "m1", custom: 1 },
		{ id: "new-model", compat: { supportsTools: false } },
	]);
	assert.deepEqual(config.providers.p.models, [{ id: "m1", custom: 1 }]);
});


test("unknown runtime placeholder cannot create an unconfigured provider", () => {
	const config = { version: 1, providers: { configured: { models: [{ id: "known" }] } } };
	const before = structuredClone(config);
	assert.throws(() => withConfigModelToolsSupport(config, "unknown", "unknown", false), /未在启用配置/);
	assert.deepEqual(config, before);
});
