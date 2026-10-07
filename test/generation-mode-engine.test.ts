import { presentationFixtureReply } from "./support/agent-presentation-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@liyuan/agent-runtime";
import { StageEngine, type StageStreamFn } from "../src/stage/engine.ts";
import { applyConfigPatch } from "../server/rest.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { DIRECTOR_ROLES } from "../src/stage/agent-director.ts";
import { toWireMsg } from "../server/wire.ts";

const normalDirector = JSON.stringify({ scenePressure: "既有事务", characterInitiatives: [{ character: "云澜", motive: "一起核对账目", immediateIntent: "取出账本", limit: "依据已知事实" }], candidateBeats: ["既有场景继续"] });
const emptyReport = JSON.stringify({ summary: "依据现有材料完成", facts: [], inferences: [], candidates: [], issues: [] });
const consult = (phase: keyof typeof DIRECTOR_ROLES) => ({ calls: [{ name: "consult_experts", args: { tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "本拍报告" })) } }] });
const directorScript = (body: string) => [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: body }, consult("review"), { calls: [{ name: "finalize" }] }];
function fixture(mode: "direct" | "director", responses: any[], options: { ecology?: boolean; sideStreaming?: boolean; supportsTools?: boolean; databasePluginMemory?: {enabled():boolean;before(text:string):Promise<Array<{tag:string;kind:"digest";text:string}>>;after(id?:string):Promise<void>;recentHistoryMessages():number} } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-dual-engine-"));
	writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "谨慎的同门", first_mes: "你来了。" } }));
	mkdirSync(join(cwd, ".liyuan"));
	cpSync(new URL("../skills/", import.meta.url), join(cwd, "skills"), { recursive: true });
	const steps = ["literaryDirector", "literaryContinuity", "directorSetting", "directorIdeas", "directorReviewFacts", "directorReviewStyle", "ecologyRuntime", "scribe"];
	const config = { card: "card.json", userName: "沈舟", generationMode: mode, literaryQuality: "guided", literaryEcologyEnabled: options.ecology === true, stepModels: Object.fromEntries(steps.map(id => [id, { provider: "faux", id }])) };
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify(config));
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const requests: any[] = []; let ledgerFail = false;
	const model = { id: "writer", provider: "faux", maxTokens: 10000, compat: {
		...(options.sideStreaming === undefined ? {} : { streaming: options.sideStreaming }),
		...(options.supportsTools === undefined ? {} : { supportsTools: options.supportsTools }),
	} };
	const streamFn: StageStreamFn = (m, context) => {
		requests.push({ model: m.id, compat: { ...((m.compat as { streaming?: boolean } | undefined) ?? {}) }, context });
		let response: any;
		if (m.id === "writer") response = presentationFixtureReply(context) ?? responses.shift();
		else if (m.id === "literaryDirector") response = { text: normalDirector };
		else if (m.id === "scribe") response = ledgerFail ? { text: "bad ledger" } : { text: JSON.stringify({ patch: { location: "书房" } }) };
		else if (m.id === "ecologyRuntime" && options.ecology) {
			const userMessage = context.messages.find((x: any) => x.role === "user") as any;
			const payload = JSON.parse(userMessage?.content?.find((x: any) => x.type === "text")?.text ?? "{}");
			if (payload.phase === "aftermath") {
				const saved = sm.getBranch().find((e: any) => e.id === payload.latest_turn.narrative_entry_id) as any;
				assert.equal(saved?.message?.details?.rpNarrative, payload.latest_turn.narrative, "trusted narrative must already be saved on the active branch");
				const disk = readFileSync(sm.getSessionFile()!, "utf8");
				assert.ok(disk.includes(payload.latest_turn.narrative_entry_id), "trusted source must have been flushed before ecology requests");
				response = { text: JSON.stringify({ occurrences: [{ id: "library", name: "整理图书", userRole: "committed", userCommitment: { source: "narrative", sourceEntryId: saved.id, occurrenceId: "library", quote: payload.latest_turn.narrative } }] }) };
			} else response = { text: emptyReport };
		} else response = { text: emptyReport };
		if (!response) throw new Error(`unexpected request: ${m.id}`);
		const message: any = { role: "assistant", content: response.calls ? response.calls.map((c: any, i: number) => ({ type: "toolCall", id: `call-${requests.length}-${i}`, name: c.name, arguments: c.args ?? {} })) : [{ type: "text", text: response.text ?? "" }], stopReason: response.aborted ? "aborted" : response.calls ? "toolUse" : "stop", usage: { input: 10, output: 10 } };
		return { async *[Symbol.asyncIterator]() { if (response.text) yield { type: "text_delta", delta: response.text }; yield { type: "done", message }; }, async result() { return message; } } as never;
	};
	const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model, findModel: (provider, id) => ({ ...model, provider, id }), getAuth: async () => ({}), streamFn, ...(options.databasePluginMemory ? {databasePluginMemory:options.databasePluginMemory} : {}) });
	return { cwd, sm, requests, engine, setLedgerFail: (value: boolean) => { ledgerFail = value; }, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
const replies = (sm: any) => sm.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant");

test("直出模式保留正常文学导演，读旧记忆生态，正文为普通文本且无画像/脑暴/审稿", async () => {
	const text = '“第二天再谈。”沈舟走向教室的窗边。' + "他继续说明桌上的账目。".repeat(27);
	const f = fixture("direct", [{ text }]);
	try {
		await f.engine.performTurn("继续。");
		assert.deepEqual(f.requests.map(x => x.model), ["literaryDirector", "writer", "scribe", "writer", "writer"]);
		const writer = f.requests.find(x => x.model === "writer");const payload = JSON.stringify(writer.context);
		assert.match(payload, /本拍文学导演候选/);assert.match(payload, /一起核对账目/);
		assert.doesNotMatch(payload, /Sogon|用户偏好参考|本拍还没有计划|每个路标落笔前/);
		assert.ok(!writer.context.tools?.some((x: any) => ["draft_append", "beat_plan", "ask"].includes(x.name)));
		const entry = replies(f.sm)[0];assert.equal(entry.message.details.rpNarrative, text);assert.equal(entry.message.details.rpGenerationMode, "direct");
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-state" && e.data.location === "书房"));
		const wire = toWireMsg(entry.message, { charName: "云澜", userName: "沈舟" });assert.equal(wire?.generationMode, "direct");assert.equal(wire?.generationWorkflow?.mode, "direct");
	} finally { f.cleanup(); }
});

test("完整导演每拍固定3/2/2，无独立文学导演及心理画像，唯主writer文字落树", async () => {
	const f = fixture("director", directorScript("同一个作者完成的定稿。"));
	try {
		await f.engine.performTurn("只是继续聊聊。");
		assert.equal(f.requests.filter(x => x.model !== "writer" && x.model !== "scribe").length, 7);
		assert.equal(f.requests.filter(x => x.model === "literaryDirector").length, 0);
		assert.equal(f.requests.filter(x => x.model === "directorIdeas").length, 2);
		const reply = replies(f.sm)[0];assert.equal(reply.message.details.rpNarrative, "同一个作者完成的定稿。");
		assert.deepEqual(reply.message.details.rpGenerationWorkflow.stages.filter((x: any) => ["evidence", "ideas", "review"].includes(x.stage)).map((x: any) => x.calls), [3, 2, 2]);
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-turn-settlement" && e.data.status === "complete"));
	} finally { f.cleanup(); }
});

test("每条输入模式固定，下一条可切换，同一会话事实账本继续使用", async () => {
	const f = fixture("direct", [{ text: "直出原文。" }, ...directorScript("导演新原文。")]);
	try {
		await f.engine.performTurn("第一拍。", { generationMode: "direct" });
		await f.engine.performTurn("第二拍。", { generationMode: "director" });
		assert.deepEqual(replies(f.sm).map((x: any) => x.message.details.rpGenerationMode), ["direct", "director"]);
		const secondWriter = f.requests.filter(x => x.model === "writer")[1];assert.match(JSON.stringify(secondWriter.context), /直出原文/);assert.match(JSON.stringify(secondWriter.context), /书房/);
	} finally { f.cleanup(); }
});

test("未结算半稿保留，下一输入之前先恢复账本，不能用旧位置开新拍", async () => {
	const f = fixture("direct", [{ text: "沈舟来到书房。", aborted: true }, { text: "他继续核对账目。" }]);
	try {
		await f.engine.performTurn("先进去。");
		assert.equal(replies(f.sm)[0].message.stopReason, "aborted");assert.equal(f.requests.filter(x => x.model === "scribe").length, 0);
		await f.engine.performTurn("继续。");
		const writer = f.requests.filter(x => x.model === "writer")[1];assert.match(JSON.stringify(writer.context), /书房/);
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-turn-settlement" && e.data.recovered === true));
	} finally { f.cleanup(); }
});

test("恢复失败时新输入不落树不发送ACK，修复后可继续", async () => {
	const f = fixture("direct", [{ text: "保留的半稿", aborted: true }, { text: "恢复后的新正文" }]);
	try {
		await f.engine.performTurn("开始。");f.setLedgerFail(true);let accepted = 0;
		await f.engine.performTurn("不应受理的新输入", { clientMessageId: "pending-input", onAccepted: () => accepted++ });
		assert.equal(accepted, 0);assert.ok(!JSON.stringify(f.sm.getBranch()).includes("不应受理的新输入"));
		f.setLedgerFail(false);await f.engine.performTurn("恢复后继续。");assert.equal(replies(f.sm).length, 2);
	} finally { f.cleanup(); }
});

test("新模式配置不再写回ask/profile/guided旧创作开关", () => {
	const next = applyConfigPatch({ ...DEFAULT_CONFIG, creationMode: "ask", literaryQuality: "guided" } as never, { generationMode: "direct" });
	assert.equal(next.generationMode, "direct");assert.equal(Object.hasOwn(next, "creationMode"), false);assert.equal(next.literaryQuality, undefined);assert.equal(next.literaryProfileEveryNTurns, undefined);
	assert.equal(applyConfigPatch(DEFAULT_CONFIG, { generationMode: "unknown" }).generationMode, "director");
});


test("已结算领域的checkpoint恢复不重复记账或推进世界", async () => {
	const f = fixture("direct", [{ text: "第一拍完整正文。" }, { text: "第二拍完整正文。" }]);
	try {
		await f.engine.performTurn("第一拍。");
		const id = replies(f.sm)[0].id;
		f.sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: id, status: "settling", ledgerDone: true, worldDone: true, ecologyDone: true }); f.sm.flush();
		const before = f.requests.filter(x => x.model === "scribe").length;
		await f.engine.performTurn("第二拍。");
		assert.equal(f.requests.filter(x => x.model === "scribe").length, before + 1, "只结算第二拍，不重复累计第一拍");
	} finally { f.cleanup(); }
});

