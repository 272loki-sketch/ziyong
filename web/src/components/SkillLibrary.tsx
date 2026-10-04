import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

type WorkflowStage = "continuity" | "character" | "persona" | "director" | "writer" | "curtain" | "world" | "world-profile" | "world-facts" | "world-audit" | "ecology-global" | "ecology-card" | "ecology-runtime" | "outline-bootstrap" | "outline-chat" | "outline-reconcile" | "outline-foreshadowing" | "outline-research" | "outline-audit";
type SkillUpdateStatus = "current" | "outdated" | "untracked" | "custom";
type BuiltinReference = {
	fingerprint: string;
	version?: string;
	name: string;
	description: string;
	workflow?: WorkflowStage;
	resident: boolean;
	everyBeat: boolean;
	worldModule?: string;
	body: string;
};
type StageSkill = {
	dir: string;
	name: string;
	description: string;
	workflow?: WorkflowStage;
	resident?: boolean;
	everyBeat?: boolean;
	chars: number;
	body: string;
	source: "builtin" | "user";
	worldModule?: string;
	updateStatus?: SkillUpdateStatus;
	baseBuiltinFingerprint?: string;
	baseBuiltinVersion?: string;
	builtin?: BuiltinReference;
};

const STAGE_LABELS: Record<WorkflowStage, string> = {
	continuity: "连续性",
	character: "Sogon",
	persona: "Sigon",
	director: "导演",
	writer: "主演",
	curtain: "谢幕格式",
	world: "后台世界",
	"world-profile": "角色卡世界画像",
	"world-facts": "拍后事实信封",
	"world-audit": "世界转移审计",
	"ecology-global": "通用原型池",
	"ecology-card": "角色卡生态池",
	"ecology-runtime": "人物场所生态",
	"outline-bootstrap": "大纲首次规划",
	"outline-chat": "大纲编剧讨论",
	"outline-reconcile": "大纲剧情校准",
	"outline-foreshadowing": "大纲伏笔编织",
	"outline-research": "大纲研究灵感",
	"outline-audit": "大纲提案审计",
};

const UPDATE_LABELS: Record<SkillUpdateStatus, string> = {
	current: "当前内置基线",
	outdated: "内置已更新",
	untracked: "覆盖基线未知",
	custom: "自定义 Skill",
};
const updateStatus = (skill: StageSkill): SkillUpdateStatus => skill.updateStatus ?? (skill.source === "builtin" ? "current" : skill.builtin ? "untracked" : "custom");

