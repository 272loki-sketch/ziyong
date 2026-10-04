// Compact node:test reporter for remote CI inspection. Exit status remains node:test's.
import { inspect } from 'node:util';

const DETAIL_LIMIT = 600;
const DETAIL_BUDGET = 24_000;

export default async function* report(events) {
  let passed = 0;
  let failed = 0;
  let detailChars = 0;
  const failures = [];

  for await (const event of events) {
    if (event.type === 'test:pass') passed++;
    if (event.type === 'test:fail') {
      failed++;
      const { name, file, line, details } = event.data;
      const location = [file, line].filter(Boolean).join(':');
      const rendered = inspect(details?.error, {
        depth: 4,
        colors: false,
        maxArrayLength: 10,
        maxStringLength: 500,
      });
      const available = Math.max(0, Math.min(DETAIL_LIMIT, DETAIL_BUDGET - detailChars));
      const detail = available > 0 ? rendered.slice(0, available) : '';
      detailChars += detail.length;
      failures.push({ name, location, detail });
    }
  }

  for (const [index, failure] of failures.entries()) {
    yield `FAIL ${index + 1}/${failures.length} ${failure.name}\n${failure.location}${failure.detail ? `\n${failure.detail}` : '\n(detail budget exhausted; name and location retained)'}\n`;
  }
  yield `RESULT passed=${passed} failed=${failed}\n`;
}