test("旧配置和旧客户端均不能重新启用 creationMode ask", () => {
	const next = applyConfigPatch({ ...DEFAULT_CONFIG, creationMode: "ask" } as never, { creationMode: "ask", scanDepth: 7 });
	assert.equal(Object.hasOwn(next, "creationMode"), false);
	assert.equal(next.scanDepth, 7);
});


test("新模式生态在正文落树并flush后核验角色承诺，恢复半稿也绑定真实正文id", async () => {
	for (const stopped of [false, true]) {
		const body = "沈舟答应明天去图书馆帮忙。";
		const f = fixture("direct", [{ text: body, ...(stopped ? { aborted: true } : {}) }, { text: "然后继续手上的工作。" }], { ecology: true });
		try {
			await f.engine.performTurn("继续");
			if (stopped) await f.engine.performTurn("接着来");
			const snapshots = f.sm.getBranch().filter((e: any) => e.customType === "rp-ecology-state");
			const accepted = snapshots.find((e: any) => e.data.occurrences.some((o: any) => o.userCommitment?.quote === body));
			assert.ok(accepted, "ordinary settlement and recovery must both accept the saved fictional commitment");
			assert.equal((accepted as any).data.occurrences[0].userRole, "committed");
			assert.equal((accepted as any).data.occurrences[0].userCommitment.sourceEntryId, replies(f.sm)[0].id);
		} finally { f.cleanup(); }
	}
});


