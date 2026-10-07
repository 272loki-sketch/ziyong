import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, ModelRegistry, SessionManager } from "@liyuan/agent-runtime";
import { streamSimple } from "@liyuan/ai/compat";
import {
	loadAgentConfig, loadProfile, normalizeAgentConfig, saveAgentConfig, saveProfile,
	syncAgentConfigToRuntime, type LiyuanAgentConfig,
} from "../src/agent-config.ts";
import { StageEngine, type StageStreamFn } from "../src/stage/engine.ts";
import { presentationFixtureReply } from "./support/agent-presentation-fixture.ts";

const compatOf = (model: { compat?: unknown }) => model.compat as Record<string, unknown> | undefined;
const fixtureConfig = (baseUrl = "http://127.0.0.1:9/v1"): LiyuanAgentConfig => normalizeAgentConfig({
	version: 1, defaultProvider: "fixture", defaultModel: "writer", defaultThinkingLevel: "off",
	providers: {
		fixture: {
			baseUrl, api: "openai-completions", apiKey: "synthetic-not-a-real-key",
			compat: { streaming: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [
				{ id: "writer", contextWindow: 128000, maxTokens: 10000, thinkingLevel: "off", fixtureExtra: "keep", compat: { supportsStrictMode: false, fixtureExtra: "keep" } },
				{ id: "sibling", compat: { supportsTools: false, supportsReasoningEffort: false } },
			],
		},
	},
});

function configFixture() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tool-support-"));
	const agentDir = join(cwd, "agent");
	return { cwd, agentDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("工具能力未配置不被强行禁用，false往返保留其他模型/渠道能力", () => {
	const f = configFixture();
	try {
		const config = fixtureConfig();
		assert.equal(compatOf(config.providers.fixture.models![0]).supportsTools, undefined);
		config.providers.fixture.models![0].compat = { ...compatOf(config.providers.fixture.models![0]), supportsTools: false };
		saveAgentConfig(f.cwd, config);
		saveProfile(f.cwd, "fixture", "合成配置", config);
		for (const actual of [loadAgentConfig(f.cwd).config, loadProfile(f.cwd, "fixture")!.config]) {
			assert.deepEqual(actual, config);
			assert.equal(compatOf(actual.providers.fixture.models![0]).supportsTools, false);
			assert.equal(compatOf(actual.providers.fixture).streaming, false);
			assert.equal(compatOf(actual.providers.fixture.models![1]).supportsTools, false);
		}
		syncAgentConfigToRuntime(f.cwd, f.agentDir, config);
		const runtime = JSON.parse(readFileSync(join(f.agentDir, "models.json"), "utf8"));
		assert.deepEqual(runtime.providers, config.providers);
	} finally { f.cleanup(); }
});

test("运行时工具能力遵循模型覆盖渠道，刷新可以独立重新开启", () => {
	const f = configFixture();
	try {
		const config = fixtureConfig();
		config.providers.fixture.compat = { ...compatOf(config.providers.fixture), supportsTools: false };
		config.providers.fixture.models![0].compat = { ...compatOf(config.providers.fixture.models![0]), supportsTools: true };
		syncAgentConfigToRuntime(f.cwd, f.agentDir, config);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(f.agentDir, "models.json"));
		assert.equal(registry.getError(), undefined);
		assert.equal(compatOf(registry.find("fixture", "writer")!).supportsTools, true);
		assert.equal(compatOf(registry.find("fixture", "sibling")!).supportsTools, false);
		assert.equal(compatOf(registry.find("fixture", "writer")!).streaming, false);
		assert.equal(compatOf(registry.find("fixture", "writer")!).supportsStrictMode, false);
		const siblingBefore = structuredClone(registry.find("fixture", "sibling"));
		for (const enabled of [false, true]) {
			config.providers.fixture.models![0].compat = { ...compatOf(config.providers.fixture.models![0]), supportsTools: enabled };
			saveAgentConfig(f.cwd, config);
			syncAgentConfigToRuntime(f.cwd, f.agentDir, config);
			registry.refresh();
			assert.equal(registry.getError(), undefined);
			assert.equal(compatOf(registry.find("fixture", "writer")!).supportsTools, enabled);
			assert.deepEqual(registry.find("fixture", "sibling"), siblingBefore);
			assert.equal(config.defaultModel, "writer");
		}
	} finally { f.cleanup(); }
});

test("无模型覆盖时，运行时继承渠道的工具能力false", () => {
	const f = configFixture();
	try {
		const config = fixtureConfig();
		config.providers.fixture.compat = { ...compatOf(config.providers.fixture), supportsTools: false };
		syncAgentConfigToRuntime(f.cwd, f.agentDir, config);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(f.agentDir, "models.json"));
		assert.equal(registry.getError(), undefined);
		assert.equal(compatOf(registry.find("fixture", "writer")!).supportsTools, false);
	} finally { f.cleanup(); }
});

