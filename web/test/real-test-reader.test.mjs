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
const artifacts = process.env.LIYUAN_READER_ARTIFACTS;
const dist = process.env.LIYUAN_READER_DIST || join(root, "web/dist");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const summaries = ["direct", "director"].map((mode, i) => ({
	id: `reader-fixture-${mode}`, title: `阅读布局验证 · ${i ? "导演" : "直出"}`,
	cardName: "只读测试卡", createdAt: "2026-10-06T00:00:00Z", status: i ? "failed" : "partial",
}));
const details = summaries.map(summary => ({
	...summary, readOnly: true, userName: "测试主角", description: "仅验证阅读界面，不调用模型。",
	checks: [{ title: "失败信息未隐藏", status: "failed", detail: "这是测试诊断，可以展开核对。" }],
	notes: ["旧失败记录保持原样。"], states: [{ label: "测试当拍", state: { time: "午休", points: 0 } }],
	messages: [
		{ id: "fixture-input", channel: "user", text: "午休后去图书馆。" },
		{ id: "fixture-story", channel: "narrative", text: Array.from({ length: 28 }, (_, i) => `第${i + 1}段。午后的光落在练习册边缘，他合上书，沿着走廊前往图书馆。窗外传来风吹过树梢的声音，故事继续向前。`).join("\n\n") + `\n\n<${summary.id.endsWith("-director") ? "imageTag" : "image"}>${summary.id}-readonly-preview</${summary.id.endsWith("-director") ? "imageTag" : "image"}>` },
	],
	raw: [
		{ label: "正文 · 原始文本", text: "测试正文。" },
		{ label: "独立格式/状态栏 · 原始文本", text: `<article><h2>测试格式</h2>${"长格式字段".repeat(120)}</article>` },
	],
}));

