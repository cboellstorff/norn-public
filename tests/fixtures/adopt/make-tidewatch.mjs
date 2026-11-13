// META-ADOPT A5: the tidewatch-shaped fixture repo of the adopt end-to-end test (ported from the ADOPT-DESIGN mock tools/make-sample.mjs: a small
// Node CLI, 12 commits, 3 side branches; all text written for the mock). usage: node make-tidewatch.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const out = path.resolve(process.argv[2]);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const w = (rel, text) => { const f = path.join(out, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text.replace(/^\n/, '')); };
const git = (args, date) => execFileSync('git', args, { cwd: out, encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
const commit = (date, msg, files) => { git(['add', ...(files || ['-A'])]); git(['commit', '-q', '-m', msg], date); };

git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Maya Okafor']); git(['config', 'user.email', 'maya@example.org']); git(['config', 'core.autocrlf', 'false']); git(['config', 'commit.gpgsign', 'false']);
git(['remote', 'add', 'origin', 'https://github.com/example-org/tidewatch.git']);

w('README.md', `
# tidewatch

Tide tables in your terminal. \`tidewatch\` fetches harmonic constituents for a station once, then predicts high and low
water offline for any date.

    $ tidewatch next --station 9414290
    San Francisco, CA (9414290)
      Thu 12 Nov  03:41  low   0.42 m
      Thu 12 Nov  10:07  high  1.71 m
      Thu 12 Nov  16:32  low   0.18 m

## Install

    npm install -g tidewatch

Needs Node 20 or newer.

## Usage

- \`tidewatch next --station <id>\` - the next three turning points
- \`tidewatch day --station <id> --date 2026-11-14\` - one day's table
- \`tidewatch stations --near 37.8,-122.4\` - the nearest stations

## Goals

1. Correct to within 5 minutes and 3 cm of the published tables for every reference station.
2. Works offline after the first fetch.
3. Small: no native dependencies, starts in under 100 ms.

## Development

    npm ci
    npm test          # node --test, about 3 s
    npm run lint      # eslint

See CONTRIBUTING.md. Plans live in ROADMAP.md; small jobs in TODO.md.

## License

MIT
`);
w('package.json', `
{
  "name": "tidewatch",
  "version": "0.2.0",
  "description": "Tide tables in your terminal",
  "type": "module",
  "bin": { "tidewatch": "src/cli.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/",
    "lint": "eslint src test",
    "constituents": "node scripts/build-constituents.js"
  },
  "devDependencies": { "eslint": "^9.12.0" },
  "license": "MIT"
}
`);
w('.gitignore', 'node_modules/\n.cache/\n.env\n');
w('src/cli.js', `
#!/usr/bin/env node
import { predict } from './predict.js';
import { table } from './format.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = n => { const i = rest.indexOf('--' + n); return i < 0 ? null : rest[i + 1]; };
if (cmd === 'next' || cmd === 'day') {
  const station = flag('station');
  if (!station) { console.error('error: --station is required'); process.exit(2); }
  // TODO: --json output (TODO.md)
  console.log(table(predict(station, flag('date') ? new Date(flag('date')) : new Date(), cmd === 'day' ? 24 : 18)));
} else {
  console.error('usage: tidewatch next|day|stations ...');
  process.exit(2);
}
`);
w('src/predict.js', `
// Harmonic prediction: height(t) = Z0 + sum(A_i * cos(w_i * t + phase_i)). Heights in metres, times in UTC.
const SPEEDS = { M2: 28.9841042, S2: 30.0, N2: 28.4397295, K1: 15.0410686, O1: 13.9430356 };
export function height(consts, t) {
  const h = t / 3600000;
  return consts.z0 + consts.parts.reduce((s, p) => s + p.amp * Math.cos((SPEEDS[p.name] * h + p.phase) * Math.PI / 180), 0);
}
export function predict(station, from, hours) {
  const consts = load(station), out = [];
  let prev = height(consts, +from), rising = null;
  for (let m = 1; m <= hours * 60; m++) {
    const t = +from + m * 60000, cur = height(consts, t), up = cur > prev;
    if (rising !== null && up !== rising) out.push({ t: t - 60000, kind: rising ? 'high' : 'low', h: prev });
    rising = up; prev = cur;
  }
  return out;
}
// FIXME: subordinate stations need offsets from their reference station (ROADMAP)
function load(station) {
  return { z0: 0.95, parts: [{ name: 'M2', amp: 0.58, phase: 210 }, { name: 'K1', amp: 0.37, phase: 106 }, { name: 'O1', amp: 0.23, phase: 89 }] };
}
`);
w('src/format.js', `
const pad = (s, n) => String(s).padStart(n);
export function table(rows) {
  return rows.map(r => \`  \${new Date(r.t).toUTCString().slice(0, 22)}  \${r.kind.padEnd(4)} \${pad(r.h.toFixed(2), 5)} m\`).join('\\n');
}
`);
commit('2026-08-02T10:00:00Z', 'feat: next and day commands');

w('test/predict.test.js', `
import test from 'node:test';
import assert from 'node:assert/strict';
import { height, predict } from '../src/predict.js';

test('height is the datum when every amplitude is zero', () => {
  assert.equal(height({ z0: 1.2, parts: [] }, 0), 1.2);
});
test('a day has three or four turning points', () => {
  const n = predict('9414290', new Date('2026-11-12T00:00:00Z'), 24).length;
  assert.ok(n === 3 || n === 4, String(n));
});
`);
w('.github/workflows/ci.yml', `
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { node: [20, 22] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "\${{ matrix.node }}" }
      - run: npm ci
      - run: npm test
      - run: npm run lint
`);
commit('2026-08-05T09:00:00Z', 'test: predictor basics; ci');

w('CHANGELOG.md', `
# Changelog

## 0.1.0 - 2026-08-12
- First release: \`next\` and \`day\`
`);
w('CONTRIBUTING.md', `
# Contributing

- Branch from \`main\`; name branches \`feat/<topic>\` or \`fix/<topic>\`. Never push to \`main\` directly.
- Conventional commits (\`feat:\`, \`fix:\`, \`docs:\`, \`test:\`).
- Every change to the predictor needs a test with numbers from a published table. Name the source in the test.
- \`npm test\` and \`npm run lint\` must pass before a pull request. CI runs both.
- No new runtime dependencies without an issue first.
`);
commit('2026-08-12T15:00:00Z', 'docs: changelog and contributing (0.1.0)');

w('ROADMAP.md', `
# Roadmap

Kept by hand. Status words: DONE, IN PROGRESS, PLANNED, IDEA.

## Now
- [IN PROGRESS] Offline cache for station constituents (docs/design/offline-cache.md, branch feat/offline-cache)
- [IN PROGRESS] Fix DST rounding in the day table (#14)
- [PLANNED] Subordinate stations (time and height offsets from a reference station)

## Next
- [PLANNED] iCal export: \`tidewatch ical --station <id> --days 30\`
- [PLANNED] Metric / imperial switch and a config file
- [IDEA] Sunrise, sunset and moon phase beside each day

## Later
- [IDEA] A tiny HTTP server mode for home dashboards
- [IDEA] Tidal currents (not only heights)
- [IDEA] A WASM build for the browser

## Done
- [DONE] \`next\` and \`day\` commands (0.1.0)
- [DONE] Station search by coordinates (0.2.0)
`);
w('TODO.md', `
# TODO

- [x] Print the station name above the table
- [ ] \`--json\` output for every command
- [ ] Cache: evict stations not used for 90 days
- [ ] Test on Windows in CI (only ubuntu today)
- [ ] The accuracy test against the reference tables is skipped for 3 stations (see test/accuracy.test.js)
- [ ] Write the man page
`);
commit('2026-09-03T11:00:00Z', 'docs: roadmap and todo');

w('AGENTS.md', `
# AGENTS.md

- Run \`npm test\` before you say a change works. Run \`npm run lint\` too.
- Heights are metres and times are UTC inside \`src/\`; convert only in \`src/format.js\`.
- Do not edit \`src/constituents.json\` by hand: it is generated by \`npm run constituents\`.
- Keep the CLI output stable: tests compare it byte for byte.
`);
w('test/accuracy.test.js', `
import test from 'node:test';

// Source: published annual tables, reference stations. Skipped until subordinate stations land (TODO.md).
for (const station of ['9414863', '9415020', '9413450']) {
  test(\`accuracy within 5 min / 3 cm: \${station}\`, { skip: 'subordinate station: offsets not implemented' }, () => {});
}
`);
w('CHANGELOG.md', `
# Changelog

## 0.2.0 - 2026-09-30
- Added: \`stations --near <lat,lon>\`
- Changed: constituents are fetched once per station and kept in memory

## 0.1.0 - 2026-08-12
- First release: \`next\` and \`day\`
`);
commit('2026-09-30T16:00:00Z', 'feat: stations --near; accuracy tests (0.2.0)');

// a stale side branch (older than the 0.2.0 release, never merged)
git(['checkout', '-q', '-b', 'feat/ical-export']);
w('src/ical.js', "export const ical = rows => 'BEGIN:VCALENDAR\\nEND:VCALENDAR';\n");
commit('2026-10-02T10:00:00Z', 'wip: ical skeleton');
git(['checkout', '-q', 'main']);

w('docs/design/offline-cache.md', `
# Offline cache (design)

Goal: after the first fetch a station works with no network.

- Store constituents per station in \`~/.cache/tidewatch/<station>.json\` with the fetch date.
- Refresh when older than 365 days and the network is up; never fail a prediction because a refresh failed.
- Evict stations not used for 90 days.

Open: where the cache lives on Windows (%LOCALAPPDATA%), and whether to ship the 50 busiest stations in the package.
`);
commit('2026-10-20T08:30:00Z', 'docs: offline cache design');

// a merged fix branch
git(['checkout', '-q', '-b', 'fix/dst-rounding']);
fs.appendFileSync(path.join(out, 'src/format.js'), '// DST: day boundaries are computed in UTC, then shifted\n');
commit('2026-11-02T12:00:00Z', 'fix: day table off by one hour on DST change days (#14)');
git(['checkout', '-q', 'main']);
git(['merge', '-q', '--no-ff', 'fix/dst-rounding', '-m', 'Merge pull request #15 from example-org/fix/dst-rounding'], '2026-11-03T09:00:00Z');
w('CHANGELOG.md', `
# Changelog

## Unreleased
- Fixed: day table off by one hour on DST change days (#14)

## 0.2.0 - 2026-09-30
- Added: \`stations --near <lat,lon>\`
- Changed: constituents are fetched once per station and kept in memory

## 0.1.0 - 2026-08-12
- First release: \`next\` and \`day\`
`);
commit('2026-11-03T09:10:00Z', 'docs: changelog for the DST fix');

// a live feature branch, 2 commits ahead
git(['checkout', '-q', '-b', 'feat/offline-cache']);
w('src/cache.js', `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = path.join(os.homedir(), '.cache', 'tidewatch');
export const read = station => { try { return JSON.parse(fs.readFileSync(path.join(dir, station + '.json'), 'utf8')); } catch { return null; } };
export const write = (station, data) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, station + '.json'), JSON.stringify({ fetched: new Date().toISOString(), ...data })); };
`);
commit('2026-11-06T14:00:00Z', 'feat: cache read and write');
fs.appendFileSync(path.join(out, 'src/cache.js'), '// TODO: evict after 90 days\n');
commit('2026-11-09T10:00:00Z', 'wip: eviction stub');
git(['checkout', '-q', 'main']);

