import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAgentConfig } from "../src/agent-config.ts";

test("第三方 chat/completions 默认使用最低公分母兼容能力", () => {
	const cfg = normalizeAgentConfig({
		version: 1,
		providers: {
			custom: {
				baseUrl: "https://relay.example/v1",
				api: "openai-completions",
				models: [{ id: "any-reasoning-model" }],
			},
		},
	});
	assert.deepEqual(cfg.providers.custom.compat, {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	});
});

test("第三方渠道可显式声明高级兼容能力", () => {
	const cfg = normalizeAgentConfig({
		version: 1,
		providers: {
			custom: {
				baseUrl: "https://relay.example/v1",
				api: "openai-completions",
				compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
				models: [{ id: "model" }],
			},
		},
	});
	assert.equal((cfg.providers.custom.compat as Record<string, unknown>).supportsDeveloperRole, true);
	assert.equal((cfg.providers.custom.compat as Record<string, unknown>).supportsReasoningEffort, true);
});

test("OpenAI 官方端点保留自动能力检测", () => {
	const cfg = normalizeAgentConfig({
		version: 1,
		providers: {
			openai: {
				baseUrl: "https://api.openai.com/v1",
				api: "openai-completions",
				models: [{ id: "gpt" }],
			},
		},
	});
	assert.equal(cfg.providers.openai.compat, undefined);
});

import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	repairDefaultProvider,
	saveAgentConfig,
	saveProfile,
	syncAgentConfigToRuntime,
	warehouseProviders,
} from "../src/agent-config.ts";

function tempCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-agentcfg-"));
	mkdirSync(join(cwd, "liyuan-profiles"), { recursive: true });
	return cwd;
}

test("仓库渠道合并进运行时 models.json：启用配置不含 hajimi 时仍可选", () => {
	const cwd = tempCwd();
	const agentDir = join(cwd, "agent-runtime");
	saveProfile(cwd, "hajimi", "hajimi", {
		version: 1,
		defaultProvider: "hajimi",
		defaultModel: "gemini-3.7-flash",
		providers: {
			hajimi: {
				baseUrl: "https://relay.example/v1",
				api: "openai-completions",
				apiKey: "sk-test",
				models: [{ id: "gemini-3.7-flash" }, { id: "gemini-3.1-pro-preview" }],
			},
		},
	});
	saveAgentConfig(cwd, {
		version: 1,
		defaultProvider: "new",
		providers: { new: { baseUrl: "https://new.example/v1", api: "openai-completions", apiKey: "sk-new", models: [{ id: "deepseek-v4-flash" }] } },
	});
	syncAgentConfigToRuntime(cwd, agentDir, {
		version: 1,
		defaultProvider: "new",
		providers: { new: { baseUrl: "https://new.example/v1", api: "openai-completions", apiKey: "sk-new", models: [{ id: "deepseek-v4-flash" }] } },
	});
	const runtime = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as { providers: Record<string, { models?: Array<{ id: string }> }> };
	assert.ok(runtime.providers.hajimi, "hajimi 渠道应合并进运行时");
	assert.ok(runtime.providers.hajimi.models?.some((m) => m.id === "gemini-3.1-pro-preview"));
	assert.ok(runtime.providers.new, "当前启用渠道保留");
	assert.deepEqual(Object.keys(warehouseProviders(cwd)), ["hajimi"]);
});

test("repairDefaultProvider：defaultProvider 指向仓库渠道时补回该渠道", () => {
	const cwd = tempCwd();
	saveProfile(cwd, "hajimi", "hajimi", {
		version: 1,
		defaultProvider: "hajimi",
		providers: { hajimi: { baseUrl: "https://relay.example/v1", api: "openai-completions", apiKey: "sk-test", models: [{ id: "gemini-3.1-pro-preview" }] } },
	});
	const repaired = repairDefaultProvider(cwd, { version: 1, defaultProvider: "hajimi", providers: {} });
	assert.ok(repaired.providers.hajimi);
	assert.equal((repaired.providers.hajimi as { models: Array<{ id: string }> }).models[0]?.id, "gemini-3.1-pro-preview");
});

test("仓库渠道合并：空 Key 配置不得破坏整个运行时模型目录", () => {
	const cwd = tempCwd();
	saveProfile(cwd, "empty", "empty", {
		version: 1,
		providers: { empty: { baseUrl: "https://empty.example/v1", api: "openai-completions", apiKey: "", models: [{ id: "unavailable" }] } },
	});
	saveProfile(cwd, "ready", "ready", {
		version: 1,
		providers: { ready: { baseUrl: "https://ready.example/v1", api: "openai-completions", apiKey: "sk-ready", models: [{ id: "available" }] } },
	});
	assert.deepEqual(Object.keys(warehouseProviders(cwd)), ["ready"]);
});
