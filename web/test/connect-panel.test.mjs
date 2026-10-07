import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = process.env.LIYUAN_CONNECT_DIST || join(root, "web/dist");
const artifacts = process.env.LIYUAN_CONNECT_ARTIFACTS;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
	const listener = createServer();
	await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
	const port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	return port;
}

const inheritedProvider = {
	baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "synthetic-not-a-real-key",
	compat: { streaming: false, supportsTools: false, supportsDeveloperRole: false, supportsReasoningEffort: false, fixtureExtra: "keep-inherited" },
	models: [{ id: "inherited-off" }, { id: "override-on", compat: { supportsTools: true, supportsStrictMode: false } }],
	fixtureExtra: "keep-provider",
};
const config = {
	version: 1, defaultProvider: "fixture", defaultModel: "writer", defaultThinkingLevel: "high", fixtureTop: { keep: 37 },
	providers: {
		fixture: {
			baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "synthetic-not-a-real-key",
			compat: { streaming: false, supportsDeveloperRole: false, supportsReasoningEffort: false, fixtureExtra: "keep-provider-compat" },
			fixtureExtra: "keep-provider",
			// Default model is deliberately not first; saving only a checkbox must not reselect it.
			models: [
				{ id: "sibling", thinkingLevel: "off", contextWindow: 128000, maxTokens: 4096, fixtureExtra: "keep-sibling" },
				{ id: "writer", thinkingLevel: "high", contextWindow: 256000, maxTokens: 8192, fixtureExtra: "keep-writer", compat: { supportsStrictMode: false, fixtureExtra: "keep-model-compat" } },
				{ id: "explicit-off", compat: { supportsTools: false, supportsStrictMode: false } },
			],
		},
		inherited: structuredClone(inheritedProvider),
	},
};
const configWithoutToolFlag = raw => {
	const next = structuredClone(raw);
	delete next.providers.fixture.models.find(m => m.id === "writer").compat.supportsTools;
	return next;
};