async function freePort() {
	const server = createServer();
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

test("实战记录全屏、目录按需展开、移动端与只读交互回归（无模型请求）", { timeout: 90_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-reader-fixture-"));
	const port = await freePort();
	const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
	await mkdir(join(cwd, "web"));
	await symlink(dist, join(cwd, "web/dist"), "dir");
	for (const name of ["src", "skills", "node_modules"]) await symlink(join(root, name), join(cwd, name), "dir");
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "reader-fixture", version, type: "module" }));
	await writeFile(join(cwd, "card.json"), JSON.stringify({ data: { name: "隔离阅读测试", first_mes: "不调用模型。" } }));
	await writeFile(join(cwd, "liyuan.config.json"), JSON.stringify({
		card: "card.json", userName: "Fixture", greeting: false, generationMode: "director",
		literaryWorldEnabled: false, literaryEcologyEnabled: false,
		novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false },
	}));
	const server = spawn(process.execPath, [join(root, "server/main.ts"), "--new"], {
		cwd, env: { ...process.env, HOME: join(cwd, "home"), LIYUAN_CODING_AGENT_DIR: join(cwd, "agent"), HOST: "127.0.0.1", PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let logs = "", browser, page;
	const errors = [], writes = [], sentFrames = [];
	for (const stream of [server.stdout, server.stderr]) stream.on("data", data => { logs += data; });
	try {
		let ready = false;
		for (let i = 0; i < 60; i++) {
			try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { ready = true; break; } } catch {}
			if (server.exitCode !== null) break;
			await pause(250);
		}
		assert.ok(ready, `Isolated UI host did not start: ${logs.slice(-1200)}`);
		browser = await chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		page = await context.newPage();
		page.setDefaultTimeout(12_000);
		page.on("pageerror", error => errors.push(error.message));
		page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url()); });
		await page.routeWebSocket("**/ws", ws => {
			const remote = ws.connectToServer();
			ws.onMessage(message => { sentFrames.push(JSON.parse(String(message)).type); remote.send(message); });
			remote.onMessage(message => {
				const frame = JSON.parse(String(message));
				setTimeout(() => { try { ws.send(message); } catch {} }, frame.type === "hello" ? 1600 : 0);
			});
		});
		await page.route(/\/api\/novelai\/cached(?:\?.*)?$/, route => route.fulfill({
			status: route.request().url().includes("director") ? 503 : 200, contentType: "application/json",
			body: JSON.stringify({ src: null }),
		}));
		let directDelay = 0, empty = false, listError = false;
		await page.route(/\/api\/real-tests(?:\/[^?]*)?(?:\?.*)?$/, async route => {
			const id = new URL(route.request().url()).pathname.split("/")[3];
			const detail = details.find(record => record.id === id);
			if (id === summaries[0].id) await pause(directDelay);
			await route.fulfill({
				status: !id && listError ? 503 : 200, contentType: "application/json",
				body: JSON.stringify(id ? detail : listError ? { error: "测试读取失败" } : { records: empty ? [] : summaries }),
			});
		});
		await page.goto(`http://127.0.0.1:${port}`);
		await page.waitForTimeout(2500);
		assert.equal(await page.getByText("当前未连接/尚未对齐会话，此操作未发送，请连接后重试。", { exact: false }).count(), 0);
		const opener = page.getByRole("button", { name: "实战记录", exact: true }).first();
		// A transformed ancestor reproduced the old embedded-dialog restriction.
		await opener.evaluate(button => { button.parentElement.style.transform = "translateZ(0)"; });
		await opener.click();
		await page.getByRole("dialog").waitFor();
		assert.equal(await page.locator("body > .rt-backdrop").count(), 1);
		assert.deepEqual(await page.locator(".rt-dialog").boundingBox(), { x: 0, y: 0, width: 1440, height: 1000 });
		assert.equal(await page.locator("#root").evaluate(element => element.inert), true);
		assert.equal(await page.locator(".rt-view").count(), 0);
		await page.getByRole("button", { name: /阅读布局验证 · 直出/ }).click();
		await page.locator(".rt-messages").waitFor();
		assert.equal(await page.locator(".rt-catalog").count(), 0);
		assert.equal(await page.locator(".nai-generate-btn").count(), 0);
		await page.locator(".nai-readonly-note").waitFor();
		assert.equal(await page.locator(".rt-review").getAttribute("open"), null);
		assert.ok((await page.locator(".rt-content").boundingBox()).width >= 1200);
		assert.ok((await page.locator(".rt-messages > .msg").first().boundingBox()).width >= 1200);
		await page.getByRole("button", { name: "查看原始正文/格式" }).click();
		assert.ok((await page.locator(".rt-raw").innerText()).includes("<article>"));
		await page.getByRole("button", { name: "查看实际渲染" }).click();
		await page.locator(".rt-review > summary").click();
		await page.getByText("这是测试诊断，可以展开核对。", { exact: true }).waitFor();
		await page.locator(".rt-state-check > summary").click();
		assert.ok((await page.locator(".rt-state-check pre").innerText()).includes('"points": 0'));
		await page.getByRole("button", { name: "选择记录", exact: true }).click();
		assert.equal(await page.locator(".rt-view").evaluate(element => element.inert), true);
		assert.ok((await page.locator(".rt-content").boundingBox()).width >= 1200);
		await page.getByRole("button", { name: /阅读布局验证 · 导演/ }).click();
		await page.getByRole("heading", { name: summaries[1].title, exact: true }).waitFor();
		assert.equal(await page.locator(".rt-catalog").count(), 0);
		assert.equal(await page.locator(".rt-review").getAttribute("open"), null);
		await page.getByRole("button", { name: "返回梨园", exact: true }).focus();
		await page.keyboard.press("Shift+Tab");
		assert.equal(await page.evaluate(() => !!document.activeElement.closest(".rt-dialog")), true);
		await page.keyboard.press("Escape");
		assert.equal(await page.locator(".rt-dialog").count(), 0);
		assert.equal(await page.locator("#root").evaluate(element => element.inert), false);
		assert.equal(await opener.evaluate(button => button === document.activeElement), true);
		// Latest selection wins; a closed reader ignores late responses.
		directDelay = 400;
		await opener.click();
		await page.getByRole("button", { name: /阅读布局验证 · 直出/ }).click();
		await page.getByRole("button", { name: /阅读布局验证 · 导演/ }).click();
		await page.getByRole("heading", { name: summaries[1].title, exact: true }).waitFor();
		await pause(500);
		assert.equal(await page.locator(".rt-reader-heading h1").innerText(), summaries[1].title);
		await page.getByRole("button", { name: "返回梨园", exact: true }).click();
		await opener.click();
		await page.getByRole("button", { name: /阅读布局验证 · 直出/ }).click();
		await page.keyboard.press("Escape");
		await pause(500);
		assert.equal(await page.locator(".rt-dialog").count(), 0);
		directDelay = 0;
		await page.setViewportSize({ width: 390, height: 844 });
		await opener.click();
		await page.getByRole("button", { name: /阅读布局验证 · 直出/ }).click();
		await page.locator(".rt-messages").waitFor();
		assert.deepEqual(await page.locator(".rt-dialog").boundingBox(), { x: 0, y: 0, width: 390, height: 844 });
		assert.equal(await page.locator(".rt-catalog").count(), 0);
		assert.ok((await page.locator(".rt-content").boundingBox()).width >= 340);
		assert.ok(await page.locator(".rt-view").evaluate(element => element.scrollWidth <= element.clientWidth));
		if (artifacts) { await mkdir(artifacts, { recursive: true, mode: 0o700 }); await page.screenshot({ path: join(artifacts, "reader-mobile-fixture.png") }); }
		await page.getByRole("button", { name: "查看原始正文/格式" }).click();
		assert.ok(await page.locator(".rt-view").evaluate(element => element.scrollWidth <= element.clientWidth));
		await page.getByRole("button", { name: "选择记录", exact: true }).click();
		await page.getByRole("button", { name: "收起目录", exact: true }).click();
		assert.equal(await page.locator(".rt-catalog").count(), 0);
		await page.getByRole("button", { name: "返回梨园", exact: true }).click();
		empty = true;
		await opener.click();
		await page.getByText("暂无已发布实战记录。", { exact: true }).waitFor();
		listError = true;
		await page.getByRole("button", { name: "刷新记录", exact: true }).click();
		await page.getByRole("alert").getByText("Error: 测试读取失败", { exact: true }).waitFor();
		empty = false; listError = false;
		await page.getByRole("button", { name: "刷新记录", exact: true }).click();
		await page.getByRole("button", { name: /阅读布局验证 · 导演/ }).waitFor();
		await page.getByRole("button", { name: "返回梨园", exact: true }).click();
		assert.deepEqual(errors, []);
		assert.deepEqual(writes, []);
		assert.equal(sentFrames.some(type => /prompt|send|reroll|switch_session/i.test(type)), false);
	} catch (error) {
		console.error("Reader browser errors:", errors);
		if (artifacts && page) {
			await mkdir(artifacts, { recursive: true, mode: 0o700 });
			await page.screenshot({ path: join(artifacts, "reader-failure.png") });
			await writeFile(join(artifacts, "reader-failure.html"), await page.content());
		}
		throw error;
	} finally {
		await browser?.close();
		const stopped = new Promise(resolve => server.once("exit", resolve));
		if (server.exitCode === null && server.signalCode === null) { server.kill("SIGTERM"); await Promise.race([stopped, pause(5000)]); }
		if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await stopped; }
		await rm(cwd, { recursive: true, force: true });
	}
});
