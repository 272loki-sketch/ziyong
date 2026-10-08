import { streamSimple } from "@liyuan/ai/compat";
import { databasePluginChatReply, type DatabasePluginGenerationOptions, type DatabasePluginChatReply, type DatabasePluginModelRef } from "./database-plugin-models.ts";
export interface DatabasePluginGenerationDependencies {
 findModel(ref:DatabasePluginModelRef):any;
 defaultModel():any;
 auth(model:any):Promise<{ok:boolean;apiKey?:string;headers?:Record<string,string>}>;
 stream?:typeof streamSimple;
}
export function createDatabasePluginGenerator(dependencies:DatabasePluginGenerationDependencies){
 return async function runDatabasePluginModel(prompts:Array<{role:string;content:string}>,signal?:AbortSignal,options:DatabasePluginGenerationOptions={}):Promise<DatabasePluginChatReply>{
	const ref=options.modelRef;
	const model=ref?dependencies.findModel(ref):dependencies.defaultModel();
	if(!model)throw new Error("数据库模型未配置或已不在梨园启用清单");
	const auth=await dependencies.auth(model);
	if(!auth.ok)throw new Error("数据库模型鉴权不可用");
	const payload=options.payload??{};
	const systemPrompt=prompts.filter(p=>p.role==="system").map(p=>p.content).join("\n\n");
	const messages=prompts.filter(p=>p.role!=="system").map((p:any)=>{
		if(p.role==="tool")return {role:"toolResult",toolCallId:p.tool_call_id,toolName:p.name||"table_edit",content:[{type:"text",text:p.content||""}],isError:false,timestamp:0};
		if(p.role==="assistant")return {role:"assistant",content:[...(p.content?[{type:"text",text:p.content}]:[]),...(Array.isArray(p.tool_calls)?p.tool_calls.map((t:any)=>({type:"toolCall",id:t.id,name:t.function?.name,arguments:JSON.parse(t.function?.arguments||"{}")})):[])],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:0};
		return {role:"user",content:[{type:"text",text:p.content||""}],timestamp:0};
	});
	const memoryHeaders={...(auth.headers??{})};if(!memoryHeaders["user-agent"]&&!memoryHeaders["User-Agent"])memoryHeaders["user-agent"]="Mozilla/5.0";
	const tools=Array.isArray(payload.tools)?payload.tools.map((t:any)=>({name:t.function.name,description:t.function.description||"",parameters:t.function.parameters})):undefined;
	if(tools?.length&&(model.compat as {supportsTools?:boolean}|undefined)?.supportsTools===false)throw new Error("所选数据库模型已声明不支持工具调用，请关闭原插件填表工具模式");
	options.validateBinding?.();
	const source=(dependencies.stream??streamSimple)(model as never,{systemPrompt,messages:messages as never,...(tools?.length?{tools:tools as never}:{})},{apiKey:auth.apiKey,headers:memoryHeaders,maxTokens:Math.min(model.maxTokens??16384,Math.max(256,Number(payload.max_tokens)||16384)),reasoning:"off",...(typeof payload.temperature==="number"?{temperature:payload.temperature}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),maxRetries:0});
	for await(const _event of source){}
	const result=await source.result();if(result.stopReason==="error"||result.stopReason==="aborted")throw new Error("数据库模型没有完成，本次记忆没有成功收据");
	const text=result.content.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"").join("");
	const reply=databasePluginChatReply(text,model.id);
	const calls=result.content.filter(part=>part.type==="toolCall").map(part=>part.type==="toolCall"?{id:part.id,type:"function",function:{name:part.name,arguments:JSON.stringify(part.arguments)}}:null).filter(Boolean);
	if(calls.length){reply.choices[0].message.tool_calls=calls;reply.choices[0].finish_reason="tool_calls";}
	reply.usage={prompt_tokens:result.usage.input,completion_tokens:result.usage.output,total_tokens:result.usage.totalTokens};return reply;
}

}
