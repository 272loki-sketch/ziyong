import assert from "node:assert/strict";
import test from "node:test";

import { defaultLiteraryWorldState, normalizeLiteraryWorldState } from "../src/stage/literary-world.ts";
import {
	changedWorldPaths,
	normalizeBeatFactEnvelope,
	normalizeWorldTransitionAudit,
	normalizeWorldTransitionProposal,
	worldAuditFromBranch,
	worldAuditEntry,
} from "../src/stage/literary-world-transition.ts";
import { defaultModularWorldState, moduleKindForId, projectLiteraryWorldV1 } from "../src/stage/literary-world-modular.ts";
import { defaultCardWorldProfile, manifestFromProfile, normalizeCardWorldProfile } from "../src/stage/literary-world-profile.ts";

const sources = { userText: "我把信递给她。", narrativeText: "她接过信，却没有当场拆开。" };
const envelopeInput = {
	evidence: [
		{ id: "ev_user", source: "latest-user", locator: "latest-user", quote: "我把信递给她" },
		{ id: "ev_text", source: "narrative", locator: "narrative", quote: "她接过信" },
	],
	facts: [
		{ id: "fact_give", kind: "action", subject: "用户", predicate: "把信递给她", actuality: "established", visibility: "limited", agency: "user-voluntary", evidenceIds: ["ev_user", "ev_text"] },
	],
	elapsed: { kind: "bounded", unit: "minute", min: 0, max: 1, evidenceIds: ["ev_user"] },
	triggerFactIds: ["fact_give"],
	uncertainties: [],
};

test("world transition：事实信封校验证据引文、用户主权与触发引用", () => {
	const valid = normalizeBeatFactEnvelope(envelopeInput, sources);
	assert.ok(valid.envelope);
	assert.equal(valid.envelope.facts[0]?.agency, "user-voluntary");
	const invented = normalizeBeatFactEnvelope({ ...envelopeInput, facts: [{ ...envelopeInput.facts[0], evidenceIds: ["ev_text"] }] }, sources);
	assert.equal(invented.envelope, undefined);
	assert.match(invented.errors.join("；"), /没有用户输入证据/);
	const badQuote = normalizeBeatFactEnvelope({ ...envelopeInput, evidence: [{ id: "ev_user", source: "latest-user", quote: "我烧掉了信" }] }, sources);
	assert.match(badQuote.errors.join("；"), /不在对应原文/);
	const emptyQuote = normalizeBeatFactEnvelope({ ...envelopeInput, evidence: [{ id: "ev_user", source: "latest-user", quote: "" }] }, sources);
	assert.match(emptyQuote.errors.join("；"), /缺少原文引文/);
});

test("world transition：计划和假设不能成为世界触发", () => {
	const result = normalizeBeatFactEnvelope({
		...envelopeInput,
		facts: [{ ...envelopeInput.facts[0], id: "fact_plan", actuality: "plan", agency: "none" }],
		triggerFactIds: ["fact_plan"],
	}, sources);
	assert.ok(result.envelope, "计划可以作为认识论事实保留，但不能进入触发清单");
	assert.deepEqual(result.envelope.triggerFactIds, []);
	assert.match(result.envelope.uncertainties.join("；"), /不能作为世界触发/);
});

test("world transition：提案只允许活跃模块、声明变化与满足 cadence", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({
		digest: "消息传播",
		modules: [{ id: "public-information", name: "消息传播", mode: "active", cadence: "on-trigger", confidence: 1 }],
	}, defaultCardWorldProfile("/tmp", "card.json", "卡", "x"))!;
	const manifest = manifestFromProfile(profile);
	const previous = defaultLiteraryWorldState();
	const proposal = normalizeWorldTransitionProposal({
		baseRound: 0,
		outcome: "changed",
		changes: [{ moduleId: "public-information", paths: ["winds", "digest"], factIds: ["fact_give"], reason: "有限知情" }],
		nextState: { ...previous, digest: "她已经收到信", winds: [{ id: "wind_letter", topic: "递信", type: "report", level: 1, content: "她收到一封信", scope: "当事人", source: "亲手递交" }] },
	}, previous, envelope, manifest, normalizeLiteraryWorldState);
	assert.ok(proposal.proposal);
	assert.equal(proposal.proposal.nextState.round, 1);
	assert.deepEqual(changedWorldPaths(previous, proposal.proposal.nextState).sort(), ["digest", "winds"]);

	const blocked = normalizeWorldTransitionProposal({
		baseRound: 0,
		changes: [{ moduleId: "war-front", paths: ["events"], factIds: ["fact_give"], reason: "无" }],
		nextState: { ...previous, events: [{ id: "war", name: "战争", type: "conflict", level: 4, stage: "已爆发", description: "战争爆发" }] },
	}, previous, envelope, manifest, normalizeLiteraryWorldState);
	assert.match(blocked.errors.join("；"), /未激活/);
});

