import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Toggle } from "./kit.tsx";
type Status={config:{enabled:boolean;recentHistoryMessages:number;injectionMaxChars:number};sourceReady:boolean;ref:string;sha256:string};
export function DatabasePluginPanel({toast,onOpenManager}:{onOpenManager:()=>void;toast:(level:"info"|"warning"|"error",text:string)=>void}){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[ref,setRef]=useState(""),[sha,setSha]=useState("");
 const refresh=async()=>{try{const value=await api<Status>("/api/database-plugin/status");setStatus(value);setRef(value.ref);setSha(value.sha256);setError("");}catch(e){setError(e instanceof Error?e.message:"数据库状态读取失败");}};
 useEffect(()=>{void refresh();},[]);
 const run=async(fn:()=>Promise<unknown>,message:string)=>{setBusy(true);try{await fn();await refresh();toast("info",message);}catch(e){const text=e instanceof Error?e.message:"操作失败";setError(text);toast("error",text);}finally{setBusy(false);}};
 return <section className="sp-section"><h4>上游数据库插件</h4>
  <div className="field-hint">原样运行 AlbusKen/shujuku；原记忆库保留，启用后停止旧自动剧情入库与旧摘要压缩。数据库整理沿用记忆岗位，嵌入沿用独立配置；不会统一替换模型。</div>
  {error&&<div className="panel-error">{error}</div>}
  {!status?<button className="drawer-btn" onClick={()=>void refresh()}>重新读取</button>:<>
   <div className="toggle-row"><span>使用原数据库插件作为记忆后端</span><Toggle checked={status.config.enabled} onChange={enabled=>{if(!busy)void run(()=>api("/api/database-plugin/config",{method:"POST",body:JSON.stringify({enabled})}),enabled?"原数据库记忆后端已启用":"已回退旧记忆后端，插件数据保留");}}/></div>
   <div className="field-hint">源码缓存：{status.sourceReady?"已核验":"尚未安装"} · 更新固定版本与SHA-256，不自动跟随主分支。</div>
   <label className="field-label">固定上游版本地址</label><input className="field-input" value={ref} onChange={e=>setRef(e.target.value)} /><label className="field-label">预期 SHA-256（必须核验）</label><input className="field-input" value={sha} onChange={e=>setSha(e.target.value)} />
   <button className="drawer-btn" disabled={busy} onClick={()=>{setBusy(true);void api<{ref:string;expectedSha256:string;version:string}>("/api/database-plugin/source/check",{method:"POST",body:"{}"}).then(candidate=>{setRef(candidate.ref);setSha(candidate.expectedSha256);toast("info",`已核验上游 ${candidate.version} 候选，点击安装才切换；可回退`);}).catch(e=>toast("error",e instanceof Error?e.message:"检查更新失败")).finally(()=>setBusy(false));}}>检查上游更新（不自动切换）</button>
   <button className="drawer-btn" disabled={busy} onClick={()=>void run(()=>api("/api/database-plugin/source/install",{method:"POST",body:JSON.stringify({ref,expectedSha256:sha})}),"上游源码已校验并缓存，未改写核心")}>安装／核验当前固定版本</button>
   <button className="drawer-btn" disabled={busy} onClick={()=>void run(()=>api("/api/database-plugin/source/rollback",{method:"POST",body:"{}"}),"已回退前一已核验插件版本，私有记忆数据保留")}>回退上一插件版本</button>
   <button className="drawer-btn" disabled={busy||!status.sourceReady} onClick={onOpenManager}>打开独立数据库管理台</button>
   <div className="field-hint">原管理台保留人物表、纪要、交火、0TK及模板设置。完整记忆依赖服务端浏览器运行时；异常会明确报错，不假装记忆已保存。</div>
  </>}
 </section>;
}