test("直出卡嵌套main_output/content且末尾格式截断仍保存和结算正文", async () => {
	const body = "沈舟把练习册推到桌子另一边。云澜圈出了被忽略的条件。";
	const f = fixture("direct", [{ text: `<main_output><content><time>午休</time>${body}<image><imgthink>未完成的格式` }]);
	try {
		await f.engine.performTurn("继续讨论题目。", { generationMode: "direct" });
		assert.equal(replies(f.sm)[0]?.message.details.rpNarrative, body);
		assert.ok(f.requests.some(x => x.model === "scribe"), "不能把已写成正文报告为空稿而跳过结算");
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-turn-settlement" && e.data.status === "complete"));
	} finally { f.cleanup(); }
});


test("结构化旁路尊重原模型流式配置，不无条件改为非流式", async () => {
	for (const sideStreaming of [undefined, true, false]) {
		const f = fixture("direct", [{ text: "保存正常正文。" }], { sideStreaming });
		try {
			await f.engine.performTurn("继续。");
			const director = f.requests.find(x => x.model === "literaryDirector");
			const scribe = f.requests.find(x => x.model === "scribe");
			assert.equal(director?.compat.streaming, sideStreaming);
			assert.equal(scribe?.compat.streaming, sideStreaming);
		} finally { f.cleanup(); }
	}
});

