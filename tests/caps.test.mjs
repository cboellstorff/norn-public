// META-GTP-HARNESS (GT-PARITY-PLAN sec. 2.5; Gas Town internal/config/agents.go:20-110 ResumeFlag / ResumeStyle, SupportsHooks,
// SupportsForkSession, NonInteractive): the capability flags fork / hooks / resume_style / noninteractive per family, each checked
// against the CLI's own --help recorded in tests/fixtures/help.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, capsOf, capsMatrix } from '../engine/lib/harness/index.mjs';
import { CAP_KEYS, HOOKS, RESUME_STYLES } from '../engine/lib/harness/common.mjs';
import os from 'node:os';
import { loadPresets, expandPresets, presetExe } from '../engine/lib/presets.mjs';
import { checkProject, loadProject } from '../engine/lib/config.mjs';
import { main } from '../engine/bin/norn.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const help = n => fs.readFileSync(path.join(HERE, 'fixtures', 'help', n + '.txt'), 'utf8');
const GROK = { type: 'cli', exe: 'grok', model: 'grok-4.7', args: ['--prompt-file', '{brief}'], modes: { run: { access: 'write', args: [] } } };

// the help line that proves each flag (recorded text, not memory)
const PROOF = {
  claude: { file: 'claude', fork: '--fork-session', resume: '-r, --resume [value]', hooks: '--settings <file-or-json>', ni: '-p, --print' },
  codex: { file: 'codex', fork: 'Usage: codex exec fork', resume: 'Usage: codex exec resume', hooks: /^hooks\s+stable\s+true$/m, ni: 'Usage: codex exec [OPTIONS]' },
  grok: { file: 'grok', fork: '--fork-session', resume: '-r, --resume [<SESSION_ID_OR_TITLE>]', ni: '--prompt-file <PATH>' },
};

test('caps: claude / codex / grok match their recorded --help; the generic cli family claims nothing', () => {
  const want = {
    claude: { fork: true, hooks: 'settings', resume_style: 'flag', noninteractive: '-p' },
    codex: { fork: true, hooks: 'settings', resume_style: 'subcommand', noninteractive: 'exec' },
    grok: { fork: true, hooks: 'none', resume_style: 'flag', noninteractive: '--prompt-file' },
  };
  const got = { claude: capsOf('claude'), codex: capsOf('codex-astra'), grok: capsOf('grok', GROK) };
  for (const [n, w] of Object.entries(want)) {
    for (const [k, v] of Object.entries(w)) assert.equal(got[n][k], v, `${n}.${k}`);
    const p = PROOF[n], h = help(p.file);
    for (const k of ['fork', 'resume', 'hooks', 'ni']) if (p[k]) assert.ok(typeof p[k] === 'string' ? h.includes(p[k]) : p[k].test(h), `${n} --help shows ${p[k]}`);
    assert.ok(h.includes(got[n].noninteractive), `${n}: ${got[n].noninteractive} is in its --help`);
  }
  assert.ok(!help('grok').toLowerCase().includes('hook'), 'grok --help names no hooks: hooks none');
  assert.deepEqual(['fork', 'hooks', 'resume_style', 'noninteractive'].map(k => ADAPTERS.cli.caps[k]), [false, 'none', 'none', null]);
  assert.deepEqual(['fork', 'hooks', 'resume_style'].map(k => capsOf('x', { ...GROK, exe: 'x' })[k]), [false, 'none', 'none'], 'an unknown cli entry: the family defaults');
  assert.equal(capsOf('x', { ...GROK, exe: 'x', caps: { fork: true } }).fork, true, 'an entry\'s own caps win');
});