// Uses real REST persistence/rebinding and the built frontend. All profiles,
// keys, cards and sessions are synthetic and isolated; no model requests.
test("连接工具开关：桌面/手机、默认与继承、保存重开、失败不假成功、多渠道保护", { timeout: 120000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-connect-ui-"));
	if (artifacts) await mkdir(artifacts, { recursive: true });
	const port = await freePort(), base = `http://127.0.0.1:${port}`;
	await mkdir(join(cwd, "web")); await symlink(dist, join(cwd, "web/dist"), "dir");
	for (const name of ["src", "skills", "node_modules"]) await symlink(join(root, name), join(cwd, name), "dir");
	await mkdir(join(cwd, ".liyuan")); await symlink(join(root, ".liyuan/extensions"), join(cwd, ".liyuan/extensions"), "dir");
	const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "connect-tools-ui-fixture", version, type: "module" }));
	await writeFile(join(cwd, "card.json"), JSON.stringify({ data: { name: "合成工具设置卡", description: "隔离界面回归", first_mes: "不调用模型。" } }));
	const stageConfig = { card: "card.json", userName: "Fixture", greeting: false, generationMode: "director", stepModels: { writer: { provider: "fixture", id: "writer" }, scribe: { provider: "fixture", id: "sibling" } }, literaryWorldEnabled: false, literaryEcologyEnabled: false, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false } };
	await writeFile(join(cwd, "liyuan.config.json"), JSON.stringify(stageConfig));
	await writeFile(join(cwd, "liyuan.agent.json"), JSON.stringify(config));
	await mkdir(join(cwd, "liyuan-profiles"));
	await writeFile(join(cwd, "liyuan-profiles/fixture.json"), JSON.stringify({ id: "fixture", name: "合成配置", updatedAt: Date.now(), config: { ...config, providers: { fixture: config.providers.fixture } } }));
	await writeFile(join(cwd, "liyuan-profiles/inherited.json"), JSON.stringify({ id: "inherited", name: "继承关闭配置", updatedAt: Date.now(), config: { version: 1, defaultProvider: "inherited", defaultModel: "inherited-off", providers: { inherited: inheritedProvider } } }));
	await writeFile(join(cwd, "liyuan.agent.meta.json"), JSON.stringify({ activeId: "fixture" }));
	const server = spawn(process.execPath, [join(root, "server/main.ts"), "--new"], { cwd, env: { ...process.env, HOME: join(cwd, "home"), LIYUAN_CODING_AGENT_DIR: join(cwd, "agent"), HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
	let logs = "", browser, page;
	const errors = [], writes = [], forbiddenFrames = [], responses = [];
	for (const stream of [server.stdout, server.stderr]) stream.on("data", data => { logs += data; });
	const api = async path => {
		const res = await fetch(base + path); assert.ok(res.ok, `${path}: ${res.status}`); return res.json();
	};
	const diskConfig = async () => JSON.parse(await readFile(join(cwd, "liyuan.agent.json"), "utf8"));
	const profileConfig = async id => JSON.parse(await readFile(join(cwd, `liyuan-profiles/${id}.json`), "utf8")).config;
	const waitFor = async (check, description) => {
		for (let i = 0; i < 80; i++) { if (await check()) return; await pause(100); }
		assert.fail(`Timed out: ${description}`);
	};
	try {
		let ready = false;
		for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/healthz")).ok) { ready = true; break; } } catch {} if (server.exitCode !== null) break; await pause(250); }
		assert.ok(ready, `Isolated UI host failed: ${logs.slice(-1000)}`);
		// A fresh --new host starts before agent.json sync. Explicitly seed only this
		// synthetic fixture's current model; the UI actions below must never select it.
		await api("/api/models");
		const seeded = await fetch(base + "/api/models/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "fixture", id: "writer" }) });
		assert.ok(seeded.ok, "synthetic model seed failed");
		assert.equal((await seeded.json()).current.id, "writer");
		const healthBefore = await api("/healthz");
		browser = await chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" }); page.setDefaultTimeout(12000);
		page.on("pageerror", error => errors.push(error.message));
		page.on("request", req => { if (req.method() !== "GET") writes.push({ path: new URL(req.url()).pathname, method: req.method() }); });
		page.on("response", async res => { if (res.request().method() !== "GET") responses.push({ path: new URL(res.url()).pathname, status: res.status(), body: await res.text().catch(() => "") }); });
		page.on("websocket", socket => socket.on("framesent", frame => { try { const value = JSON.parse(String(frame.payload)); if (["prompt", "assistant_prompt", "select_model", "new_session", "retry"].includes(value.type)) forbiddenFrames.push(value.type); } catch {} }));
		const openConnection = async () => {
			await page.getByRole("button", { name: "连接", exact: true }).first().waitFor();
			if (!(await page.locator(".conn-panel").isVisible())) await page.getByRole("button", { name: "连接", exact: true }).first().click();
			await page.locator(".conn-panel").waitFor();
		};
		await page.goto(base); await openConnection();
		const live = () => page.getByRole("checkbox", { name: "支持工具调用", exact: true });
		const row = id => page.locator(".conn-model-card").filter({ has: page.locator(".conn-model-id", { hasText: new RegExp(`^${id}$`) }) });
		const rowTools = id => row(id).getByRole("checkbox");
		const activeCard = () => page.locator(".conn-card").filter({ has: page.locator(".conn-wh-name", { hasText: "合成配置" }) });
		const inheritedCard = () => page.locator(".conn-card").filter({ has: page.locator(".conn-wh-name", { hasText: "继承关闭配置" }) });
		await live().waitFor(); assert.equal(await live().isChecked(), true);
		const normalizedBaseline = await diskConfig();
		const initialCatalog = await api("/api/models/catalog");
		if (artifacts) await writeFile(join(artifacts, "initial-catalog.fixture.json"), JSON.stringify(initialCatalog, null, 2));
		assert.equal(initialCatalog.current.id, "writer", "isolated runtime must have a real configured model before testing checkbox");
		// Direct live change is persisted and automatically refreshes config/catalog UI.
		await live().click();
		await waitFor(async () => (await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === false, "live disable persistence");
		await waitFor(async () => (await profileConfig("fixture")).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === false, "active profile sync");
		await waitFor(async () => !(await live().isChecked()) && !(await live().isDisabled()), "live disable UI reload");
		assert.deepEqual(configWithoutToolFlag(await diskConfig()), normalizedBaseline);
		assert.deepEqual(configWithoutToolFlag(await profileConfig("fixture")), normalizedBaseline);
		assert.deepEqual((await api("/api/models/catalog")).current.id, "writer");
		await page.reload(); await openConnection();
		await live().waitFor(); assert.equal(await live().isChecked(), false);
		await live().click();
		await waitFor(async () => (await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === true && !(await live().isDisabled()), "live reenable");
		// Reproduce an older active warehouse copy missing an enabled channel.
		const olderProfile = await profileConfig("fixture");
		delete olderProfile.providers.inherited;
		await writeFile(join(cwd, "liyuan-profiles/fixture.json"), JSON.stringify({ id: "fixture", name: "合成配置", updatedAt: Date.now(), config: olderProfile }));
		// Editing that active profile must retain the actual enabled scope/defaults.
		await activeCard().getByRole("button", { name: "修改", exact: true }).click();
		await rowTools("writer").waitFor();
		assert.equal(await rowTools("sibling").isChecked(), true);
		assert.equal(await rowTools("explicit-off").isChecked(), false);
		await rowTools("writer").uncheck();
		await page.getByRole("button", { name: "保存修改", exact: true }).click();
		await waitFor(async () => (await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === false && (await profileConfig("fixture")).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === false, "edited live profile");
		assert.deepEqual(configWithoutToolFlag(await diskConfig()), normalizedBaseline);
		assert.equal((await api("/api/models/catalog")).current.id, "writer");
		assert.equal((await api("/api/models/catalog")).models.some(m => m.provider === "inherited"), true);
		await waitFor(async () => !(await live().isChecked()) && !(await live().isDisabled()), "editor save refreshes live UI");
		// Failed active-profile PUT must not pretend either target saved.
		await page.route("**/api/agent-profiles", async route => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "合成保存失败" }) });
			else await route.continue();
		});
		await live().click();
		await page.getByText("合成保存失败", { exact: true }).waitFor();
		assert.equal(await live().isChecked(), false);
		assert.equal((await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools, false);
		assert.equal((await profileConfig("fixture")).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools, false);
		await page.unroute("**/api/agent-profiles");
		// Lost response after a real server write: report error, re-read saved state.
		await page.route("**/api/agent-profiles", async route => {
			if (route.request().method() === "PUT") {
				const response = await route.fetch(); assert.ok(response.ok());
				await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "合成保存回执丢失" }) });
			} else await route.continue();
		});
		await live().click();
		await page.getByText("合成保存回执丢失", { exact: true }).waitFor();
		await waitFor(async () => await live().isChecked() && !(await live().isDisabled()), "actual saved state after lost response");
		assert.equal((await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools, true);
		assert.equal((await profileConfig("fixture")).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools, true);
		await page.unroute("**/api/agent-profiles");
		// No active warehouse: the live switch uses agent-config and still handles failure.
		await writeFile(join(cwd, "liyuan.agent.meta.json"), JSON.stringify({ activeId: null }));
		await page.reload(); await openConnection();
		await live().waitFor(); assert.equal(await live().isChecked(), true);
		await page.route("**/api/agent-config", async route => {
			if (route.request().method() === "PUT") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "合成独立配置失败" }) });
			else await route.continue();
		});
		await live().click(); await page.getByText("合成独立配置失败", { exact: true }).waitFor();
		assert.equal(await live().isChecked(), true);
		await page.unroute("**/api/agent-config");
		await live().click();
		await waitFor(async () => (await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === false && !(await live().isDisabled()), "standalone config save");
		assert.equal((await profileConfig("fixture")).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools, true);
		await writeFile(join(cwd, "liyuan.agent.meta.json"), JSON.stringify({ activeId: "fixture" }));
		await page.reload(); await openConnection();
		await live().waitFor(); assert.equal(await live().isChecked(), false);
		// Inactive inherited false remains off, true model override remains on.
		await inheritedCard().getByRole("button", { name: "修改", exact: true }).click();
		await rowTools("inherited-off").waitFor();
		assert.equal(await rowTools("inherited-off").isChecked(), false);
		assert.equal(await rowTools("override-on").isChecked(), true);
		await rowTools("inherited-off").check();
		await page.getByRole("button", { name: "保存修改", exact: true }).click();
		await waitFor(async () => (await profileConfig("inherited")).providers.inherited.models[0].compat?.supportsTools === true, "explicit model override save");
		assert.equal((await profileConfig("inherited")).providers.inherited.compat.supportsTools, false);
		assert.equal((await diskConfig()).defaultProvider, "fixture");
		assert.deepEqual((await diskConfig()).providers.inherited, normalizedBaseline.providers.inherited);
		// Generator defaults checked, stores only in warehouse and never selects a model.
		await page.getByRole("button", { name: "＋ 生成配置", exact: true }).click();
		await page.getByLabel("配置名 / 渠道名", { exact: true }).fill("generated");
		await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:9/v1");
		await page.getByLabel(/^API key/).fill("synthetic-not-a-real-key");
		await page.getByRole("button", { name: "＋", exact: true }).click();
		await page.getByPlaceholder("模型 id", { exact: true }).fill("new-model");
		await page.getByRole("button", { name: "加入", exact: true }).click();
		assert.equal(await rowTools("new-model").isChecked(), true);
		await rowTools("new-model").uncheck();
		await page.getByRole("button", { name: "存入配置仓库", exact: true }).click();
		await waitFor(async () => { try { return (await profileConfig("generated")).providers.generated.models[0].compat.supportsTools === false; } catch { return false; } }, "generated disabled capability");
		assert.equal((await api("/api/models/catalog")).current.id, "writer");
		// Mobile controls remain visible/clickable and reopen from persisted state.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload(); await openConnection();
		await live().waitFor(); assert.equal(await live().isChecked(), false);
		await live().scrollIntoViewIfNeeded();
		const bounds = await live().boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
		await live().click();
		await waitFor(async () => (await diskConfig()).providers.fixture.models.find(m => m.id === "writer").compat.supportsTools === true && !(await live().isDisabled()), "mobile reenable");
		await activeCard().getByRole("button", { name: "修改", exact: true }).click();
		await rowTools("writer").waitFor(); assert.equal(await rowTools("writer").isChecked(), true);
		await rowTools("writer").scrollIntoViewIfNeeded();
		const rowBounds = await rowTools("writer").boundingBox(); assert.ok(rowBounds && rowBounds.x >= 0 && rowBounds.x + rowBounds.width <= 391);
		assert.equal(await page.locator(".conn-panel").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
		if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, "connect-tools-mobile.png"), fullPage: true }); }
		assert.deepEqual(configWithoutToolFlag(await diskConfig()), normalizedBaseline);
		assert.deepEqual(JSON.parse(await readFile(join(cwd, "liyuan.config.json"), "utf8")), stageConfig);
		assert.equal((await api("/healthz")).sessionId, healthBefore.sessionId);
		assert.deepEqual(errors, []); assert.deepEqual(forbiddenFrames, []);
		assert.ok(writes.every(write => ["/api/agent-config", "/api/agent-profiles"].includes(write.path)), JSON.stringify(writes));
		assert.ok(!logs.includes("[side-model]") && !logs.includes("开演失败"), "UI must not perform model inference");
	} catch (error) {
		if (artifacts && page) {
			await mkdir(artifacts, { recursive: true });
			await page.screenshot({ path: join(artifacts, "connect-tools-failure.png"), fullPage: true }).catch(() => {});
			await writeFile(join(artifacts, "connect-diagnostics.fixture.json"), JSON.stringify({ writes, responses, config: await diskConfig().catch(() => null), pageText: await page.locator("body").innerText().catch(() => "") }, null, 2));
		}
		throw error;
	} finally {
		if (browser) await browser.close();
		server.kill("SIGTERM");
		await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5000)]);
		if (artifacts) { await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, "connect-fixture.log"), logs); }
		await rm(cwd, { recursive: true, force: true });
	}
});