test("恢复不永久沿用旧world失败标记，已提交领域不重复模型调用", async()=>{
 const f=fixture("direct",[{text:"已经保存的正文。"},{text:"下一拍正常正文。"}]);try{
  await f.engine.performTurn("开始。",{generationMode:"direct"});const id=replies(f.sm)[0].id;
  f.sm.appendCustomEntry("rp-world-state",{version:2,round:1,digest:"已提交",kernel:{lastAuditHash:"abc",links:[]},modules:{},_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry("rp-turn-settlement",{version:1,narrativeEntryId:id,status:"pending",ledgerDone:true,worldDone:false,ecologyDone:true,degradedDomains:["world"]});f.sm.flush();
  const before=f.requests.length;const result=await f.engine.retryPendingSettlement();assert.equal(result.error,undefined);assert.equal(f.requests.length,before,"已提交领域的收据修复不再烧API");
  const receipt=[...f.sm.getBranch()].reverse().find((e:any)=>e.customType==="rp-turn-settlement")?.data as any;assert.equal(receipt.status,"complete");assert.deepEqual(receipt.degradedDomains,[]);assert.equal(receipt.worldDone,true);
 }finally{f.cleanup()}
});


test("模型工具能力默认支持，显式勾选仍保留原生工具通道", async () => {
	for (const supportsTools of [undefined, true]) {
		const f = fixture("direct", [{ text: "合成默认工具正文。" }], { supportsTools });
		try {
			await f.engine.performTurn("合成输入。");
			const writer = f.requests.find(x => x.model === "writer");
			assert.ok(writer.context.tools?.length > 0);
			assert.equal(replies(f.sm)[0].message.details.rpGenerationWorkflow.toolFallback, false);
		} finally { f.cleanup(); }
	}
});

test("取消支持工具调用后，直出实际请求无tools且保持当前模型", async () => {
	const f = fixture("direct", [{ text: "合成纯文本正文。" }], { supportsTools: false });
	try {
		await f.engine.performTurn("合成输入。");
		const writer = f.requests.filter(x => x.model === "writer");
		assert.ok(writer.length > 0);
		for (const request of writer) assert.equal(Object.hasOwn(request.context, "tools"), false);
		const workflow = replies(f.sm)[0].message.details.rpGenerationWorkflow;
		assert.equal(workflow.mode, "direct");
		assert.equal(workflow.toolFallback, true);
		assert.equal(workflow.toolFallbackReason, "configured");
		assert.equal(replies(f.sm)[0].message.details.rpNarrative, "合成纯文本正文。");
	} finally { f.cleanup(); }
});

test("取消支持工具调用后，导演仍执行固定3/2/2而不切直出", async () => {
	const f = fixture("director", [
		{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "合成角度一" }, { role: "idea-b", task: "合成角度二" }] }) },
		{ text: "合成无原生工具的导演正文。" }, { text: '{"decision":"keep"}' },
	], { supportsTools: false });
	try {
		await f.engine.performTurn("合成输入。");
		for (const request of f.requests) assert.equal(Object.hasOwn(request.context, "tools"), false);
		const reply = replies(f.sm)[0];
		assert.equal(reply.message.details.rpNarrative, "合成无原生工具的导演正文。");
		const workflow = reply.message.details.rpGenerationWorkflow;
		assert.equal(workflow.mode, "director");
		assert.equal(workflow.toolFallbackReason, "configured");
		assert.deepEqual(workflow.stages.filter((x: any) => ["evidence", "ideas", "review"].includes(x.stage)).map((x: any) => x.calls), [3, 2, 2]);
		assert.equal(f.requests.filter(x => !["writer", "scribe"].includes(x.model)).length, 7);
	} finally { f.cleanup(); }
});


