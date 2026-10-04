# SYNTHETIC session fixtures

`before-compaction.jsonl` and `large-session.jsonl` are algorithmically generated
**SYNTHETIC** test data, not recorded conversations and not redacted transcripts.
All user/assistant text blocks start with `SYNTHETIC: ` for privacy-gate checks.
Every message, reasoning placeholder, tool argument/result, compaction summary,
identifier, timestamp, working directory, and usage value is invented. There are
no imports from actual sessions, previous fixture payloads, or private data.

Their numeric profiles preserve the previous fixtures' scale and structural
coverage without carrying forward any original dialogue or personal identifier:

| Fixture | JSONL rows | Message rows | Users | Assistants | Tool results | Tool calls | Thinking blocks | Compactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `before-compaction.jsonl` | 1003 | 990 | 55 | 484 | 448 | 454 | 49 | 2 |
| `large-session.jsonl` | 1019 | 914 | 88 | 453 | 373 | 391 | 1 | 0 |

The first profile also has three synthetic bash-execution messages, five model
changes and five thinking-level changes. The second has one model change and
103 thinking-level changes. Both retain text and array user content, all four
coding tools (`read`, `bash`, `write`, `edit`), error tool results, deliberately
unanswered parallel calls, and 64-KiB tool-result payloads. Reported usage is
artificial and sufficiently large to exercise compaction preparation.

The files use the legacy **v1 flat session format**, with a fixed artificial
2000-01-01 epoch. Their header explicitly records `provenance.kind: SYNTHETIC`.
Paths are relative and start with `SYNTHETIC`, never a real user's directory.
Provider/model strings are public schema identifiers, not evidence of an API
request or a real model conversation. No credentials or signatures are present.

`compaction.test.ts` consumes `large-session.jsonl` as before, with unchanged
assertions. `synthetic-session-fixtures.test.ts` additionally verifies both
profiles, byte-for-byte reproducibility, allowed string values and synthetic
path boundaries, tool-call/result relationships, migration (including legacy
compaction indices), compaction preparation, and derived sibling branches.
The flat fixture itself does not claim to contain a real branch history.

## Reproduce and check

From the repository root, using Node >= 22.19.0 and installed local dependencies:

```sh
node packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts
node packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts --check
npm --prefix packages/coding-agent test -- test/compaction.test.ts test/synthetic-session-fixtures.test.ts
```

The generator is deterministic, has no network or randomness, writes only these
two filenames, and does not write when imported by tests. The `--check` mode
reads only the generated files and performs no writes. Online LLM integration
cases in the pre-existing compaction suite require credentials and are outside
the offline fixture verification; keep them disabled when doing privacy work.
Do not replace these fixtures with captured user/session data.
