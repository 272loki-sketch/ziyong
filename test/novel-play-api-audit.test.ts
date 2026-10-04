import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NOVEL_PLAY_LIMITS } from "../server/novel-play-api.ts";
import { apply } from "../scripts/novel-integration/server-patch.mjs";

const api = readFileSync(new URL("../server/novel-play-api.ts", import.meta.url), "utf8");
const application = readFileSync(new URL("../src/novel-play/application.ts", import.meta.url), "utf8");
const rest = readFileSync(new URL("../server/rest.ts", import.meta.url), "utf8");

test("audit 1: start consumes a preview token and reserves the global start lock before awaiting work", () => {
	const bodyRead = api.indexOf("const input = await body(req);", api.indexOf('POST /api/novel-play/start'));
	const consume = api.indexOf("preview.used = true; instance.starting = true;", bodyRead);
	const start = api.indexOf("startFromConfirmedProposal", consume);
	assert.ok(bodyRead >= 0 && consume > bodyRead && start > consume);
	assert.match(api, /if \(instance\.starting\).*statusCode: 409/);
});

test("audit 2: jobs and previews bind to runtime session and active config card", () => {
	assert.match(api, /interface Job \{[^}]*binding: NovelPlayBinding/);
	assert.match(api, /interface Preview \{[^}]*binding: NovelPlayBinding/);
	assert.match(api, /sameNovelPlayBinding\(job\.binding, current\)/);
	assert.match(api, /bindingChecked\(host as NovelPlayModelHost, binding\)/);
	assert.match(application, /const scope = host\.memoryScope\(\)/);
	assert.match(application, /const sessionId = scope\.sessionId/);
	assert.match(application, /runtimeCard !== configCard/);
});

test("audit 3: cancellation is terminal and workers cannot publish after cancellation", () => {
	assert.match(api, /const terminal = .*"cancelled"/);
	assert.match(api, /if \(terminal\(job\.state\)\).*return/);
	assert.match(api, /job\.state = "cancelled";[\s\S]*delete job\.result;[\s\S]*controller\.abort/);
});

test("audit 4: build and preview have deadlines, disconnect abort, and slots follow underlying settlement", () => {
	assert.equal(NOVEL_PLAY_LIMITS.buildDeadlineMs, 4 * 60 * 60_000);
	assert.equal(NOVEL_PLAY_LIMITS.modelCallDeadlineMs, 120_000);
	assert.equal(NOVEL_PLAY_LIMITS.startSwitchDeadlineMs, 30_000);
	assert.equal(NOVEL_PLAY_LIMITS.previewDeadlineMs, 5 * 60_000);
	assert.match(api, /req\.once\("aborted", abort\)/);
	assert.match(api, /responseEvents\.once\?\.\("close", close\)/);
	assert.match(api, /void operation\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ instance\.buildOperations--/);
	assert.match(api, /void operation\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ instance\.previewOperations--/);
});

test("audit 5: switch uncertainty preserves generated state and requires recovery", () => {
	const switchCall = application.indexOf("await host.switchToCard()");
	assert.ok(switchCall >= 0);
	assert.doesNotMatch(application.slice(switchCall), /restoreOwnedPreSwitch/);
	assert.match(application.slice(switchCall), /session: "recovery-required"/);
	assert.match(rest, /novel-play-api: config mutation guard/);
	assert.match(rest, /route === "PUT \/api\/config" \|\| route === "POST \/api\/card\/switch"/);
	assert.match(rest, /isNovelPlayStartLocked\(host\)/);
});

test("audit 6: preview concurrency and per-session rate limits are explicit", () => {
	assert.equal(NOVEL_PLAY_LIMITS.maxPreviewOperations, 2);
	assert.equal(NOVEL_PLAY_LIMITS.previewRequestsPerMinute, 6);
	assert.match(api, /instance\.previewOperations >= NOVEL_PLAY_LIMITS\.maxPreviewOperations/);
	assert.match(api, /recent\.length >= NOVEL_PLAY_LIMITS\.previewRequestsPerMinute/);
	assert.match(api, /statusCode: 429/);
});

test("audit 7: public start options expose safe public context without internal canon fields", () => {
	assert.match(application, /title: node\.title/);
	assert.match(application, /summary: node\.summary/);
	assert.match(application, /stageTitle:/);
	assert.doesNotMatch(application, /visibility: node\.visibility/);
	assert.doesNotMatch(application, /sourceRefs: node\.sourceRefs/);
	assert.doesNotMatch(application, /dependsOn: node\.dependsOn/);
});

test("audit 8: active-card inspection resolves real paths, contains them under cards, and uses raw card parsing", () => {
	assert.match(application, /realpathSync\(join\(host\.cwd, "assets", "cards"\)\)/);
	assert.match(application, /realpathSync\(resolve\(host\.cwd, card\)\)/);
	assert.match(application, /rel\.startsWith\("\.\."\) \|\| rel\.startsWith\(sep\)/);
	assert.match(application, /readCardRawJson\(candidate\)/);
});

test("deterministic REST integration patch is idempotent", () => {
	assert.equal(apply(rest), rest);
});