// Real runtime + HTTP serialization, but entirely local/synthetic. No paid API,
// production card/session, prompt log, or user credentials are involved.
test("配置开关贯通runtime/引擎/实际HTTP：默认有tools，取消无tools，重开恢复", { timeout: 30000 }, async () => {
	const f = configFixture();
	const requests: Array<Record<string, any>> = [];
	const replies: string[] = [];
	const errors: unknown[] = [];
	const server = createServer(async (req, res) => {
		try {
			assert.equal(req.url, "/v1/chat/completions");
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push(body);
			const messages = body.messages.map((m: any) => ({ ...m, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content }));
			const presentation = presentationFixtureReply({ messages });
			const text = presentation?.text ?? (body.model === "writer" ? replies.shift()
				: body.model === "literaryDirector" ? JSON.stringify({ scenePressure: "合成资料", characterInitiatives: [], candidateBeats: [] })
				: body.model === "scribe" ? JSON.stringify({ patch: { location: "合成书房" } })
				: JSON.stringify({ summary: "合成报告", facts: [], inferences: [], candidates: [], issues: [] }));
			assert.equal(typeof text, "string", "unexpected synthetic API request");
			const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
			if (body.stream) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
			} else {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
			}
		} catch (error) {
			errors.push(error);
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "synthetic fixture failure" } }));
		}
	});
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const config = fixtureConfig(`http://127.0.0.1:${address.port}/v1`);
		const steps = ["literaryDirector", "literaryContinuity", "directorSetting", "directorIdeas", "directorReviewFacts", "directorReviewStyle", "ecologyRuntime", "scribe"];
		config.providers.fixture.models!.push(...steps.map(id => ({ id })));
		syncAgentConfigToRuntime(f.cwd, f.agentDir, config);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(f.agentDir, "models.json"));
		assert.equal(registry.getError(), undefined);
		mkdirSync(join(f.cwd, ".liyuan"), { recursive: true });
		symlinkSync(new URL("../skills", import.meta.url), join(f.cwd, "skills"), "dir");
		writeFileSync(join(f.cwd, "card.json"), JSON.stringify({ data: { name: "合成角色", description: "合成角色说明", first_mes: "合成开场。" } }));
		const stageConfig = { card: "card.json", userName: "合成用户", generationMode: "direct", literaryQuality: "guided", literaryWorldEnabled: false, literaryEcologyEnabled: false, stepModels: Object.fromEntries(steps.map(id => [id, { provider: "fixture", id }])) };
		const saveStageConfig = () => writeFileSync(join(f.cwd, "liyuan.config.json"), JSON.stringify(stageConfig));
		saveStageConfig();
		const stepModelsBefore = structuredClone(stageConfig.stepModels);
		const sm = SessionManager.create(f.cwd, join(f.cwd, "sessions"));
		const engine = new StageEngine({ cwd: f.cwd, getSessionManager: () => sm as never,
			getModel: () => registry.find("fixture", "writer"), findModel: (provider, id) => registry.find(provider, id),
			getAuth: async () => ({ apiKey: "synthetic-not-a-real-key" }), streamFn: streamSimple as unknown as StageStreamFn });
		for (const enabled of [undefined, false, true]) {
			const entry = config.providers.fixture.models![0];
			if (enabled !== undefined) entry.compat = { ...compatOf(entry), supportsTools: enabled };
			syncAgentConfigToRuntime(f.cwd, f.agentDir, config);
			registry.refresh();
			assert.equal(registry.getError(), undefined);
			const begin = requests.length;
			const narrative = `合成正文${String(enabled)}。角色打开记录册，逐项核对已经确定的资料。`;
			replies.push(narrative);
			await engine.performTurn("合成输入。");
			assert.deepEqual(errors, []);
			assert.equal(replies.length, 0);
			const calls = requests.slice(begin);
			assert.ok(calls.length > 0);
			const main = calls.find(call => call.model === "writer");
			assert.ok(main);
			assert.equal(Object.hasOwn(main, "tools"), enabled !== false);
			if (enabled === false) for (const call of calls) {
				assert.equal(Object.hasOwn(call, "tools"), false);
				assert.equal(Object.hasOwn(call, "tool_choice"), false);
				assert.equal(Object.hasOwn(call, "parallel_tool_calls"), false);
			}
			const reply: any = sm.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant").at(-1);
			assert.equal(reply.message.details.rpNarrative, narrative);
			assert.equal(reply.message.details.rpGenerationWorkflow.mode, "direct");
			assert.equal(reply.message.details.rpGenerationWorkflow.toolFallback, enabled === false);
			assert.deepEqual(stageConfig.stepModels, stepModelsBefore);
		}
		// Same disabled model stays director: fixed evidence/ideas/review stages.
		config.providers.fixture.models![0].compat = { ...compatOf(config.providers.fixture.models![0]), supportsTools: false };
		syncAgentConfigToRuntime(f.cwd, f.agentDir, config); registry.refresh();
		stageConfig.generationMode = "director"; saveStageConfig();
		replies.push(JSON.stringify({ tasks: [{ role: "idea-a", task: "合成角度一" }, { role: "idea-b", task: "合成角度二" }] }), "合成导演正文。角色核对记录册。", '{"decision":"keep"}');
		const begin = requests.length;
		await engine.performTurn("合成导演输入。");
		assert.deepEqual(errors, []);
		assert.equal(replies.length, 0);
		for (const request of requests.slice(begin)) {
			assert.equal(Object.hasOwn(request, "tools"), false);
			assert.equal(Object.hasOwn(request, "tool_choice"), false);
		}
		const reply: any = sm.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant").at(-1);
		assert.equal(reply.message.details.rpNarrative, "合成导演正文。角色核对记录册。");
		const workflow = reply.message.details.rpGenerationWorkflow;
		assert.equal(workflow.mode, "director");
		assert.equal(workflow.toolFallbackReason, "configured");
		assert.deepEqual(workflow.stages.filter((x: any) => ["evidence", "ideas", "review"].includes(x.stage)).map((x: any) => x.calls), [3, 2, 2]);
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		f.cleanup();
	}
});