export function SkillLibrary({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [skills, setSkills] = useState<StageSkill[] | null>(null);
	const [editing, setEditing] = useState<StageSkill | null>(null);
	const [comparing, setComparing] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const reload = useCallback(async () => {
		try {
			setSkills((await apiGet<{ skills: StageSkill[] }>("/api/stage-skills")).skills);
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		}
	}, [toast]);
	useEffect(() => { void reload(); }, [reload]);

	const save = async () => {
		if (!editing) return;
		setBusy(true);
		try {
			await apiPost("/api/stage-skills", {
				dir: editing.dir,
				name: editing.name,
				description: editing.description,
				workflow: editing.workflow,
				resident: editing.resident ?? false,
				everyBeat: editing.everyBeat ?? false,
				body: editing.body,
				worldModule: editing.worldModule,
				...(editing.source === "builtin" && editing.builtin ? {
					baseBuiltinFingerprint: editing.builtin.fingerprint,
					baseBuiltinVersion: editing.builtin.version,
				} : {}),
			});
			toast("info", "已保存用户覆盖；正文完整保留，普通保存不会重置内置更新提示");
			setEditing(null);
			await reload();
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const acknowledge = async (skill: StageSkill) => {
		if (!skill.builtin || skill.source !== "user" || editing || busy) return;
		if (!window.confirm("确认已核对下面的当前内置版本？此操作只记录核对基线，不替换或修改你的覆盖正文。")) return;
		setBusy(true);
		try {
			await apiPost("/api/stage-skills/acknowledge", { dir: skill.dir, builtinFingerprint: skill.builtin.fingerprint });
			toast("info", "已记录当前内置核对基线；用户正文未改变");
			await reload();
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const comparison = (skill: StageSkill) => skill.builtin && comparing === skill.dir ? <div className="skill-edit-form" aria-label={`${skill.name}内置对照`}>
		<div className="field-hint">仅供对照，绝不自动合并或替换正文。当前状态只表示核对基线，不表示你的内容与内置相同。</div>
		<div className="lore-meta">覆盖基线：{skill.baseBuiltinVersion || "无版本号"} / {skill.baseBuiltinFingerprint?.slice(0, 12) || "未知"}；当前内置：{skill.builtin.version || "无版本号"} / {skill.builtin.fingerprint.slice(0, 12)}</div>
		<label className="field-label">当前内置 · {skill.builtin.name}</label>
		<div className="field-hint">{skill.builtin.description} · {skill.builtin.workflow ? STAGE_LABELS[skill.builtin.workflow] || skill.builtin.workflow : "写作参考"}{skill.builtin.worldModule ? ` · 模块 ${skill.builtin.worldModule}` : ""}</div>
		<textarea className="panel-search ta preset-block-ta" rows={14} readOnly spellCheck={false} value={skill.builtin.body} aria-label="当前内置正文（只读）" />
		<label className="field-label">{editing?.dir === skill.dir ? "当前编辑中的覆盖（尚未保存）" : "已保存用户覆盖"}</label>
		<textarea className="panel-search ta preset-block-ta" rows={14} readOnly spellCheck={false} value={editing?.dir === skill.dir ? editing.body : skill.body} aria-label="用户覆盖正文对照（只读）" />
		<div className="panel-row list-toolbar skill-edit-acts">
			<button className="drawer-btn" disabled={busy || !!editing || skill.source !== "user" || updateStatus(skill) === "current"} onClick={() => void acknowledge(skill)}>已核对此内置版本（保留覆盖）</button>
			<button className="drawer-btn" disabled={busy} onClick={() => setComparing(null)}>关闭对照</button>
		</div>
		{editing && <div className="field-hint">请先保存或取消编辑，再记录核对基线；保存本身不会消除更新提示。</div>}
	</div> : null;

	return <section className="sp-section">
		<div className="field-hint">内置工作流 Skill 随版本更新；编辑后保存为用户覆盖，不会被更新覆写。更新只提醒与对照；旧覆盖没有基线元数据时显示“未知”，不误报已过期。</div>
		{skills === null && <div className="sp-empty">读取中...</div>}
		{skills?.map((skill) => <div key={skill.dir}>
			{editing?.dir === skill.dir ? <div className="skill-edit-form">
				<label className="field-label">名称</label>
				<input className="panel-search" value={editing.name} disabled={busy} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
				<label className="field-label">说明</label>
				<input className="panel-search" value={editing.description} disabled={busy} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
				<label className="field-label">工作流阶段</label>
				<select className="field-input" value={editing.workflow ?? ""} disabled={busy} onChange={(event) => setEditing({ ...editing, workflow: event.target.value as WorkflowStage || undefined })}>
					<option value="">写作参考</option>
					{Object.entries(STAGE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
				</select>
				<label className="field-label">Skill 正文</label>
				{editing.worldModule && <div className="field-hint">世界模块包：{editing.worldModule}</div>}
				<textarea className="panel-search ta preset-block-ta" rows={18} value={editing.body} disabled={busy} spellCheck={false} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
				<div className="panel-row list-toolbar skill-edit-acts">
					<button className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>保存覆盖</button>
					<button className="drawer-btn" disabled={busy} onClick={() => setEditing(null)}>取消</button>
					{skill.builtin && <button className="drawer-btn" disabled={busy} onClick={() => setComparing(comparing === skill.dir ? null : skill.dir)}>内置对照</button>}
				</div>
			</div> : <div className="skill-lib-row">
				<div className="skill-lib-main">
					<span className="lore-title">{skill.name}{skill.workflow && <span className="skill-badge resident">{STAGE_LABELS[skill.workflow] || skill.workflow}</span>}{skill.worldModule && <span className="skill-badge resident">模块 {skill.worldModule}</span>}<span className="skill-badge">{UPDATE_LABELS[updateStatus(skill)]}</span></span>
					<span className="lore-meta">{skill.description} · {skill.chars.toLocaleString()} 字 · {skill.source === "user" ? "用户覆盖" : "内置"}</span>
					{updateStatus(skill) === "outdated" && <div className="field-hint" role="status">内置已有更新；你的覆盖保持原样。请对照后再显式记录“已核对”。</div>}
					{updateStatus(skill) === "untracked" && <div className="field-hint" role="status">旧覆盖的基线未知，无法判断是否落后；查看对照后可记录当前核对基线。</div>}
				</div>
				{skill.builtin && skill.source === "user" && <button className="act" disabled={busy} onClick={() => setComparing(comparing === skill.dir ? null : skill.dir)}>内置对照</button>}
				<button className="act" disabled={busy || !!editing} onClick={() => setEditing({ ...skill })}>编辑</button>
			</div>}
			{comparison(skill)}
		</div>)}
	</section>;
}
