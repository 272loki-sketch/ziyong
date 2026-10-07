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
const dist = process.env.LIYUAN_LORE_DIST || join(root, "web/dist");
const artifacts = process.env.LIYUAN_LORE_ARTIFACTS;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = "合成关闭项全文前缀。".repeat(50) + "尾部可检索唯一标记";
const entry = (id, comment, text, enabled) => ({ id, comment, content: text, keys: [comment], enabled, constant: false, insertion_order: 100, extensions: { fixture: "keep" } });
const card = (name, entries) => ({ spec: "chara_card_v2", data: { name, first_mes: "离线界面验证，不调用模型。", description: "合成卡保护字段", extensions: { unknown: "keep" }, character_book: { name: "合成内嵌书", entries } } });
async function freePort() {
	const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}

test("embedded lore UI: desktop/mobile, full-text filtering, scoped writes, legacy-off isolation and stale card requests", { timeout: 120_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "liyuan-embedded-lore-ui-"));
	const port = await freePort(), base = `http://127.0.0.1:${port}`;
	await mkdir(join(cwd, "web")); await symlink(dist, join(cwd, "web/dist"), "dir");
	for (const name of ["src", "skills", "node_modules"]) await symlink(join(root, name), join(cwd, name), "dir");
	// 真实 /rprefresh 命令必须注册；否则普通 prompt 路径会尝试找模型。
	await mkdir(join(cwd, ".liyuan")); await symlink(join(root, ".liyuan/extensions"), join(cwd, ".liyuan/extensions"), "dir");
	const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "embedded-lore-ui-fixture", version, type: "module" }));
	const { loreFingerprint } = await import(join(root, "src/lorebook.ts"));
	const a = card("合成卡 A", [entry(1, "卡内已启用", "合成常规资料", true), entry(2, "卡内默认关闭", content, false), entry(3, "其他关闭模块", "不可擅自开启的合成模块", false)]);
	const b = card("合成卡 B", [entry(1, "B 默认关闭", content, false)]);
	await writeFile(join(cwd, "a.json"), JSON.stringify(a)); await writeFile(join(cwd, "b.json"), JSON.stringify(b));
	await writeFile(join(cwd, "empty.json"), JSON.stringify(card("合成空卡", [])));
	await mkdir(join(cwd, "assets/lorebooks"), { recursive: true });
	const bookPath = join(cwd, "assets/lorebooks/independent.json");
	await writeFile(bookPath, JSON.stringify({ name: "同正文独立书", entries: [entry(22, "独立书同正文", content, true)], extensions: { unknown: "keep" } }));
	const bookBefore = await readFile(bookPath);
	await writeFile(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "a.json", userName: "Fixture", greeting: false, generationMode: "direct", lorebooks: ["assets/lorebooks/independent.json"], disabledLore: [loreFingerprint(content)], literaryWorldEnabled: false, literaryEcologyEnabled: false, novelDigest: { enabled: false }, researchSearchSchedule: { enabled: false } }));
	const server = spawn(process.execPath, [join(root, "server/main.ts"), "--new"], { cwd, env: { ...process.env, HOME: join(cwd, "home"), LIYUAN_CODING_AGENT_DIR: join(cwd, "agent"), HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
	let logs = "", browser, page, releasePut;
	const errors = [], writes = [], forbiddenFrames = [];
	for (const stream of [server.stdout, server.stderr]) stream.on("data", data => { logs += data; });
	const api = async (path, method = "GET", payload) => {
		const result = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
		assert.ok(result.ok, `fixture ${method} ${path}: ${result.status}`); return result.json();
	};
	try {
		let ready = false;
		for (let i = 0; i < 60; i++) { try { if ((await fetch(base + "/healthz")).ok) { ready = true; break; } } catch {} if (server.exitCode !== null) break; await pause(250); }
		assert.ok(ready, `Isolated UI host did not start: ${logs.slice(-1000)}`);
		browser = await chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
		page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" }); page.setDefaultTimeout(15_000);
		page.on("pageerror", error => errors.push(error.message));
		await page.routeWebSocket("**/ws", ws => { const remote = ws.connectToServer(); ws.onMessage(message => { const frame = JSON.parse(String(message)); if (/prompt|reroll|generate/i.test(frame.type)) { forbiddenFrames.push(frame.type); return; } remote.send(message); }); remote.onMessage(message => ws.send(message)); });
		await page.route("**/api/**", async route => {
			const request = route.request(), path = new URL(request.url()).pathname;
			if (!["GET", "HEAD"].includes(request.method())) {
				assert.ok(path.startsWith("/api/lorebook"), `unexpected UI mutation: ${path}`);
				writes.push({ method: request.method(), path, body: request.postDataJSON() });
			}
			await route.continue();
		});
		await page.goto(base); await page.getByRole("button", { name: "世界书", exact: true }).first().click();
		const pickCard = page.locator(".book-embedded .book-pick");
		await pickCard.filter({ hasText: "合成卡 A" }).waitFor();
		await page.waitForFunction(() => document.querySelectorAll(".lore-item").length === 3);
		assert.match(await page.locator(".book-embedded").innerText(), /自动随卡加载/);
		const row = title => page.locator(".lore-item").filter({ hasText: title });
		assert.equal(await row("卡内默认关闭").locator(".toggle").getAttribute("aria-pressed"), "false");
		assert.equal(await row("其他关闭模块").locator(".toggle").getAttribute("aria-pressed"), "false");
		const search = page.getByPlaceholder("过滤当前书条目 / 回车测会话检索…");
		await search.fill("尾部可检索唯一标记"); await page.waitForFunction(() => document.querySelectorAll(".lore-item").length === 1);
		await row("卡内默认关闭").locator("summary").click();
		assert.equal(await row("卡内默认关闭").locator(".longtext").innerText(), content);
		await row("卡内默认关闭").locator(".toggle").click();
		await page.waitForFunction(() => document.querySelector(".lore-item .toggle")?.getAttribute("aria-pressed") === "true");
		assert.equal(await search.inputValue(), "尾部可检索唯一标记", "successful card revision should preserve the current filter");
		assert.deepEqual(await readFile(bookPath), bookBefore, "enabling card lore must not edit the independent book");
		const fileView = await api("/api/lorebook?source=file&path=assets%2Florebooks%2Findependent.json"); assert.equal(fileView.entries[0].enabled, false);
		await search.fill(""); await page.waitForFunction(() => document.querySelectorAll(".lore-item").length === 3);
		assert.equal(await row("其他关闭模块").locator(".toggle").getAttribute("aria-pressed"), "false");
		await row("卡内默认关闭").locator("summary").click(); await row("卡内默认关闭").getByRole("button", { name: "编辑", exact: true }).click();
		const changed = content + "\n合成编辑追加";
		await row("卡内默认关闭").locator("textarea").fill(changed); await row("卡内默认关闭").getByRole("button", { name: "保存", exact: true }).click();
		await page.waitForFunction(() => !document.querySelector(".lore-edit"));
		const current = JSON.parse(await readFile(join(cwd, "a.json"), "utf8")); assert.equal(current.data.character_book.entries[1].content, changed); assert.deepEqual(current.data.extensions, a.data.extensions);
		await search.fill("其他关闭模块"); await page.getByRole("button", { name: "启用筛选项", exact: true }).click(); await page.getByRole("button", { name: "确认启用筛选项", exact: true }).click();
		await page.waitForFunction(() => document.querySelector(".lore-item .toggle")?.getAttribute("aria-pressed") === "true");
		await page.getByRole("button", { name: "停用筛选项", exact: true }).click(); await page.getByRole("button", { name: "确认停用筛选项", exact: true }).click();
		await page.waitForFunction(() => document.querySelector(".lore-item .toggle")?.getAttribute("aria-pressed") === "false");
		await search.fill(""); await page.waitForFunction(() => document.querySelectorAll(".lore-item").length === 3);
		for (const toast of await page.locator(".toast").all()) await toast.click({ timeout: 500 }).catch(() => {});
		if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, "lore-desktop-fixture.png") }); }
		// Delay the old editor's request until another card has become current.
		let putCaptured = false;
		await page.route("**/api/lorebook/entry", async route => {
			if (route.request().method() !== "PUT") return route.fallback();
			putCaptured = true; await new Promise(resolve => { releasePut = resolve; }); await route.fallback();
		});
		await row("卡内默认关闭").locator("summary").click(); await row("卡内默认关闭").getByRole("button", { name: "编辑", exact: true }).click();
		await row("卡内默认关闭").locator("textarea").fill("迟到请求不可写入 B"); await row("卡内默认关闭").getByRole("button", { name: "保存", exact: true }).click();
		for (let i = 0; i < 60 && !putCaptured; i++) await pause(50); assert.ok(putCaptured);
		const beforeB = await readFile(join(cwd, "b.json")); await api("/api/card/switch", "POST", { card: "b.json" });
		await pickCard.filter({ hasText: "合成卡 B" }).waitFor(); await row("B 默认关闭").waitFor();
		releasePut(); releasePut = null; await pause(300);
		assert.deepEqual(await readFile(join(cwd, "b.json")), beforeB, "a delayed old-card edit must not alter the new card");
		assert.equal(await row("B 默认关闭").locator(".toggle").getAttribute("aria-pressed"), "false");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator(".book-embedded:visible").waitFor();
		const panel = page.locator(".panel-body:visible").filter({ hasText: "当前角色卡内嵌世界书" }).first();
		assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "mobile lore panel should not overflow horizontally");
		for (const toast of await page.locator(".toast").all()) await toast.click({ timeout: 500 }).catch(() => {});
		await panel.evaluate(element => { element.scrollTop = 0; });
		if (artifacts) await page.screenshot({ path: join(artifacts, "lore-mobile-fixture.png") });
		await api("/api/card/switch", "POST", { card: "empty.json" }); await pickCard.filter({ hasText: "合成空卡" }).waitFor();
		await page.getByText("此书无匹配条目。", { exact: true }).waitFor(); assert.equal(await page.locator(".lore-item").count(), 0);
		assert.ok(writes.length >= 5); assert.ok(writes.every(write => write.body.source === "card" && typeof write.body.cardIdentity === "string"));
		assert.deepEqual(errors, []); assert.deepEqual(forbiddenFrames, []);
		console.log(JSON.stringify({ version, desktop: true, mobile: true, staleRequestRejected: true, scopedWrites: writes.length, paidModelCalls: 0 }));
	} catch (error) {
		if (artifacts && page) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, "lore-failure-fixture.png") }).catch(() => {}); await writeFile(join(artifacts, "lore-failure-fixture.html"), await page.content().catch(() => "")); }
		throw error;
	} finally {
		if (releasePut) releasePut(); await browser?.close(); server.kill("SIGTERM");
		await Promise.race([new Promise(resolve => server.once("exit", resolve)), pause(5000)]);
		if (artifacts) await writeFile(join(artifacts, "lore-ui-host-fixture.log"), logs);
		await rm(cwd, { recursive: true, force: true });
	}
});