// ---------- piece 2: shipped presets (engine/presets), inert until listed + detected, the caps matrix ----------
const tmp = () => mkTmp('meta-caps-');
const SIX = ['amp', 'copilot-cli', 'cursor-agent', 'gemini-cli', 'opencode', 'qwen-code'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inHelp = (h, tok) => new RegExp(`(^|[^\\w-])${esc(tok)}(?![\\w-])`, 'm').test(h);
// the help line proving resume / fork / hooks for each preset (resume_style flag | subcommand; fork true; hooks settings)
const PRESET_PROOF = {
  'gemini-cli': { resume: '-r, --resume', hooks: 'gemini hooks <command>' },
  opencode: { resume: '-s, --session', fork: '--fork' },
  'copilot-cli': { resume: '--resume[=VALUE]', hooks: '~/.copilot/settings.json' },
  'cursor-agent': { resume: '`--resume [chatId]`' },
  'qwen-code': { resume: '--resume [sessionId]', hooks: '.qwen/settings.json' },
  amp: { resume: 'amp threads continue' },
};

test('kill criterion: every preset command line (each mode) uses only flags and values its recorded --help shows', () => {
  const ps = loadPresets();
  for (const [n, p] of Object.entries(ps)) {
    const h = help(p.source.fixture.replace(/\.txt$/, ''));
    for (const m of Object.keys(p.modes)) {
      const c = ADAPTERS.cli.command({ executor: n, exe: p.exe, worktree: 'C:/wt', brief: 'C:/wt/brief.md', model: 'some-model', effort: 'high',
        provider: { ...p, model: 'some-model' }, mode: m });
      for (const a of c.args) {
        if (!a.startsWith('-') && /\s|,|C:\/wt|some-model/.test(a)) continue;   // the prompt text, a tool list, a filled placeholder
        if (/^(high|80)$/.test(a)) continue;                                     // the {effort} / {turns} values
        const tok = a.startsWith('-') ? a.split('=')[0] : a;
        assert.ok(inHelp(h, tok), `${n} mode ${m}: ${tok} is not in its recorded --help`);
      }
    }
    assert.ok(inHelp(h, p.caps.noninteractive), `${n}: noninteractive ${p.caps.noninteractive} in its help`);
    const pr = PRESET_PROOF[n] || PROOF[n];
    if (p.caps.resume_style !== 'none') assert.ok(h.includes(pr.resume), `${n}: resume proof ${pr.resume}`);
    if (p.caps.fork) assert.ok(h.includes(pr.fork), `${n}: fork proof ${pr.fork}`);
    if (p.caps.hooks === 'settings') assert.ok(h.includes(pr.hooks), `${n}: hooks proof ${pr.hooks}`);
  }
});

test('a project lists a preset: { preset, model } expands to its data + the overrides; an unknown preset is refused', () => {
  const ex = expandPresets({ executors: { gem: { preset: 'gemini-cli', model: 'gemini-2.5-pro', caps: { fork: true } }, claude: {} } }).executors;
  assert.equal(ex.gem.type, 'cli'); assert.equal(ex.gem.exe, 'gemini'); assert.equal(ex.gem.model, 'gemini-2.5-pro');
  assert.equal(ex.gem.preset, 'gemini-cli'); assert.ok(!Object.hasOwn(ex.gem, 'source'));
  assert.equal(ex.gem.caps.fork, true); assert.equal(ex.gem.caps.hooks, 'settings', 'caps merge key by key');
  assert.deepEqual(ex.claude, {});
  assert.throws(() => checkProject({ schema: 1, name: 'p', title: 'P', root: 'C:/r', executors: { x: { preset: 'nope', model: 'm' } } }), /unknown preset "nope"/);
  assert.throws(() => checkProject({ schema: 1, name: 'p', title: 'P', root: 'C:/r', executors: { x: { preset: 'amp' } } }), /executors\.x\.model is required/);
  const d = tmp(), f = path.join(d, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'p', title: 'P', root: 'C:/r', executors: { q: { preset: 'qwen-code', model: 'qwen3-coder' } } }));
  const pj = loadProject(f, { home: d, meta: d });
  assert.equal(pj.executors.q.exe, 'qwen'); assert.equal(capsOf('q', pj.executors.q).resume_style, 'flag');
});

// a fake CLI on a temp PATH: an npm-style .cmd shim (Windows) or an executable script (POSIX) answering --version
function fakeCli(dir, name, version) {
  fs.writeFileSync(path.join(dir, name + '.js'), `console.log(${JSON.stringify(version)});\n`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(dir, name + '.cmd'), `@ECHO off\r\nnode "%dp0%\\${name}.js" %*\r\n`);
  else { fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, name + '.js')}" "$@"\n`); fs.chmodSync(path.join(dir, name), 0o755); }
}

