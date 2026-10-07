import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkflowSkillStage = "continuity" | "character" | "persona" | "director" | "writer" | "curtain" | "world" | "world-profile" | "world-facts" | "world-audit" | "ecology-global" | "ecology-card" | "ecology-runtime" | "outline-chat" | "outline-bootstrap" | "outline-reconcile" | "outline-foreshadowing" | "outline-audit" | "outline-research" | "outline-corpus-research" | "novel-digest" | "memory" | "director-evidence" | "director-setting" | "director-ecology" | "director-ideas" | "director-review-facts" | "director-review-style" | "director-main" | "writer-direct" | "structured-repair" | "writer-recovery" | "agent-presentation" | "tool-protocol-repair" | "author-boundary" | "presentation-plan";

export type SkillUpdateStatus = "current" | "outdated" | "untracked" | "custom";

export interface SkillBuiltinReference {
	fingerprint: string;
	version?: string;
	name: string;
	description: string;
	workflow?: WorkflowSkillStage;
	resident: boolean;
	everyBeat: boolean;
	body: string;
	worldModule?: string;
}

export interface SkillFile {
	dir: string;
	name: string;
	description: string;
	workflow?: WorkflowSkillStage;
	resident: boolean;
	everyBeat: boolean;
	body: string;
	source: "builtin" | "user";
	worldModule?: string;
	updateStatus: SkillUpdateStatus;
	baseBuiltinFingerprint?: string;
	baseBuiltinVersion?: string;
	builtin?: SkillBuiltinReference;
}

export interface StageSkillInput {
	dir?: string;
	name: string;
	description: string;
	workflow?: WorkflowSkillStage;
	resident: boolean;
	everyBeat: boolean;
	body: string;
	worldModule?: string;
	/** Used only when first creating an override; ordinary saves never advance its baseline. */
	baseBuiltinFingerprint?: string;
	baseBuiltinVersion?: string;
}

