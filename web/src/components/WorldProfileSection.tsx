import { useEffect, useState } from "react";
import { api, apiGet, apiPost, apiPut } from "../api.ts";
import { PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";

type ProfileModule = {
	id: string;
	name: string;
	mode: "observe" | "active" | "suspended";
	cadence: string;
	confidence: number;
	reason: string;
	stateFocus: string[];
	writerProjection: string;
	kind: string;
	skillPack: string;
};

type CardWorldProfile = {
	status: "draft" | "stable";
	revision: number;
	analyzedTurns: number;
	digest: string;
	labels: string[];
	primaryScale: string;
	defaultTimeStep: string;
	worldActivity: "quiet" | "low" | "normal" | "active" | "epic";
	modules: ProfileModule[];
	disabledModules: string[];
	userRequirements: string[];
	optimizationNotes: string[];
	unresolvedQuestions: string[];
};

type WorldProfileResponse = {
	profile: CardWorldProfile | null;
	card: { key: string; name: string };
	materialsChanged: boolean;
};

export function WorldProfileSection({ enabled, toast }: { enabled: boolean; toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<WorldProfileResponse>("/api/world-profile"), { cacheKey: "/api/world-profile" });
	const { busy, run } = useAction(toast);
	const [actionError, setActionError] = useState("");
	const [requirements, setRequirements] = useState("");
	const [notes, setNotes] = useState("");
	useEffect(() => {
		setRequirements(data?.profile?.userRequirements.join("\n") ?? "");
		setNotes(data?.profile?.optimizationNotes.join("\n") ?? "");
	}, [data]);
	const save = (patch: Record<string, unknown>, done: string) => run(async () => {
		await apiPut("/api/world-profile", patch);
		reload();
	}, done);
	const analyze = () => run(async () => {
		setActionError("");
		try {
			await apiPost("/api/world-profile/analyze", {});
			reload();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setActionError(message);
			throw cause;
		}
	}, "已按当前素材与优化记录生成角色卡世界画像");
	const clearModule = (moduleId: string) => run(async () => {
		await api(`/api/world-state/module?moduleId=${encodeURIComponent(moduleId)}`, { method: "DELETE" });
	}, `已清空模块 ${moduleId} 的当前分支运行态`);
	return <section className="sp-section">
		<h4>角色卡世界适配</h4>
		<PanelStatus loading={loading} error={error} hasData={!!data} />
		{actionError && <div className="panel-error">{actionError}</div>}
		{data && !data.profile && <>
			<div className="field-hint">「{data.card.name}」尚未建立独立世界画像。首次开演会自动分析，也可以现在生成。</div>
			<button className="drawer-btn primary" disabled={busy || !enabled} onClick={() => void analyze()}>分析这张卡</button>
		</>}
		{data?.profile && <>
			<div className="field-hint">{data.profile.digest}</div>
			<div className="lore-meta">画像 v{data.profile.revision} · 已复盘至第 {data.profile.analyzedTurns} 拍 · {data.profile.primaryScale} 尺度 · 默认 {data.profile.defaultTimeStep} 步进 · {data.profile.labels.join(" / ") || "未标注题材"}</div>
			{data.materialsChanged && data.profile.status !== "stable" && <div className="panel-error">角色卡、世界书、预设或开场已变化，建议重新分析适配。</div>}
			<div className="toggle-row"><span>稳定画像，不因素材变化自动重建</span><Toggle checked={data.profile.status === "stable"} disabled={busy} onChange={(stable) => void save({ status: stable ? "stable" : "draft" }, stable ? "画像已标记稳定" : "画像已恢复持续优化")} /></div>
			<label className="field-label">后台活跃度</label>
			<select className="field-input" value={data.profile.worldActivity} disabled={busy} onChange={(event) => void save({ worldActivity: event.target.value }, "后台活跃度已更新")}>
				<option value="quiet">静稳</option><option value="low">低</option><option value="normal">自然</option><option value="active">活跃</option><option value="epic">史诗</option>
			</select>
			<label className="field-label">本卡长期要求</label>
			<textarea className="field-input" rows={4} value={requirements} disabled={busy} placeholder="每行一条，例如：本卡永远不引入第三者打断二人戏" onChange={(event) => setRequirements(event.target.value)} />
			<label className="field-label">实弹优化记录</label>
			<textarea className="field-input" rows={4} value={notes} disabled={busy} placeholder="记录这张卡跑起来后需要怎样调节；后续重分析会继续参考" onChange={(event) => setNotes(event.target.value)} />
			<button className="drawer-btn" disabled={busy} onClick={() => void save({ userRequirements: requirements.split("\n").map((line) => line.trim()).filter(Boolean), optimizationNotes: notes.split("\n").map((line) => line.trim()).filter(Boolean) }, "本卡长期要求与优化记录已保存")}>保存适配笔记</button>
			<div style={{ marginTop: 10 }}>
				{data.profile.modules.map((module) => <div className="skill-lib-row" key={module.id}>
					<div className="skill-lib-main"><span className="lore-title">{module.name}<span className="skill-badge resident">{module.mode}</span></span><span className="lore-meta">{module.id} · {module.kind} / {module.skillPack} · {module.cadence} · 置信度 {Math.round(module.confidence * 100)}%</span><span className="field-hint">{module.reason}</span></div>
					<div><select className="field-input" style={{ width: 110 }} value={module.mode} disabled={busy} onChange={(event) => void save({ modules: data.profile!.modules.map((item) => item.id === module.id ? { ...item, mode: event.target.value } : item) }, `${module.name} 已切换为 ${event.target.value}`)}><option value="active">运行</option><option value="observe">观察</option><option value="suspended">暂停</option></select><button className="act" disabled={busy} onClick={() => void clearModule(module.id)}>清空本分支状态</button></div>
				</div>)}
			</div>
			{data.profile.unresolvedQuestions.length > 0 && <details><summary>待确认问题（{data.profile.unresolvedQuestions.length}）</summary><ul>{data.profile.unresolvedQuestions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
			<button className="drawer-btn primary" disabled={busy || !enabled} onClick={() => void analyze()}>重新分析适配</button>
		</>}
	</section>;
}
