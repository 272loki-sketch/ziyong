import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { loadAgentConfig, resolveEnvApiKey, type AgentProvider } from "../src/agent-config.ts";

export interface DatabasePluginModelRef { provider: string; id: string }
export interface DatabasePluginGenerationOptions { modelRef?: DatabasePluginModelRef; purpose?: "fill" | "recall"; payload?: Record<string, any>; validateBinding?:()=>void }
export interface DatabasePluginModelRoles { fillModel?: DatabasePluginModelRef; recallModel?: DatabasePluginModelRef }
export interface DatabasePluginManagedPreset { name: string; purpose: "fill" | "recall"; provider: string; model: string; url: string; maxTokens: number }
export interface DatabasePluginChatReply { id?: string; model?: string; choices: Array<{index: number; message: {role: "assistant"; content: string | null; tool_calls?: any[]}; finish_reason: string}>; usage?: Record<string, number> }
type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type DatabasePluginConnection = { provider?: string; purpose?: "fill" | "recall"; config?: AgentProvider; url: string; managed: boolean; alias?: boolean };
const bridgePrefix = "/api/database-plugin/connections/";
export function managedDatabasePluginPresets(cwd: string, roles: DatabasePluginModelRoles): DatabasePluginManagedPreset[] {
 const providers=loadAgentConfig(cwd).config.providers;
 return (["fill","recall"] as const).flatMap(purpose=>{
  const ref=purpose==="fill"?roles.fillModel:roles.recallModel;
  const provider=ref&&providers[ref.provider];const model=provider?.models?.find(m=>m.id===ref?.id);
  if(!ref||!provider||!model)return [];
  return [{name:`梨园 · ${ref.id} · ${purpose==="fill"?"填表":"召回"}`,purpose,provider:ref.provider,model:ref.id,url:`${bridgePrefix}${purpose}/${encodeURIComponent(ref.provider)}/v1`,maxTokens:Math.min(Number(model.maxTokens)||16384,purpose==="recall"?8192:16384)}];
 });
}
export function databasePluginModelRevision(presets: DatabasePluginManagedPreset[]): string {
 return createHash("sha256").update(JSON.stringify(presets)).digest("hex").slice(0,16);
}
function baseUrl(value: string): string {
 const url=new URL(value);url.pathname=url.pathname.replace(/\/(?:chat\/completions|models)\/?$/,"").replace(/\/+$/,"");
 if(url.username||url.password||url.hash||url.search)throw new Error("API地址不能包含URL凭据、查询参数或片段");
 return url.href.replace(/\/+$/,"");
}
export function resolveDatabasePluginConnection(cwd: string, value: unknown): DatabasePluginConnection {
 const raw=typeof value==="string"?value.trim():"";if(!raw||raw.length>2048)throw new Error("缺少有效API基础URL");
 const parsed=new URL(raw,"http://liyuan-host.invalid");
 if(parsed.pathname.startsWith(bridgePrefix)) {
  const match=parsed.pathname.slice(bridgePrefix.length).match(/^(fill|recall)\/([^/]+)\/v1\/?$/);
  if(!match)throw new Error("无效的梨园模型连接引用");
  const provider=decodeURIComponent(match[2]),config=loadAgentConfig(cwd).config.providers[provider];
  if(!config?.baseUrl)throw new Error("该梨园连接未启用或已被移除");
  return {provider,purpose:match[1] as "fill"|"recall",config,url:baseUrl(String(config.baseUrl)),managed:true,alias:true};
 }
 const url=baseUrl(raw);
 for(const [provider,config]of Object.entries(loadAgentConfig(cwd).config.providers)){
  if(config.baseUrl){try{if(baseUrl(String(config.baseUrl))===url)return {provider,config,url,managed:true};}catch{}}
 }
 return {url,managed:false};
}
export function isPrivateDatabasePluginAddress(address: string): boolean {
 const ip=address.toLowerCase();if(ip.includes(":"))return ip==="::"||ip==="::1"||ip.startsWith("fc")||ip.startsWith("fd")||/^fe[89ab][0-9a-f]:/.test(ip)||/^fe[cdef]/.test(ip)||ip.startsWith("ff")||ip.startsWith("::ffff:");
 const octets=ip.split(".").map(Number);if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255))return true;
 const [a,b]=octets;return a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19);
}
export async function assertDatabasePluginPublicUrl(address: string, resolver: typeof lookup = lookup, allowQuery=false): Promise<void> {
 const url=new URL(address);const hostname=url.hostname.replace(/^\[|\]$/g,"");
 if(url.protocol!=="https:"||url.username||url.password||(!allowQuery&&url.search)||url.hash)throw new Error("未绑定的自定义API必须使用无URL凭据的HTTPS地址");
 const answers=isIP(hostname)?[{address:hostname}]:await resolver(hostname,{all:true});
 if(!answers.length||answers.some(row=>isPrivateDatabasePluginAddress(row.address)))throw new Error("禁止自定义API代理访问私有、回环或链路本地地址");
}
/** Public custom APIs pin the vetted DNS answer; a second resolution must not rebound into private space. */
export async function publicDatabasePluginFetch(address:string,init:RequestInit={},constraints:{allowQuery?:boolean;maxBytes?:number;timeoutMs?:number;guard?:()=>void}={}):Promise<Response>{
 const url=new URL(address),hostname=url.hostname.replace(/^\[|\]$/g,"");
 await assertDatabasePluginPublicUrl(address,lookup,constraints.allowQuery===true);
 const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true});
 if(!addresses.length||addresses.some(row=>isPrivateDatabasePluginAddress(row.address)))throw new Error("自定义API地址在连接时解析到了禁止地址");
 const chosen=addresses.find(row=>row.family===4)??addresses[0];constraints.guard?.();
 return new Promise((resolve,reject)=>{
  if(init.signal?.aborted){reject(new Error("数据库API请求已取消"));return;}
  const headers={...(init.headers as Record<string,string>??{}),"accept-encoding":"identity"};
  const request=httpsRequest(url,{method:init.method||"GET",headers,lookup:((name:any,opts:any,done:any)=>{
   if(name!==hostname){done(new Error("自定义API DNS绑定变化"));return;}
   if(opts?.all)done(null,[chosen]);else done(null,chosen.address,chosen.family);
  }) as any},response=>{
   const buffers:Buffer[]=[];let size=0;
   response.on("data",chunk=>{size+=chunk.length;if(size>(constraints.maxBytes??8*1024*1024)){request.destroy(new Error("数据库API响应过大"));return;}buffers.push(Buffer.from(chunk));});
   response.on("end",()=>{init.signal?.removeEventListener("abort",abort);try{resolve(new Response([204,205,304].includes(response.statusCode||0)?null:Buffer.concat(buffers),{status:response.statusCode||502,headers:{"content-type":String(response.headers["content-type"]||"application/json")}}));}catch(error){reject(error);}});
   response.on("error",reject);
  });
  const abort=()=>request.destroy(new Error("数据库API请求已取消"));
  init.signal?.addEventListener("abort",abort,{once:true});request.on("error",error=>{init.signal?.removeEventListener("abort",abort);reject(error);});
  request.setTimeout(constraints.timeoutMs??(init.method==="POST"?180000:15000),()=>request.destroy(new Error("数据库API请求超时")));
  if(init.body)request.write(String(init.body));request.end();
 });
}
export function databasePluginRequestHeaders(payload: Record<string,any>): Record<string,string> {
 const headers:Record<string,string>={"content-type":"application/json"};
 const raw=String(payload.custom_include_headers??"");if(raw.length>16384)throw new Error("自定义API请求头过大");
 for(const line of raw.split(/\r?\n/)){if(!line.trim())continue;const colon=line.indexOf(":");if(colon<1)throw new Error("无效自定义API请求头");const name=line.slice(0,colon).trim().toLowerCase(),value=line.slice(colon+1).trim();
  if(!/^[a-z0-9-]+$/.test(name)||/[\r\n\0]/.test(value)||["host","cookie","connection","content-length","transfer-encoding","proxy-authorization"].includes(name))throw new Error("不允许的自定义API请求头");headers[name]=value;
 }
 return headers;
}
function savedDatabasePluginHeaders(settings:Record<string,any>,url:string,model?:string):string|undefined {
 const matches:Array<Record<string,any>>=[];
 const visit=(value:any,depth=0)=>{
  if(depth>16)return;
  if(typeof value==="string"&&/^[\s]*[\[{]/.test(value)){try{visit(JSON.parse(value),depth+1)}catch{}}
  else if(Array.isArray(value))for(const item of value)visit(item,depth+1);
  else if(value&&typeof value==="object"){
   if(typeof value.url==="string"&&(!model||String(value.model??"").replace(/^models\//,"")===model)){try{if(baseUrl(value.url)===url)matches.push(value)}catch{}}
   for(const child of Object.values(value))visit(child,depth+1);
  }
 };visit(settings);
 const unique=new Map(matches.map(m=>[JSON.stringify({apiKey:m.apiKey,requestHeaders:m.requestHeaders}),m]));
 if(unique.size>1)throw new Error("同地址存在多个不同鉴权预设，请填写本预设密钥或使用梨园连接引用");
 const saved=unique.values().next().value;
 return saved?[saved.apiKey?`Authorization: Bearer ${saved.apiKey}`:"",saved.requestHeaders??""].filter(Boolean).join("\n"):undefined;
}
export async function probeDatabasePluginModels(cwd: string,payload:Record<string,any>,options:{fetch?:FetchLike;auth?:(provider:string)=>Promise<{apiKey?:string;headers?:Record<string,string>}>;publicUrl?:(url:string)=>Promise<void>;settings?:Record<string,any>;guard?:()=>void;signal?:AbortSignal}={}):Promise<{object:"list";data:Array<{id:string;object:"model"}>;source:"upstream"}> {
 const connection=resolveDatabasePluginConnection(cwd,payload.custom_url||payload.reverse_proxy);let headers=databasePluginRequestHeaders(payload);
 if(connection.managed&&connection.provider&&(connection.alias||!headers.authorization||headers.authorization.includes("host-managed"))){const auth=options.auth?await options.auth(connection.provider):{apiKey:resolveEnvApiKey(String(connection.config?.apiKey??""))};for(const [name,value]of Object.entries(auth.headers??{}))headers[name.toLowerCase()]=String(value);if(auth.apiKey)headers.authorization="Bearer "+auth.apiKey;}
 else {if(!connection.managed)await (options.publicUrl??assertDatabasePluginPublicUrl)(connection.url);if(Object.values(headers).some(v=>v.includes("host-managed"))){const saved=savedDatabasePluginHeaders(options.settings??{},connection.url);if(saved===undefined)throw new Error("该端点没有绑定梨园连接，请填写这个预设自己的API密钥");headers=databasePluginRequestHeaders({custom_include_headers:saved});}}
 options.guard?.();
 if(!headers["user-agent"])headers["user-agent"]="Mozilla/5.0";
 const requestOptions={method:"GET",headers,redirect:"error" as const,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)};
 const response=options.fetch?await options.fetch(connection.url+"/models",requestOptions):connection.managed?await fetch(connection.url+"/models",requestOptions):await publicDatabasePluginFetch(connection.url+"/models",requestOptions,{guard:options.guard});
 if(!response.ok)throw Object.assign(new Error(`API模型列表检查失败（HTTP ${response.status}），请核对地址、鉴权与服务端模型目录`),{status:response.status});
 const raw=await response.text();if(raw.length>4*1024*1024)throw new Error("模型列表响应过大");let json:any;try{json=JSON.parse(raw)}catch{throw new Error("API模型列表不是有效JSON")}
 const list=Array.isArray(json)?json:Array.isArray(json.data)?json.data:Array.isArray(json.models)?json.models:[];
 const ids=[...new Set<string>(list.map((m:any)=>typeof m==="string"?m:String(m?.id??m?.name??"")).filter((s:string)=>s.trim()&&s.length<512))];
 if(!ids.length)throw new Error("API返回的模型列表为空或格式无法识别");return {object:"list",data:ids.map(id=>({id,object:"model" as const})),source:"upstream"};
}
export function validateDatabasePluginChatPayload(payload:Record<string,any>):void {
 if(!Array.isArray(payload.messages)||!payload.messages.length||payload.messages.length>100||payload.messages.some((m:any)=>!["system","user","assistant","tool"].includes(m?.role)||typeof m.content!=="string"&&m.content!==null))throw new Error("无效数据库模型消息");
 if(payload.messages.reduce((n:number,m:any)=>n+String(m.content??"").length,0)>240000)throw new Error("数据库模型材料过大");
 if(payload.tools!==undefined&&(!Array.isArray(payload.tools)||payload.tools.length>32||payload.tools.some((t:any)=>t?.type!=="function"||typeof t.function?.name!=="string"||!t.function.parameters||typeof t.function.parameters!=="object")))throw new Error("无效数据库工具定义");
}
export function databasePluginChatReply(text:string,model="host-managed"):DatabasePluginChatReply {
 return {model,choices:[{index:0,message:{role:"assistant",content:text},finish_reason:"stop"}]};
}
export function databasePluginChatSse(reply:DatabasePluginChatReply):string {
 const choice=reply.choices[0];const chunk={id:reply.id||"liyuan-database",object:"chat.completion.chunk",model:reply.model,choices:[{index:0,delta:{role:"assistant",...(choice.message.content?{content:choice.message.content}:{}),...(choice.message.tool_calls?{tool_calls:choice.message.tool_calls.map((t:any,index:number)=>({...t,index}))}:{})},finish_reason:null}]};
 const end={...chunk,choices:[{index:0,delta:{},finish_reason:choice.finish_reason}],...(reply.usage?{usage:reply.usage}:{})};return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`;
}

export async function requestDatabasePluginCompletion(cwd:string,payload:Record<string,any>,settings:Record<string,any>,options:{fetch?:FetchLike;publicUrl?:(url:string)=>Promise<void>;auth?:(provider:string)=>Promise<{apiKey?:string;headers?:Record<string,string>}>;complete?:(payload:Record<string,any>,options:DatabasePluginGenerationOptions,signal?:AbortSignal)=>Promise<DatabasePluginChatReply>;generate?:(prompts:Array<{role:string;content:string}>,signal?:AbortSignal,options?:DatabasePluginGenerationOptions)=>Promise<string>},signal?:AbortSignal,guard?:()=>void):Promise<DatabasePluginChatReply> {
 validateDatabasePluginChatPayload(payload);
 const connection=resolveDatabasePluginConnection(cwd,payload.custom_url||payload.reverse_proxy);
 const model=String(payload.model??"").replace(/^models\//,"");if(!model||model.length>512)throw new Error("请选择有效的数据库模型");
 if(connection.alias&&connection.provider){
  if(!connection.config?.models?.some(m=>m.id===model))throw new Error("所选模型不在梨园这个启用连接的模型清单中");
  const args:DatabasePluginGenerationOptions={modelRef:{provider:connection.provider,id:model},purpose:connection.purpose,payload,validateBinding:guard};
  guard?.();if(options.complete)return options.complete(payload,args,signal);
  if(options.generate)return databasePluginChatReply(await options.generate(payload.messages,signal,args),model);
  throw new Error("梨园模型调用接口不可用");
 }
 if(!connection.managed)await(options.publicUrl??assertDatabasePluginPublicUrl)(connection.url);
 let restored={...payload};const rawHeaders=String(payload.custom_include_headers??"");
 if(rawHeaders.includes("host-managed")) {
  const saved=savedDatabasePluginHeaders(settings,connection.url,model);
  if(saved!==undefined){restored.custom_include_headers=saved;}
  else if(connection.provider&&options.auth){const auth=await options.auth(connection.provider);restored.custom_include_headers=Object.entries({...auth.headers,...(auth.apiKey?{authorization:"Bearer "+auth.apiKey}:{})}).map(([k,v])=>`${k}: ${v}`).join("\n");}
  else throw new Error("这个自定义预设的鉴权未保存，请重新填写密钥后保存");
 }
 const headers=databasePluginRequestHeaders(restored);
 const body:Record<string,any>={model,messages:payload.messages,stream:false,max_tokens:Math.min(16384,Math.max(256,Number(payload.max_tokens)||8192)),temperature:typeof payload.temperature==="number"?payload.temperature:1};
 if(typeof payload.top_p==="number")body.top_p=payload.top_p;
 if(payload.tools?.length){body.tools=payload.tools;body.tool_choice=payload.tool_choice||"auto";}
 if(payload.response_format)body.response_format=payload.response_format;
 // Unknown custom YAML/body fragments are not executable configuration in the host.
 if(payload.custom_include_body&&String(payload.custom_include_body).trim()){
  if(String(payload.custom_include_body).length>65536)throw new Error("自定义API附加请求体过大");
  let extra:any;try{extra=parseYaml(String(payload.custom_include_body),{maxAliasCount:50})}catch{throw new Error("自定义API附加请求体不是有效的YAML/JSON对象")}
  if(!extra||typeof extra!=="object"||Array.isArray(extra))throw new Error("自定义API附加请求体不是JSON对象");
  for(const [key,value]of Object.entries(extra))if(!["model","messages","stream","max_tokens","tools","tool_choice","custom_url","headers","__proto__","constructor","prototype"].includes(key))body[key]=value;
 }
 for(const name of String(payload.custom_exclude_body??"").split(/[\s,]+/).filter(Boolean))if(!["model","messages","stream"].includes(name))delete body[name];
 guard?.();const requestOptions={method:"POST",headers,body:JSON.stringify(body),redirect:"error" as const,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)};
 const response=options.fetch?await options.fetch(connection.url+"/chat/completions",requestOptions):connection.managed?await fetch(connection.url+"/chat/completions",requestOptions):await publicDatabasePluginFetch(connection.url+"/chat/completions",requestOptions,{guard});
 if(!response.ok)throw Object.assign(new Error(`数据库API生成失败（HTTP ${response.status}），请检查鉴权、模型和额度`),{status:response.status});
 const raw=await response.text();if(raw.length>8*1024*1024)throw new Error("数据库API响应过大");let json:any;try{json=JSON.parse(raw)}catch{throw new Error("数据库API未返回有效的非流式JSON响应")}
 const choice=json?.choices?.[0];if(!choice?.message||typeof choice.message.content!=="string"&&!Array.isArray(choice.message.tool_calls))throw new Error("数据库API返回中没有有效的正文或工具调用");
 return {id:json.id,model:json.model||model,choices:[{index:0,message:{role:"assistant",content:typeof choice.message.content==="string"?choice.message.content:null,...(Array.isArray(choice.message.tool_calls)?{tool_calls:choice.message.tool_calls}:{})},finish_reason:String(choice.finish_reason||"stop")}],...(json.usage?{usage:json.usage}:{})};
}