const USER_SKILLS_DIR = ".liyuan-stage-skills";
const WORKFLOW_STAGES = new Set<WorkflowSkillStage>(["continuity", "character", "persona", "director", "writer", "curtain", "world", "world-profile", "world-facts", "world-audit", "ecology-global", "ecology-card", "ecology-runtime", "outline-chat", "outline-bootstrap", "outline-reconcile", "outline-foreshadowing", "outline-audit", "outline-research", "outline-corpus-research", "novel-digest", "memory", "director-evidence", "director-setting", "director-ecology", "director-ideas", "director-review-facts", "director-review-style", "director-main", "writer-direct", "structured-repair", "writer-recovery", "agent-presentation", "tool-protocol-repair", "author-boundary", "presentation-plan"]);
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export function sanitizeSkillDir(name: string): string | null {
	const dir = oneLine(name);
	if (!dir || dir.includes("/") || dir.includes("\\") || dir.includes("..") || dir.startsWith(".")) return null;
	if (/[<>:"|?*]/.test(dir)) return null;
	return dir;
}

const BASE_FINGERPRINT_KEY = "builtin-base-fingerprint";
const BASE_VERSION_KEY = "builtin-base-version";
const fingerprintOf = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");
const validFingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** The single blank line after frontmatter is a container separator, not part of the body. */
function parseSkillRaw(raw: string): { meta: Map<string, string>; body: string; lines: string[]; end: number } | null {
	const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	if (lines[0]?.trim() !== "---") return null;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return null;
	const meta = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const colon = line.indexOf(":");
		if (colon > 0) meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const offset = lines.slice(0, end + 1).reduce((sum, line) => sum + line.length, 0);
	const tail = raw.slice(offset);
	const separator = tail.startsWith("\r\n") ? 2 : tail.startsWith("\n") ? 1 : 0;
	return { meta, body: tail.slice(separator), lines, end };
}

type ScannedSkill = Omit<SkillFile, "updateStatus" | "builtin"> & { fingerprint: string; version?: string };

function scanRoot(root: string, source: SkillFile["source"]): ScannedSkill[] {
	if (!existsSync(root)) return [];
	const out: ScannedSkill[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const file = join(root, entry.name, "SKILL.md");
		if (!existsSync(file)) continue;
		try {
			const raw = readFileSync(file, "utf8");
			const parsed = parseSkillRaw(raw);
			if (!parsed) continue;
			const { meta, body } = parsed;
			const name = meta.get("name") ?? "";
			const description = meta.get("description") ?? "";
			if (!name || !description) continue;
			const rawWorkflow = meta.get("workflow") as WorkflowSkillStage | undefined;
			const baseFingerprint = meta.get(BASE_FINGERPRINT_KEY);
			out.push({
				dir: entry.name, name, description,
				...(rawWorkflow && WORKFLOW_STAGES.has(rawWorkflow) ? { workflow: rawWorkflow } : {}),
				resident: meta.get("resident") === "true", everyBeat: meta.get("每轮") === "true",
				body, source, fingerprint: fingerprintOf(raw),
				...(meta.get("version") ? { version: meta.get("version") } : {}),
				...(meta.get("world-module") ? { worldModule: meta.get("world-module") } : {}),
				...(validFingerprint(baseFingerprint) ? { baseBuiltinFingerprint: baseFingerprint } : {}),
				...(meta.get(BASE_VERSION_KEY) ? { baseBuiltinVersion: meta.get(BASE_VERSION_KEY) } : {}),
			});
		} catch {
			// A damaged skill must not hide the remaining library.
		}
	}
	return out;
}

function builtinReference(skill: ScannedSkill): SkillBuiltinReference {
	const { fingerprint, version, name, description, workflow, resident, everyBeat, body, worldModule } = skill;
	return { fingerprint, ...(version ? { version } : {}), name, description, ...(workflow ? { workflow } : {}), resident, everyBeat, body, ...(worldModule ? { worldModule } : {}) };
}

/** Built-ins keep updating; user edits shadow them without silently rebasing their review metadata. */
export function scanSkillFiles(cwd: string): SkillFile[] {
	const builtins = new Map(scanRoot(join(cwd, "skills"), "builtin").map((skill) => [skill.dir, skill]));
	const merged = new Map<string, SkillFile>();
	for (const skill of builtins.values()) {
		const { fingerprint: _fingerprint, version: _version, ...fields } = skill;
		merged.set(skill.dir, { ...fields, updateStatus: "current", builtin: builtinReference(skill) });
	}
	for (const skill of scanRoot(join(cwd, USER_SKILLS_DIR), "user")) {
		const builtin = builtins.get(skill.dir);
		const { fingerprint: _fingerprint, version: _version, ...fields } = skill;
		const updateStatus: SkillUpdateStatus = !builtin ? "custom" : !skill.baseBuiltinFingerprint ? "untracked" : skill.baseBuiltinFingerprint === builtin.fingerprint ? "current" : "outdated";
		merged.set(skill.dir, { ...fields, updateStatus, ...(builtin ? { builtin: builtinReference(builtin) } : {}) });
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveStageSkill(cwd: string, input: StageSkillInput): { dir: string } {
	const name = oneLine(input.name);
	const description = oneLine(input.description);
	if (!name) throw new Error("skill 名称为空");
	if (!description) throw new Error("简要说明为空");
	if (!input.body.trim()) throw new Error("正文为空");
	const dir = sanitizeSkillDir(input.dir ?? name);
	if (!dir) throw new Error("名称/目录含路径字符，无法作为存储目录");
	const folder = join(cwd, USER_SKILLS_DIR, dir);
	const file = join(folder, "SKILL.md");
	const existing = existsSync(file) ? parseSkillRaw(readFileSync(file, "utf8")) : null;
	if (existsSync(file) && !existing) throw new Error("用户覆盖 frontmatter 损坏，无法保留核对基线");
	const builtin = scanRoot(join(cwd, "skills"), "builtin").find((skill) => skill.dir === dir);
	// Old/untracked overrides remain old/untracked even if a client sends the current fingerprint.
	let baseFingerprint = existing?.meta.get(BASE_FINGERPRINT_KEY);
	let baseVersion = existing?.meta.get(BASE_VERSION_KEY);
	if (!existing && builtin) {
		if (input.baseBuiltinFingerprint !== undefined && !validFingerprint(input.baseBuiltinFingerprint)) throw new Error("内置 Skill 基线指纹格式无效");
		baseFingerprint = input.baseBuiltinFingerprint ?? builtin.fingerprint;
		baseVersion = input.baseBuiltinVersion ?? (baseFingerprint === builtin.fingerprint ? builtin.version : undefined);
	}
	const meta = [
		`name: ${name}`, `description: ${description}`,
		...(input.workflow && WORKFLOW_STAGES.has(input.workflow) ? [`workflow: ${input.workflow}`] : []),
		...(input.worldModule ? [`world-module: ${oneLine(input.worldModule)}`] : []),
		`resident: ${input.resident ? "true" : "false"}`, `每轮: ${input.everyBeat ? "true" : "false"}`,
		...(baseFingerprint ? [`${BASE_FINGERPRINT_KEY}: ${oneLine(baseFingerprint)}`] : []),
		...(baseVersion ? [`${BASE_VERSION_KEY}: ${oneLine(baseVersion)}`] : []),
	];
	mkdirSync(folder, { recursive: true });
	// Body is opaque: no trim, newline normalization, Markdown parsing or automatic replacement.
	writeFileSync(file, `---\n${meta.join("\n")}\n---\n\n${input.body}`, "utf8");
	return { dir };
}

/** Explicit review only: updates metadata, preserving every byte outside those metadata lines. */
export function acknowledgeStageSkillBuiltin(cwd: string, dirName: string, expectedBuiltinFingerprint: string): { dir: string } {
	const dir = sanitizeSkillDir(dirName);
	if (!dir) throw new Error("非法目录名");
	const builtin = scanRoot(join(cwd, "skills"), "builtin").find((skill) => skill.dir === dir);
	if (!builtin) throw new Error("该 Skill 没有内置版本，无法核对");
	if (!validFingerprint(expectedBuiltinFingerprint) || expectedBuiltinFingerprint !== builtin.fingerprint) throw new Error("内置 Skill 已变化，请刷新对照后重试");
	const file = join(cwd, USER_SKILLS_DIR, dir, "SKILL.md");
	if (!existsSync(file)) throw new Error("没有可核对的用户覆盖");
	const raw = readFileSync(file, "utf8");
	const parsed = parseSkillRaw(raw);
	if (!parsed) throw new Error("用户覆盖 frontmatter 损坏，无法记录核对基线");
	const eol = parsed.lines[0]?.endsWith("\r\n") ? "\r\n" : "\n";
	const header = parsed.lines.slice(1, parsed.end).filter((line) => {
		const colon = line.indexOf(":");
		if (colon <= 0) return true;
		const key = line.slice(0, colon).trim();
		return key !== BASE_FINGERPRINT_KEY && key !== BASE_VERSION_KEY;
	});
	const metadata = [`${BASE_FINGERPRINT_KEY}: ${builtin.fingerprint}`, ...(builtin.version ? [`${BASE_VERSION_KEY}: ${builtin.version}`] : [])].join(eol) + eol;
	const next = parsed.lines[0] + header.join("") + metadata + parsed.lines.slice(parsed.end).join("");
	writeFileSync(file, next, "utf8");
	return { dir };
}

/** Removing a user override reveals the versioned built-in again. */
export function deleteStageSkill(cwd: string, dirName: string): void {
	const dir = sanitizeSkillDir(dirName);
	if (!dir) throw new Error("非法目录名");
	const folder = join(cwd, USER_SKILLS_DIR, dir);
	if (!existsSync(join(folder, "SKILL.md"))) throw new Error("内置 skill 不能删除；可编辑生成用户覆盖，或删除已有覆盖");
	rmSync(folder, { recursive: true, force: true });
}

export function workflowSkill(skills: SkillFile[], stage: WorkflowSkillStage): SkillFile | undefined {
	return skills.find((skill) => skill.workflow === stage);
}

export function worldModuleSkillPacks(skills: SkillFile[], modules: Array<{ skillPack: string }>): SkillFile[] {
	const wanted = new Set(modules.map((module) => module.skillPack));
	return skills.filter((skill) => skill.worldModule && wanted.has(skill.worldModule));
}
