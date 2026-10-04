#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SESSION_FIXTURE_PATHS = [
  'packages/coding-agent/test/fixtures/before-compaction.jsonl',
  'packages/coding-agent/test/fixtures/large-session.jsonl',
];

// Match only absolute home-directory prefixes. The captured user segment is
// checked separately so conventional placeholders and system-shared profiles
// remain valid in documentation examples.
const HOME_PATH_PATTERN = /(?:^|[^\p{L}\p{N}_.-])(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/)(<[^<>/]+>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|\{[^{}\/]+\}|\[[^\[\]\/]+\]|[^\\/\s"'`<>]+)/giu;
const PROVENANCE_MARKER = /\bsynthetic(?:[-_ ](?:fixture|data|source))?\b/i;
const ROLE_TEXT_MARKER = /^\s*(?:\[\s*synthetic(?:[-_ ]+[a-z0-9_-]+)*\s*\]|<synthetic(?:-[a-z0-9_-]+)*>|synthetic(?:[-_][a-z0-9_-]+)*(?:\s*[:—-]|\s+|$))/i;
const ROLE_TEXT_KEYS = new Set([
  'content', 'text', 'parts', 'message',
  'thinking', 'thought', 'reasoning', 'reasoning_content', 'reasoning_details',
  'analysis', 'analysis_text', 'transcript', 'transcription', 'summary', 'refusal',
]);

function isPlaceholderUserSegment(value) {
  const segment = value.replace(/[.,;:!?)}\]]+$/u, '').trim();
  const lower = segment.toLowerCase();

  if (!segment) return true;
  if (/^<[^<>/]+>$/u.test(segment)) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/u.test(segment)) return true;
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(segment)) return true;
  if (/^\{[^{}\/]+\}$/u.test(segment) || /^\[[^\[\]\/]+\]$/u.test(segment)) return true;
  if (/^\([^()/]+\)$/u.test(segment)) return true;

  if (new Set([
    'username', 'user_name', 'user-name', 'yourname', 'your_name',
    'your-name', 'yourusername', 'your_username', 'your-username', 'your-user',
    'exampleuser', 'example_user', 'example-user',
    'sampleuser', 'sample_user', 'sample-user',
    'testuser', 'test_user', 'test-user',
    'placeholderuser', 'placeholder_user', 'placeholder-user', 'user-placeholder',
    'redacted', 'redacted-user', 'anonymous', 'anonymous-user',
    // These are OS-provided shared/default profiles, not a personal home.
    'shared', 'public', 'default', 'default user', 'all users', 'guest',
    'defaultuser0', 'wdagutilityaccount',
  ]).has(lower)) return true;

  return false;
}

/**
 * Count non-placeholder home-directory paths without returning their contents.
 * This is intentionally pure and safe to call from tests with synthetic data.
 */
export function countUngeneralizedHomePaths(text) {
  let count = 0;
  HOME_PATH_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(HOME_PATH_PATTERN)) {
    if (!isPlaceholderUserSegment(match[1])) count += 1;
  }
  return count;
}

function collectContentText(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectContentText(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (ROLE_TEXT_KEYS.has(key.toLowerCase())) collectContentText(item, output);
      else if (['content', 'parts', 'message'].includes(key.toLowerCase())) {
        collectContentText(item, output);
      }
    }
  }
  return output;
}

function collectRoleText(value) {
  const output = [];
  for (const [key, item] of Object.entries(value)) {
    if (ROLE_TEXT_KEYS.has(key.toLowerCase())) collectContentText(item, output);
  }
  return output;
}

function hasSyntheticProvenance(record, withinProvenance = false) {
  if (!record || typeof record !== 'object') return false;
  if (Array.isArray(record)) return record.some((item) => hasSyntheticProvenance(item, withinProvenance));

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'synthetic' && value === true) return true;
    if (typeof value === 'string'
      && (['provenance', 'source', 'origin', 'fixture', 'type'].includes(normalizedKey)
        || (withinProvenance && ['kind', 'generator'].includes(normalizedKey)))
      && PROVENANCE_MARKER.test(value)) return true;
    if (['provenance', 'source', 'origin', 'fixture', 'metadata', 'meta'].includes(normalizedKey)
      && value && typeof value === 'object'
      && hasSyntheticProvenance(value, true)) return true;
  }
  return false;
}
function inspectJsonValue(value, state) {
  if (typeof value === 'string') {
    state.homePathCount += countUngeneralizedHomePaths(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) inspectJsonValue(item, state);
    return;
  }

  if (!value || typeof value !== 'object') return;

  const isRoleMessage = typeof value.role === 'string' && value.role.trim().length > 0;
  if (isRoleMessage) {
    state.roleMessageCount += 1;
    const textParts = collectRoleText(value).map((part) => part.trim()).filter(Boolean);
    if (textParts.length > 0) {
      state.textRoleMessageCount += 1;
      if (textParts.some((part) => !ROLE_TEXT_MARKER.test(part))) {
        state.unmarkedRoleMessageCount += 1;
      }
    }
  }

  for (const [key, item] of Object.entries(value)) {
    state.homePathCount += countUngeneralizedHomePaths(key);
    inspectJsonValue(item, state);
  }
}

/** Analyze JSONL without exposing source strings or path matches in the result. */
export function analyzeSessionFixtureJsonl(text) {
  const state = {
    homePathCount: 0,
    invalidJsonLineCount: 0,
    hasSyntheticProvenance: false,
    roleMessageCount: 0,
    textRoleMessageCount: 0,
    unmarkedRoleMessageCount: 0,
  };

  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      state.invalidJsonLineCount += 1;
      continue;
    }
    if (hasSyntheticProvenance(record)) state.hasSyntheticProvenance = true;
    inspectJsonValue(record, state);
  }

  return state;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error('git-discovery-failed');
  }
  return result.stdout;
}