test("world transition：短时间不满足日级模块，未声明变化原子拒绝", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({
		digest: "日历",
		modules: [{ id: "institution-calendar", name: "日历", mode: "active", cadence: "per-day", confidence: 1 }],
	}, defaultCardWorldProfile("/tmp", "card.json", "卡", "x"))!;
	const previous = defaultLiteraryWorldState();
	const result = normalizeWorldTransitionProposal({
		baseRound: 0,
		changes: [{ moduleId: "institution-calendar", paths: ["events"], factIds: ["fact_give"], reason: "推进一天" }],
		nextState: { ...previous, digest: "第二天", events: [{ id: "exam", name: "考试", type: "progress", level: 1, stage: "执行", description: "考试开始" }] },
	}, previous, envelope, manifestFromProfile(profile), normalizeLiteraryWorldState);
	assert.match(result.errors.join("；"), /未满足日级频率/);
	assert.match(result.errors.join("；"), /实际变化 digest 未在 changes 声明/);
});

test("world transition：独立审计不能一边 approve 一边报告 error", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const invalid = normalizeWorldTransitionAudit({ verdict: "approve", issues: [{ code: "secret-leak", severity: "error", factIds: ["fact_give"], message: "泄密" }], summary: "通过" }, envelope);
	assert.equal(invalid.audit, undefined);
	const valid = normalizeWorldTransitionAudit({ verdict: "reject", issues: [{ code: "causal-gap", severity: "error", factIds: ["fact_give"], message: "因果不足" }], summary: "拒绝" }, envelope);
	assert.equal(valid.audit?.verdict, "reject");
});

test("world transition：审计 wire 投影只暴露状态、摘要和 warning", () => {
	const entry = worldAuditEntry({ status: "committed", narrativeEntryId: "n1", baseRound: 1, nextRound: 2, baseStateHash: "x", errors: [], audit: { version: 1, verdict: "approve", summary: "因果成立", issues: [{ code: "other", severity: "warning", factIds: [], message: "保持克制" }] } });
	const view = worldAuditFromBranch([{ type: "custom", customType: "rp-world-audit", data: entry }]);
	assert.deepEqual(view?.warnings, ["保持克制"]);
	assert.equal(view?.summary, "因果成立");
	assert.equal("proposalHash" in (view ?? {}), false);
});

test("world transition v2：模块提案原子提交并派生兼容 v1 投影", async () => {
	const { normalizeModularWorldProposal, commitModularWorldTransition, worldTransitionHash } = await import("../src/stage/literary-world-transition.ts");
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({ digest: "消息", modules: [{ id: "public-information", name: "消息传播", mode: "active", cadence: "on-trigger", confidence: 1 }] }, defaultCardWorldProfile("/tmp", "card.json", "卡", "x"))!;
	const manifest = manifestFromProfile(profile), previous = defaultModularWorldState(manifest);
	const result = normalizeModularWorldProposal({ version: 2, baseRound: 0, baseStateHash: worldTransitionHash(previous), outcome: "changed", digest: "当事人已经收到信", moduleChanges: [{ moduleId: "public-information", baseRevision: 0, factIds: ["fact_give"], reason: "亲手递交", nextModule: { id: "public-information", kind: "social", summary: "消息仍局限于当事人", records: [{ id: "letter_received", facet: "wind", label: "递信", status: "report", summary: "她已收到信", visibility: "discoverable", attributes: { level: 1, scope: "当事人" }, originRefs: [], updatedRound: 1 }] } }], nextLinks: [] }, previous, envelope, manifest);
	assert.ok(result.proposal);
	const committed = commitModularWorldTransition(previous, result.proposal, "audit", manifest);
	assert.equal(committed.round, 1);
	assert.equal(committed.modules["public-information"]?.revision, 1);
	assert.equal(projectLiteraryWorldV1(committed).winds[0]?.topic, "递信");
	assert.equal(moduleKindForId("cultivation-system"), "rules");
});
