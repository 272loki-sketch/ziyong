import assert from "node:assert/strict";
import test from "node:test";

import { defaultLiteraryWorldState } from "../src/stage/literary-world.ts";
import { migrateLiteraryWorldV1, modularWorldFromBranch, modularWorldWireView, projectLiteraryWorldV1 } from "../src/stage/literary-world-modular.ts";

test("modular world：v1 内存迁移后兼容投影保留事件、势力、风声与黑盒", () => {
	const v1 = { ...defaultLiteraryWorldState(), round: 4, digest: "旧世界", events: [{ id: "e1", name: "调查", type: "progress" as const, level: 2, stage: "执行", description: "正在查访" }], factions: [{ id: "f1", name: "学生会", scope: "学校", status: "运作中", relation: "中立", goal: "维持秩序" }], winds: [{ id: "w1", topic: "传闻", type: "rumor" as const, level: 2, content: "有人调查", scope: "校园", source: "同学" }], blackbox: { secretActions: [{ action: "秘密会面", witnesses: "无", trace: "门锁划痕" }], secretAssets: [] } };
	const v2 = migrateLiteraryWorldV1(v1), projected = projectLiteraryWorldV1(v2);
	assert.equal(projected.events[0]?.id, "e1");
	assert.equal(projected.factions[0]?.name, "学生会");
	assert.equal(projected.winds[0]?.content, "有人调查");
	assert.equal(projected.blackbox.secretActions[0]?.action, "秘密会面");
	assert.equal(projected.round, 4);
});

test("modular world：混合 v1/v2 分支读取最近权威且 wire 不泄 secret 正文", () => {
	const v1 = { ...defaultLiteraryWorldState(), round: 1, digest: "旧" };
	const v2 = migrateLiteraryWorldV1(v1);
	v2.round = 2; v2.modules.secret = { id: "secret", kind: "custom", revision: 1, summary: "存在秘密", records: [{ id: "s1", facet: "custom", label: "不能显示", status: "隐藏", summary: "秘密正文", visibility: "secret", attributes: {}, originRefs: [], updatedRound: 2 }] };
	const state = modularWorldFromBranch([{ type: "custom", customType: "rp-world-state", data: v1 }, { type: "custom", customType: "rp-world-state", data: v2 }]);
	const view = modularWorldWireView(state);
	assert.equal(state.round, 2);
	assert.equal(view.modules.find((module) => module.id === "secret")?.secretCount, 1);
	assert.equal(JSON.stringify(view).includes("秘密正文"), false);
});