function trackedFiles(repoRoot, pathspecs) {
  const output = runGit(['ls-files', '-z', '--', ...pathspecs], repoRoot);
  return output.split('\0').filter(Boolean);
}

function emitFailure(filePath, category, count = 1) {
  // Never print file contents, matched fragments, or raw process errors.
  console.error(`${filePath}: ${category} (${count})`);
}

function scanTrackedFile(repoRoot, relativePath, isSessionFixture) {
  const absolutePath = path.join(repoRoot, relativePath);

  try {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      emitFailure(relativePath, 'unsafe-file-type');
      return 1;
    }
    const resolved = realpathSync(absolutePath);
    if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)) {
      emitFailure(relativePath, 'outside-repository');
      return 1;
    }
    const contents = readFileSync(absolutePath, 'utf8');

    if (!isSessionFixture) {
      const count = countUngeneralizedHomePaths(contents);
      if (count > 0) {
        emitFailure(relativePath, 'ungeneralized-home-path', count);
        return count;
      }
      return 0;
    }

    const result = analyzeSessionFixtureJsonl(contents);
    let findings = 0;
    if (result.invalidJsonLineCount > 0) {
      emitFailure(relativePath, 'invalid-jsonl-line', result.invalidJsonLineCount);
      findings += result.invalidJsonLineCount;
    }
    if (result.homePathCount > 0) {
      emitFailure(relativePath, 'ungeneralized-home-path', result.homePathCount);
      findings += result.homePathCount;
    }
    if (!result.hasSyntheticProvenance) {
      emitFailure(relativePath, 'missing-synthetic-provenance');
      findings += 1;
    }
    if (result.roleMessageCount === 0 || result.textRoleMessageCount === 0) {
      emitFailure(relativePath, 'missing-role-message-text');
      findings += 1;
    }
    if (result.unmarkedRoleMessageCount > 0) {
      emitFailure(relativePath, 'unmarked-role-message-text', result.unmarkedRoleMessageCount);
      findings += result.unmarkedRoleMessageCount;
    }
    return findings;
  } catch {
    emitFailure(relativePath, 'read-failed');
    return 1;
  }
}

async function verifyFixtureGenerator(repoRoot) {
  const generatorFile = path.join(
    repoRoot,
    'packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts',
  );
  const expectedNames = SESSION_FIXTURE_PATHS.map((filePath) => path.basename(filePath));
  let generator;
  try {
    // Node >=22.19 (the repository baseline) natively loads this erasable TS module.
    generator = await import(pathToFileURL(generatorFile).href);
  } catch {
    emitFailure('packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts', 'synthetic-generator-load-failed');
    return 1;
  }

  if (typeof generator.generateFixture !== 'function'
    || !Array.isArray(generator.FIXTURE_NAMES)
    || generator.FIXTURE_NAMES.length !== expectedNames.length
    || expectedNames.some((name) => !generator.FIXTURE_NAMES.includes(name))) {
    emitFailure('packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts', 'synthetic-generator-contract');
    return 1;
  }

  let findings = 0;
  for (const filePath of SESSION_FIXTURE_PATHS) {
    try {
      const generated = generator.generateFixture(path.basename(filePath));
      const actualBytes = readFileSync(path.join(repoRoot, filePath));
      const generatedBytes = Buffer.from(generated, 'utf8');
      if (!actualBytes.equals(generatedBytes)) {
        emitFailure(filePath, 'synthetic-generator-byte-mismatch');
        findings += 1;
      }
    } catch {
      emitFailure(filePath, 'synthetic-generator-check-failed');
      findings += 1;
    }
  }
  return findings;
}

async function runCli() {
  let repoRoot;
  try {
    const rootOutput = runGit(['rev-parse', '--show-toplevel'], process.cwd());
    repoRoot = realpathSync(path.resolve(rootOutput.trim()));
    if (!repoRoot) throw new Error('missing-root');
  } catch {
    emitFailure('git', 'repository-discovery-failed');
    process.exitCode = 2;
    return;
  }

  let markdownFiles;
  let fixtureFiles;
  try {
    markdownFiles = trackedFiles(repoRoot, ['*.md']);
    fixtureFiles = SESSION_FIXTURE_PATHS.filter((filePath) => {
      return trackedFiles(repoRoot, [`:(literal)${filePath}`]).includes(filePath);
    });
  } catch {
    emitFailure('git', 'tracked-file-discovery-failed');
    process.exitCode = 2;
    return;
  }

  let findings = 0;
  for (const filePath of markdownFiles) {
    findings += scanTrackedFile(repoRoot, filePath, false);
  }

  if (fixtureFiles.length !== SESSION_FIXTURE_PATHS.length) {
    const missingCount = SESSION_FIXTURE_PATHS.length - fixtureFiles.length;
    emitFailure('session-fixtures', 'required-fixture-missing', missingCount);
    findings += missingCount;
  }
  for (const filePath of fixtureFiles) {
    findings += scanTrackedFile(repoRoot, filePath, true);
  }
  findings += await verifyFixtureGenerator(repoRoot);

  if (findings > 0) {
    console.error(`public-data-policy: failed (${findings})`);
    process.exitCode = 1;
  } else {
    console.log(`public-data-policy: passed (markdown=${markdownFiles.length}, fixtures=${fixtureFiles.length})`);
  }
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    emitFailure('public-data-policy', 'unexpected-gate-failure');
    process.exitCode = 1;
  });
}
