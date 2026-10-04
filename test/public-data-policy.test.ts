import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeSessionFixtureJsonl,
  countUngeneralizedHomePaths,
} from '../scripts/check-public-data.mjs';

test('flags Windows and macOS home paths with non-placeholder user segments', () => {
  assert.equal(countUngeneralizedHomePaths(String.raw`C:\Users\account-7\work\note.md`), 1);
  assert.equal(countUngeneralizedHomePaths('/Users/account-7/work/note.md'), 1);
  assert.equal(countUngeneralizedHomePaths('/Users/test/work/note.md'), 1);
});

test('allows explicit placeholders and non-personal shared/default profiles', () => {
  const examples = String.raw`C:\Users\<USERNAME>\repo /Users/$USER/project /Users/your-username/code C:\Users\%USERNAME%\docs /Users/Shared/files C:\Users\Public\Documents`;
  assert.equal(countUngeneralizedHomePaths(examples), 0);
});

test('detects escaped home paths in JSONL and rejects unmarked conversation text', () => {
  const lines = [
    JSON.stringify({ type: 'session', provenance: 'deterministic synthetic-fixture' }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'input_text', text: 'Please inspect C:\\Users\\account-7\\private.txt' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: 'Ordinary conversation without a synthetic marker.' },
    }),
  ].join('\n');

  const result = analyzeSessionFixtureJsonl(lines);
  assert.equal(result.invalidJsonLineCount, 0);
  assert.equal(result.homePathCount, 1);
  assert.equal(result.hasSyntheticProvenance, true);
  assert.equal(result.roleMessageCount, 2);
  assert.equal(result.unmarkedRoleMessageCount, 2);
});

test('accepts explicitly marked synthetic role text while retaining nested tool structure', () => {
  const assistantMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: '[SYNTHETIC assistant message] A generated response.' },
      { type: 'thinking', thinking: 'SYNTHETIC: generated thought.' },
      { type: 'reasoning', reasoning: 'SYNTHETIC: generated reasoning.' },
      { type: 'analysis', analysis: 'SYNTHETIC: generated analysis.' },
    ],
    tool_calls: [{ id: 'call-test', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  const original = JSON.stringify({ type: 'message', message: assistantMessage });
  const lines = [
    JSON.stringify({ type: 'session', provenance: 'SYNTHETIC deterministic test data' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '[SYNTHETIC] Generated input.' } }),
    original,
  ].join('\n');

  const result = analyzeSessionFixtureJsonl(lines);
  assert.equal(result.invalidJsonLineCount, 0);
  assert.equal(result.hasSyntheticProvenance, true);
  assert.equal(result.roleMessageCount, 2);
  assert.equal(result.textRoleMessageCount, 2);
  assert.equal(result.unmarkedRoleMessageCount, 0);
  assert.deepEqual(JSON.parse(original).message.tool_calls, assistantMessage.tool_calls);
});

test('rejects unmarked thinking or reasoning despite a synthetic visible answer', () => {
  const lines = [
    JSON.stringify({ type: 'session', provenance: { kind: 'SYNTHETIC' } }),
    JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'SYNTHETIC: generated input.' },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'SYNTHETIC: generated visible answer.' }],
        thinking: 'Unmarked hidden text.',
        reasoning: 'Also unmarked hidden text.',
      },
    }),
  ].join('\n');

  const result = analyzeSessionFixtureJsonl(lines);
  assert.equal(result.hasSyntheticProvenance, true);
  assert.equal(result.roleMessageCount, 2);
  assert.equal(result.unmarkedRoleMessageCount, 1);
});

test('does not infer synthetic provenance from a fixture-like payload or name', () => {
  const result = analyzeSessionFixtureJsonl(JSON.stringify({
    type: 'message',
    message: { role: 'user', content: '[SYNTHETIC] Generated input.' },
  }));
  assert.equal(result.hasSyntheticProvenance, false);
  assert.equal(result.roleMessageCount, 1);
});

test('reports malformed JSONL without echoing input', () => {
  const result = analyzeSessionFixtureJsonl('{"role":"user","content":"malformed"');
  assert.equal(result.invalidJsonLineCount, 1);
  assert.equal(result.homePathCount, 0);
});