test('inert: a listed preset runs only when its exe is detected; norn run refuses it otherwise', () => {
  const bin = tmp(), env = { PATH: bin, PATHEXT: '.CMD;.EXE' };
  assert.equal(presetExe({ preset: 'gemini-cli', exe: 'gemini' }, env), null);
  fakeCli(bin, 'gemini', '0.41.2');
  assert.ok(/gemini(\.cmd)?$/i.test(presetExe({ preset: 'gemini-cli', exe: 'gemini' }, env)));
  assert.equal(presetExe({ type: 'cli', exe: 'C:/x/grok.exe' }, env), 'C:/x/grok.exe', 'a hand-written entry keeps its exe');
  const d = tmp(), f = path.join(d, 'project.json'), wt = path.join(d, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(d, 'b.md'), '# brief\n');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'p', title: 'P', root: d.replace(/\\/g, '/'), executors: { q: { preset: 'qwen-code', model: 'qwen3-coder' } } }));
  const errs = [];
  const code = main(['run', '--executor', 'q', '--project', f, '--state', path.join(d, 'state'), '--lane', 'l', '--brief', path.join(d, 'b.md'), '--worktree', wt, '--notes', path.join(d, 'n.md'), '--no-tick'],
    { ...env, META_ROOT: d }, () => {}, s => errs.push(s));
  assert.equal(code, 2, errs.join('\n'));
  assert.match(errs.join('\n'), /preset qwen-code: exe qwen is not detected/);
});

test('norn executors --caps [--json]: the matrix, detected yes / no per preset, listed per project', () => {
  const bin = tmp(), env = { PATH: bin, PATHEXT: '.CMD;.EXE' };
  fakeCli(bin, 'gemini', '0.41.2');
  const rows = capsMatrix({ env });
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(by['gemini-cli'].detected, true); assert.equal(by['gemini-cli'].version, '0.41.2');
  assert.equal(by.amp.detected, false); assert.equal(by.amp.listed, false);
  assert.equal(by.claude.kind, 'builtin'); assert.equal(by.claude.fork, true);
  for (const n of SIX) assert.equal(by[n].kind, 'preset');
  const d = tmp(), f = path.join(d, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'p', title: 'P', root: 'C:/r', executors: { gem: { preset: 'gemini-cli', model: 'g' } } }));
  const out = [];
  assert.equal(main(['executors', '--caps', '--json', '--project', f], { ...env, META_ROOT: d }, s => out.push(s), () => {}), 0);
  const j = JSON.parse(out.join('\n'));
  assert.equal(j.find(r => r.name === 'gemini-cli').listed, true);
  assert.equal(j.find(r => r.name === 'gem').kind, 'project');
  const txt = [];
  assert.equal(main(['executors', '--caps'], env, s => txt.push(s), () => {}), 0);
  assert.match(txt.join('\n'), /gemini-cli\s+preset\s+yes/);
  assert.match(txt.join('\n'), /amp\s+preset\s+no/);
});

// ---------- piece 3: a preset (or a project entry) with an unknown cap or a mode its caps lack is refused at load ----------
const okPreset = () => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'engine', 'presets', 'qwen-code.json'), 'utf8'));
const presetDir = p => { const d = tmp(); fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify(p)); return d; };

test('refused at load: a preset with an unknown cap', () => {
  const p = okPreset(); p.caps.teleport = true;
  assert.throws(() => loadPresets(presetDir(p)), /preset bad: caps\.teleport is not a known cap/);
  assert.throws(() => checkProject({ schema: 1, name: 'p', title: 'P', root: 'C:/r', executors: { q: { preset: 'qwen-code', model: 'm', caps: { teleport: 1 } } } }),
    /executors\.q\.caps\.teleport is not a known cap/);
  const v = okPreset(); v.caps.hooks = 'sometimes';
  assert.throws(() => loadPresets(presetDir(v)), /caps\.hooks must be settings \| none/);
  assert.ok(loadPresets(presetDir(okPreset())).bad, 'the same preset without it loads');
});

test('refused at load: a preset with a mode its caps lack', () => {
  const p = okPreset(); p.caps.modes = ['write'];
  assert.throws(() => loadPresets(presetDir(p)), /preset bad: modes\.plan is read-only but caps\.modes lacks it/);
  assert.throws(() => checkProject({ schema: 1, name: 'p', title: 'P', root: 'C:/r', executors: { q: { preset: 'qwen-code', model: 'm', caps: { modes: ['write'] } } } }),
    /executors\.q\.modes\.plan is read-only but caps\.modes lacks it/);
  const n = okPreset(); delete n.caps.fork;
  assert.throws(() => loadPresets(presetDir(n)), /preset bad: caps\.fork is required/);
  const k = okPreset(); k.api_key_env = 'QWEN_KEY';
  assert.throws(() => loadPresets(presetDir(k)), /preset bad: no keys/);
});
