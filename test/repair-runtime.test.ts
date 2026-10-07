import assert from "node:assert/strict";
import test from "node:test";
import { configuredModels } from "../src/configured-models.ts";
import { classifyModelFailure, modelDiagnosticsView } from "../src/stage/model-failure.ts";
import { SafeReadRequestQueue, isSafeReadRequest, controlDeliveryType, isWireHandshakeStalled, WS_CONNECTING, WS_OPEN, WS_CLOSED } from "../web/src/ws-lifecycle.ts";
import { applyConfigPatch } from "../server/rest.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRealTest,listRealTests } from "../server/real-tests.ts";

test("启用配置过滤目录：同名历史/前缀模型不混入当前模型",()=>{
 const models=[{provider:"new",id:"gemini-3.7-flash"},{provider:"old",id:"gemini-3.7-flash"},{provider:"new",id:"build-gemini-3.7-flash"}];
 assert.deepEqual(configuredModels(models,{version:1,providers:{new:{models:[{id:"gemini-3.7-flash"}]}}}),[models[0]]);
 assert.deepEqual(configuredModels(models,{version:1,providers:{}}),models,"空配置保留首次引导，不误禁内置fixture");
});
test("鉴权/模型失效不盲重试，524/网络可通过明确恢复模型修复",()=>{
 assert.deepEqual(classifyModelFailure('401 invalid api key').kind,'auth');assert.equal(classifyModelFailure('401 invalid api key').retryable,false);
 assert.equal(classifyModelFailure('404 model not found').kind,'model');assert.equal(classifyModelFailure('524 read timeout').kind,'timeout');assert.equal(classifyModelFailure('524 read timeout').retryable,true);
 const view=modelDiagnosticsView([{phase:'agent.review',step:'directorReviewFacts',provider:'new',model:'gpt-5.6-luna',attempt:1,status:'failed',durationMs:120000,kind:'timeout',statusCode:524,reason:'524 https://private.example/key sk-abcdefghijk123456789',apiKey:'DO_NOT_LEAK',prompt:'DO_NOT_LEAK'}]);
 assert.ok(view);assert.doesNotMatch(JSON.stringify(view),/private\.example|abcdefghijk|DO_NOT_LEAK|apiKey|prompt/);
});
test("握手前只排队白名单只读查询；控制/写命令不能借此重放",()=>{
 const q=new SafeReadRequestQueue();assert.equal(q.enqueue('sessions'),true);assert.equal(q.enqueue('sessions'),false);assert.deepEqual(q.pendingFor('story'),['sessions']);
 assert.equal(q.enqueue('open'),false);assert.equal(q.enqueue('abort'),false);assert.equal(q.enqueue('assistant_model'),false);
 assert.equal(q.dispatch('sessions'),true);assert.equal(q.enqueue('sessions'),true);assert.equal(q.dispatch('sessions'),false,'上个读请求未返回时不能并发重发');
 assert.equal(q.response('sessions',true),'stale');assert.equal(q.dispatch('sessions'),true);assert.equal(q.response('sessions',true),'current');assert.equal(q.size,0);
 assert.equal(isSafeReadRequest('assistant_sessions'),true);assert.equal(controlDeliveryType('assistant_model'),'assistant_prompt');assert.equal(controlDeliveryType('open'),'prompt');
});
test("重连仅保留幂等读意图，并对无hello挂死连接触发watchdog",()=>{
 const q=new SafeReadRequestQueue();q.enqueue('assistant_sessions');q.dispatch('assistant_sessions');q.disconnect();assert.deepEqual(q.pendingFor('assistant'),['assistant_sessions']);
 assert.equal(isWireHandshakeStalled(WS_CONNECTING,false),true);assert.equal(isWireHandshakeStalled(WS_OPEN,false),true);assert.equal(isWireHandshakeStalled(WS_OPEN,true),false);assert.equal(isWireHandshakeStalled(WS_CLOSED,false),false);
});
test("预算与恢复路线配置有界，不能靠旧ask配置改变剧情",()=>{
 const c=applyConfigPatch(DEFAULT_CONFIG,{generationMode:'director',generationTimeoutMinutes:60,analysisTimeoutMinutes:10,analysisRecoveryModel:{provider:' new ',id:' gemini-3.7-flash '},allowDegradedGeneration:false});
 assert.equal(c.generationTimeoutMinutes,60);assert.equal(c.analysisTimeoutMinutes,10);assert.deepEqual(c.analysisRecoveryModel,{provider:'new',id:'gemini-3.7-flash'});assert.equal(c.allowDegradedGeneration,false);
 const bad=applyConfigPatch(DEFAULT_CONFIG,{generationTimeoutMinutes:999999,analysisTimeoutMinutes:99999,analysisRecoveryModel:{apiKey:'SECRET'}});assert.equal(bad.generationTimeoutMinutes,120);assert.equal(bad.analysisTimeoutMinutes,30);assert.equal(bad.analysisRecoveryModel,undefined);
});
test("记录入口跨当前卡可发现、只读且拒绝路径穿越",()=>{
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-record-fixture-'));try{
  mkdirSync(join(cwd,'.liyuan','real-tests'),{recursive:true});writeFileSync(join(cwd,'.liyuan','real-tests','sample.json'),JSON.stringify({id:'sample',readOnly:true,title:'真实测试',cardName:'另一个卡',createdAt:'2026-10-06',messages:[{channel:'narrative',text:'正文'}]}));
  assert.equal(listRealTests(cwd).length,1);assert.equal(readRealTest(cwd,'sample')?.readOnly,true);assert.equal(readRealTest(cwd,'../secret'),null);assert.equal(readRealTest(cwd,'x%2f..'),null);assert.equal(readRealTest(cwd,'absent'),null);
 }finally{rmSync(cwd,{recursive:true,force:true})}
});

test("诊断保留已验证format分类并区分交付校验与API请求失败",()=>{
 const rows=modelDiagnosticsView([{phase:"curtain",step:"writer",provider:"fixture",model:"fixture",attempt:1,status:"failed",kind:"format",reason:"遗漏本拍适用格式",durationMs:0,validationOnly:true}]);
 assert.equal(rows?.[0]?.kind,"format");assert.equal(rows?.[0]?.validationOnly,true);
});
