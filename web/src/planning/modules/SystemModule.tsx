import { useEffect, useState } from "react";
import { apiGet } from "../../api.ts";
function JsonCard({ title, value }: { title: string; value: unknown }) { return <section className="planning-card"><div className="planning-card-head"><strong>{title}</strong><span>只读投影</span></div><pre style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{JSON.stringify(value ?? {}, null, 2)}</pre></section>; }
export function SystemModule() {
 const [config, setConfig] = useState<unknown>(null); const [models, setModels] = useState<unknown>(null); const [schedule, setSchedule] = useState<unknown>(null); const [error, setError] = useState("");
 const load = async () => { setError(""); try { const [c, m, s] = await Promise.all([apiGet<unknown>("/api/config", { bypassCache: true }), apiGet<unknown>("/api/models/catalog", { bypassCache: true }), apiGet<unknown>("/api/outline/research/search/schedule", { bypassCache: true })]); setConfig(c); setModels(m); setSchedule(s); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
 useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5_000); return () => window.clearInterval(timer); }, []);
 return <div className="planning-page"><div className="planning-page-note"><strong>系统总览 · 只读管理视图。</strong>配置修改继续使用既有设置面板和受控 API；这里集中查看当前配置投影、模型目录及研究后台任务，避免复制另一套写入逻辑。</div><div className="diagnostic-toolbar"><span>每 5 秒刷新</span><button className="drawer-btn" onClick={() => void load()}>刷新</button></div>{error && <div className="panel-error planning-error">{error}</div>}<div className="planning-grid"><JsonCard title="当前配置" value={config} /><JsonCard title="模型目录" value={models} /><JsonCard title="研究搜索后台" value={schedule} /></div></div>;
}
