/** Authenticated read-only artifacts. Store rendered-story inputs, never auth/request contexts. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(id);
export function realTestRoot(cwd: string): string { return join(cwd,".liyuan","real-tests"); }
export function readRealTest(cwd:string,id:string): Record<string,unknown> | null {
	if(!validId(id)) return null;
	const file=join(realTestRoot(cwd),id+".json");
	if(!existsSync(file))return null;
	try { const raw=readFileSync(file,"utf8");if(raw.length>16_000_000)return null;const item=JSON.parse(raw);return item && item.id===id && item.readOnly===true ? item : null; } catch { return null; }
}
export function listRealTests(cwd:string): Record<string,unknown>[] {
	const root=realTestRoot(cwd);if(!existsSync(root))return [];
	return readdirSync(root).filter(x=>x.endsWith(".json")&&validId(x.slice(0,-5))).slice(0,100).flatMap(file=>{
		const r=readRealTest(cwd,file.slice(0,-5));if(!r)return [];
		return [{id:r.id,title:r.title,cardName:r.cardName,createdAt:r.createdAt,status:r.status,description:r.description,recordScope:r.recordScope,messageCount:Array.isArray(r.messages)?r.messages.length:0,checks:r.checks}];
	}).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}
