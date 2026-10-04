import assert from "node:assert/strict";
import test from "node:test";

import { defaultLiteraryEcologyState, normalizeLiteraryEcologyState } from "../src/stage/literary-ecology.ts";
import { defaultModularWorldState } from "../src/stage/literary-world-modular.ts";
import { ecologySignalsForWorld, worldSignalsForEcology } from "../src/stage/literary-world-signals.ts";

test("世界到生态信号携带已提交日历约束且过滤秘密", () => {
	const world = defaultModularWorldState();
	world.modules["institution-calendar"] = { id: "institution-calendar", kind: "institution", revision: 1, summary: "校历", records: [
		{ id: "open", facet: "event", label: "开放日", status: "已公布", summary: "礼堂开放", visibility: "public", attributes: { date: "2015-04-08", time: "09:00", location: "礼堂" }, originRefs: [], updatedRound: 1 },
		{ id: "secret", facet: "event", label: "秘密会议", status: "筹备中", summary: "校方密谈", visibility: "secret", attributes: { date: "2015-04-09" }, originRefs: [], updatedRound: 1 },
	] };
	const signals = worldSignalsForEcology(world);
	assert.equal(signals.length, 1);
	assert.match(signals[0]?.summary ?? "", /2015-04-08.*09:00.*礼堂/);
	assert.doesNotMatch(JSON.stringify(signals), /秘密会议|2015-04-09/);
});

test("生态到世界信号只暴露秘密事件的公开痕迹", () => {
	const ecology = normalizeLiteraryEcologyState({ occurrences: [{
		id: "warehouse", name: "仓库异动", status: "active", patternKey: "warehouse", visibility: "secret", location: "旧仓库",
		development: "组织正在秘密转移物资", publicSurface: { publicity: "trace", trace: "夜间灯光和车辙异常", summary: "不应出现的幕后原因" },
	}] }, { ...defaultLiteraryEcologyState(), round: 2 })!;
	const signals = ecologySignalsForWorld(ecology);
	assert.equal(signals[0]?.kind, "public-trace");
	assert.match(signals[0]?.summary ?? "", /夜间灯光和车辙异常/);
	assert.doesNotMatch(signals[0]?.summary ?? "", /秘密转移物资|幕后原因/);
});

test("没有公开传播面的秘密生态事件不进入世界信号", () => {
	const ecology = normalizeLiteraryEcologyState({ occurrences: [{ id: "secret", name: "秘密转移", status: "active", patternKey: "secret", visibility: "secret", development: "幕后主使和藏匿地点" }] }, defaultLiteraryEcologyState())!;
	assert.deepEqual(ecologySignalsForWorld(ecology), []);
});
