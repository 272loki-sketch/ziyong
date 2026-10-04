import { useEffect, useState } from "react";
import { apiGet } from "../../api.ts";
function JsonCard({ title, value }: { title: string; value: unknown }) { return <section className="planning-card"><div className="planning-card-head"><strong>{title}</strong><span>只读投影</span></div><pre style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto" }}>{JSON.stringify(value ?? {}, null, 2)}</pre></section>; }
export function WorldModule() {
 const [profile, setProfile] = useState<unknown>(null); const [world, setWorld] = useState<unknown>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
 const load = async () => { setLoading(true); setError(""); try { const [p, w] = await Promise.all([apiGet<unknown>("/api/world-profile", { bypassCache: true }), apiGet<unknown>("/api/world-state", { bypassCache: true })]); setProfile(p); setWorld(w); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); } };
 useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5_000); return () => window.clearInterval(timer); }, []);
 return <div className="planning-page"><div className="planning-page-note"><strong>世界状态 · 只读管理视图。</strong>这里汇总世界画像、模块清单和当前运行态；实际提交仍由世界转移审计链负责。</div><div className="diagnostic-toolbar"><span>{loading ? "同步中…" : "每 5 秒刷新"}</span><button className="drawer-btn" onClick={() => void load()} disabled={loading}>刷新</button></div>{error && <div className="panel-error planning-error">{error}</div>}{!loading && !error && <div className="planning-grid"><JsonCard title="世界画像" value={profile} /><JsonCard title="世界运行态" value={world} /></div>}</div>;
}
