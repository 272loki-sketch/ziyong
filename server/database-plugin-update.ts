import { createHash } from 'node:crypto';
import { DATABASE_PLUGIN_MAX_BYTES } from './database-plugin-source.ts';
export interface DatabasePluginUpdate { ref:string;expectedSha256:string;commit:string;version:string;bytes:number; }
async function bytes(response:Response,max:number){if(!response.ok)throw new Error('上游更新检查HTTP '+response.status);const reader=response.body?.getReader();if(!reader)throw new Error('上游返回空响应');const parts:Uint8Array[]=[];let length=0;try{while(true){const row=await reader.read();if(row.done)break;length+=row.value.length;if(length>max)throw new Error('上游响应超过检查预算');parts.push(row.value);}}finally{await reader.cancel().catch(()=>{})}return Buffer.concat(parts);}
/** Inspect only the explicitly selected upstream repository; no source is activated by this check. */
export async function checkDatabasePluginUpdate(fetchImpl:typeof fetch=fetch):Promise<DatabasePluginUpdate>{
 const signal=AbortSignal.timeout(60000);
 const metadata=JSON.parse((await bytes(await fetchImpl('https://api.github.com/repos/AlbusKen/shujuku/commits/main',{redirect:'error',signal,headers:{accept:'application/vnd.github+json'}}),2*1024*1024)).toString());
 const commit=metadata.sha;if(typeof commit!=='string'||!/^[0-9a-f]{40}$/.test(commit))throw new Error('上游commit格式无效');
 const tree=JSON.parse((await bytes(await fetchImpl(`https://api.github.com/repos/AlbusKen/shujuku/git/trees/${commit}`,{redirect:'error',signal,headers:{accept:'application/vnd.github+json'}}),2*1024*1024)).toString());
 const blob=tree.tree?.find((e:any)=>e.path==='index.js'&&e.type==='blob');if(!blob||!/^[0-9a-f]{40}$/.test(blob.sha)||blob.size>DATABASE_PLUGIN_MAX_BYTES)throw new Error('上游没有合格安装产物');
 const ref=`https://gcore.jsdelivr.net/gh/AlbusKen/shujuku@${commit}/index.js`;
 const data=await bytes(await fetchImpl(ref,{redirect:'error',signal}),DATABASE_PLUGIN_MAX_BYTES);
 const actual=createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex');if(actual!==blob.sha)throw new Error('CDN安装产物与GitHub对象不一致，不提供升级');
 return {ref,expectedSha256:createHash('sha256').update(data).digest('hex'),commit,version:data.subarray(0,1200).toString().match(/@version\s+(\S+)/)?.[1]??'unknown',bytes:data.length};
}
