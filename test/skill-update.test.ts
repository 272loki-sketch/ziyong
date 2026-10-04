import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acknowledgeStageSkillBuiltin, deleteStageSkill, saveStageSkill, scanSkillFiles } from "../src/stage/skill-store.ts";

const fixture = (run: (cwd: string) => void) => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-skill-update-"));
	try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
};
const builtin = (cwd: string, version = "1", body = "# 内置\n") => {
	const dir = join(cwd, "skills", "规则");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: 规则\ndescription: 提示规则\nversion: ${version}\nworkflow: ecology-runtime\nresident: false\n每轮: false\n---\n\n${body}`, "utf8");
};
const input = (body = "# 我的内容\n") => ({ dir: "规则", name: "规则", description: "个人规则", resident: false, everyBeat: false, body });
const rawOverride = (cwd: string) => readFileSync(join(cwd, ".liyuan-stage-skills", "规则", "SKILL.md"), "utf8");
const legacyOverride = (cwd: string, raw: string) => {
	mkdirSync(join(cwd, ".liyuan-stage-skills", "规则"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-stage-skills", "规则", "SKILL.md"), raw, "utf8");
};

test("Skill更新：内置current，自定义custom，新覆盖记录当前指纹及版本", () => fixture((cwd) => {
	builtin(cwd);
	const original = scanSkillFiles(cwd)[0];
	assert.equal(original.updateStatus, "current");
	assert.equal(original.builtin?.version, "1");
	saveStageSkill(cwd, input());
	const override = scanSkillFiles(cwd)[0];
	assert.equal(override.source, "user");
	assert.equal(override.updateStatus, "current");
	assert.equal(override.baseBuiltinFingerprint, original.builtin?.fingerprint);
	assert.equal(override.baseBuiltinVersion, "1");
	saveStageSkill(cwd, { ...input(), dir: "自定义", name: "自定义" });
	assert.equal(scanSkillFiles(cwd).find((row) => row.dir === "自定义")?.updateStatus, "custom");
}));

test("Skill更新：内置变化只提示outdated，扫描不写覆盖，普通保存不能消除提示", () => fixture((cwd) => {
	builtin(cwd);
	saveStageSkill(cwd, input());
	const initial = scanSkillFiles(cwd)[0];
	const before = rawOverride(cwd);
	builtin(cwd, "2", "新增安全规则\n");
	const changed = scanSkillFiles(cwd)[0];
	assert.equal(changed.updateStatus, "outdated");
	assert.equal(changed.body, initial.body);
	assert.equal(rawOverride(cwd), before);
	saveStageSkill(cwd, { ...input("编辑后的完整内容\n"), baseBuiltinFingerprint: changed.builtin!.fingerprint, baseBuiltinVersion: "2" });
	const edited = scanSkillFiles(cwd)[0];
	assert.equal(edited.body, "编辑后的完整内容\n");
	assert.equal(edited.updateStatus, "outdated");
	assert.equal(edited.baseBuiltinFingerprint, initial.baseBuiltinFingerprint);
	assert.equal(edited.baseBuiltinVersion, "1");
}));

test("Skill更新：旧覆盖无或无效metadata只显示untracked，保存不自动认领当前基线", () => fixture((cwd) => {
	builtin(cwd);
	for (const metadata of ["", "builtin-base-fingerprint: not-a-sha256\n"]) {
		legacyOverride(cwd, `---\nname: 规则\ndescription: 老覆盖\n${metadata}---\n\n旧内容\n`);
		const old = scanSkillFiles(cwd)[0];
		assert.equal(old.updateStatus, "untracked");
		saveStageSkill(cwd, { ...input(), baseBuiltinFingerprint: old.builtin!.fingerprint });
		assert.equal(scanSkillFiles(cwd)[0].updateStatus, "untracked");
	}
}));

test("Skill更新：显式已核对只改基线行，任意格式正文逐字节保留", () => fixture((cwd) => {
	builtin(cwd, "2");
	const body = "\n\t<xml>  raw\r\n</xml>\r\n---\r\n```json\r\n{}\r\n```\r\n  \t";
	const prefix = "---\r\nname: 规则\r\ndescription: 原说明\r\n# untouched\r\nextra-meta: keep\r\n---\r\n\r\n";
	legacyOverride(cwd, prefix + body);
	const before = rawOverride(cwd);
	const current = scanSkillFiles(cwd)[0];
	assert.equal(current.body, body);
	assert.equal(current.updateStatus, "untracked");
	acknowledgeStageSkillBuiltin(cwd, "规则", current.builtin!.fingerprint);
	const after = rawOverride(cwd);
	assert.ok(after.endsWith(prefix.slice(prefix.indexOf("---\r\n\r\n", 5)) + body));
	assert.equal(after.replace(/builtin-base-(fingerprint|version):[^\r\n]*\r\n/g, ""), before);
	assert.equal(scanSkillFiles(cwd)[0].body, body);
	assert.equal(scanSkillFiles(cwd)[0].updateStatus, "current");
	assert.equal(scanSkillFiles(cwd)[0].baseBuiltinVersion, "2");
}));

test("Skill更新：保存不trim或改写任意格式正文", () => fixture((cwd) => {
	const body = "\n  \t<script>literal only</script>\r\n---\r\n  ";
	saveStageSkill(cwd, input(body));
	assert.equal(scanSkillFiles(cwd)[0].body, body);
	assert.ok(rawOverride(cwd).endsWith(body));
}));

test("Skill更新：UI对照后内置再次变化，旧指纹确认拒绝且不写覆盖", () => fixture((cwd) => {
	builtin(cwd);
	saveStageSkill(cwd, input());
	const observed = scanSkillFiles(cwd)[0].builtin!.fingerprint;
	const before = rawOverride(cwd);
	builtin(cwd, "2");
	assert.throws(() => acknowledgeStageSkillBuiltin(cwd, "规则", observed), /已变化/);
	assert.equal(rawOverride(cwd), before);
	assert.equal(scanSkillFiles(cwd)[0].updateStatus, "outdated");
}));

test("Skill更新：首次覆盖传观察时的旧基线保持outdated；删除覆盖回内置", () => fixture((cwd) => {
	builtin(cwd);
	const observed = scanSkillFiles(cwd)[0].builtin!;
	builtin(cwd, "2");
	saveStageSkill(cwd, { ...input(), baseBuiltinFingerprint: observed.fingerprint, baseBuiltinVersion: observed.version });
	assert.equal(scanSkillFiles(cwd)[0].updateStatus, "outdated");
	deleteStageSkill(cwd, "规则");
	assert.equal(scanSkillFiles(cwd)[0].source, "builtin");
	assert.equal(scanSkillFiles(cwd)[0].updateStatus, "current");
}));

test("Skill更新：确认缺内置/缺覆盖/路径穿越拒绝；损坏覆盖不自动重建基线", () => fixture((cwd) => {
	assert.throws(() => acknowledgeStageSkillBuiltin(cwd, "规则", "a".repeat(64)), /没有内置/);
	assert.throws(() => acknowledgeStageSkillBuiltin(cwd, "../other", "a".repeat(64)), /非法/);
	builtin(cwd);
	const fingerprint = scanSkillFiles(cwd)[0].builtin!.fingerprint;
	assert.throws(() => acknowledgeStageSkillBuiltin(cwd, "规则", fingerprint), /没有可核对/);
	legacyOverride(cwd, "damaged override body");
	assert.throws(() => acknowledgeStageSkillBuiltin(cwd, "规则", fingerprint), /frontmatter/);
	assert.throws(() => saveStageSkill(cwd, input()), /frontmatter/);
	assert.equal(rawOverride(cwd), "damaged override body");
}));