test("原数据库接线：拍前投送、已落树规范正文拍后整理、旧自动压缩不再双写", async () => {
	const body='青梧把铜钥匙收好，记下了未兑现的归还约定。'+"两人确认了眼前的安排。".repeat(25);
	const calls: string[]=[];let f:ReturnType<typeof fixture>;
	f=fixture("direct",[{text:body}],{databasePluginMemory:{enabled:()=>true,before:async text=>{calls.push("before");assert.equal(text,"继续。");return[{tag:"original-plugin",kind:"digest",text:"合成插件记忆：旧约定仍未兑现"}]},after:async id=>{calls.push("after");const entry=f.sm.getBranch().find(e=>e.id===id) as any;assert.equal(entry.message.details.rpNarrative,body);},recentHistoryMessages:()=>12}});
	try{await f.engine.performTurn("继续。");assert.deepEqual(calls,["before","after"]);assert.ok(JSON.stringify(f.requests.find(r=>r.model==="writer").context).includes("合成插件记忆"));assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-database-memory"&&e.data.status==="complete"));assert.ok(!f.requests.some(r=>r.model==="compaction"||r.model==="memoryEvents"));assert.deepEqual(await f.engine.compactNow(),{kind:"skipped",reason:"upstream-plugin-managed"});}finally{f.cleanup()}
});

test("原数据库失败不重写已保存故事：留下pending并在下一拍前恢复一次", async () => {
	const first='青梧收下铜钥匙，承诺明日归还。'+"两人确认了眼前的安排。".repeat(25),second='青梧核对了昨天的约定，没有把它当作已经兑现。'+"她继续说明归还的安排。".repeat(25);
	let fail=true;const ids:string[]=[];
	const f=fixture("direct",[{text:first},{text:second}],{databasePluginMemory:{enabled:()=>true,before:async()=>[],after:async id=>{ids.push(id!);if(fail){fail=false;throw new Error("synthetic memory failure")}},recentHistoryMessages:()=>12}});
	try{await f.engine.performTurn("收下钥匙。");const saved=replies(f.sm)[0];assert.equal(saved.message.details.rpNarrative,first);assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-database-memory"&&e.data.status==="pending"));await f.engine.performTurn("核对约定。");assert.equal(replies(f.sm).length,2);assert.deepEqual(ids.slice(0,2),[saved.id,saved.id]);assert.equal(ids.length,3);}finally{f.cleanup()}
});
