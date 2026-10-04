import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	WORLD_MANIFEST_ENTRY_TYPE,
	defaultCardWorldProfile,
	loadCardWorldProfile,
	manifestFromProfile,
	normalizeCardWorldProfile,
	profileNeedsAnalysis,
	saveCardWorldProfile,
	worldManifestFromBranch,
	worldProfilePath,
} from "../src/stage/literary-world-profile.ts";

const mkcwd = () => mkdtempSync(join(tmpdir(), "liyuan-world-profile-"));

test("world profile：按角色卡独立持久化，稳定画像不因素材变化自动重建", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/school.png", "校园卡", "source-a");
		const profile = normalizeCardWorldProfile({
			status: "stable",
			digest: "校园制度与双人关系并行",
			primaryScale: "institutional",
			defaultTimeStep: "hour",
			worldActivity: "low",
			modules: [{ id: "institution-calendar", name: "校园制度", mode: "active", cadence: "on-time-advance", confidence: 0.95, reason: "世界书含校历" }],
			userRequirements: ["不引入战争模块"],
		}, base);
		assert.ok(profile);
		saveCardWorldProfile(cwd, "cards/school.png", profile);
		assert.equal(existsSync(worldProfilePath(cwd, "cards/school.png")), true);
		const loaded = loadCardWorldProfile(cwd, "cards/school.png", "校园卡", "source-b");
		assert.equal(loaded?.digest, "校园制度与双人关系并行");
		assert.deepEqual(loaded?.userRequirements, ["不引入战争模块"]);
		assert.equal(profileNeedsAnalysis(loaded, "source-b", 100), false, "稳定画像只在用户主动要求时继续优化");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：草稿画像在角色卡素材变化后要求重新分析", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/xianxia.json", "修仙卡", "old");
		const profile = normalizeCardWorldProfile({ digest: "修仙适配", modules: [] }, base);
		assert.ok(profile);
		assert.equal(profileNeedsAnalysis(profile, "old", 7), false);
		assert.equal(profileNeedsAnalysis(profile, "old", 8), true, "未稳定画像每 8 拍结合实弹继续优化");
		assert.equal(profileNeedsAnalysis(profile, "new"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：Manifest 随分支取最近版本，停用模块不进入运行清单", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/hybrid.png", "混合卡", "x");
		const profile = normalizeCardWorldProfile({
			digest: "校园修仙混合",
			modules: [
				{ id: "institution-calendar", name: "校园制度", mode: "active", cadence: "on-time-advance", confidence: 1 },
				{ id: "cultivation-system", name: "修炼体系", mode: "observe", cadence: "on-trigger", confidence: 0.6 },
			],
			disabledModules: ["cultivation-system"],
		}, base);
		assert.ok(profile);
		const manifest = manifestFromProfile(profile);
		assert.deepEqual(manifest.modules.map((item) => item.id), ["institution-calendar"]);
		const branch = [
			{ type: "custom", customType: WORLD_MANIFEST_ENTRY_TYPE, data: { ...manifest, profileRevision: 1 } },
			{ type: "custom", customType: WORLD_MANIFEST_ENTRY_TYPE, data: manifest },
		];
		assert.equal(worldManifestFromBranch(branch, profile.cardKey)?.profileRevision, profile.revision);
		assert.equal(worldManifestFromBranch(branch, "other"), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：用户长期要求和实弹优化记录在重分析时可由旧画像继承", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/intimate.png", "单角色卡", "a");
		const old = normalizeCardWorldProfile({
			digest: "二人戏",
			userRequirements: ["不引入第三者"],
			optimizationNotes: ["外部事件过多会破坏节奏"],
		}, base);
		assert.ok(old);
		const next = normalizeCardWorldProfile({ digest: "继续优化", modules: [] }, old, { preserveStatus: true, sourceFingerprint: "b" });
		assert.ok(next);
		assert.deepEqual(next.userRequirements, ["不引入第三者"]);
		assert.deepEqual(next.optimizationNotes, ["外部事件过多会破坏节奏"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：模型不能删除用户已经钉死的长期要求", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/user-policy.png", "用户规则卡", "a");
		const old = normalizeCardWorldProfile({ digest: "初始", userRequirements: ["不替用户接受任务", "不引入第三者"] }, base)!;
		const next = normalizeCardWorldProfile({ digest: "模型试图只保留一条", userRequirements: ["不引入第三者"] }, old)!;
		assert.deepEqual(next.userRequirements, ["不替用户接受任务", "不引入第三者"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：不存在的模块 Skill 包确定性回落到 kind 包", () => {
	const base = defaultCardWorldProfile("/tmp", "card.json", "卡", "x");
	const profile = normalizeCardWorldProfile({ digest: "校园", modules: [{ id: "economy-market", name: "经济", mode: "active", cadence: "on-trigger", kind: "rules", skillPack: "economy" }] }, base)!;
	assert.equal(profile.modules[0]?.skillPack, "rules");
});
