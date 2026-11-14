// META-NAME-W2: Norn MCP servers stored under their pre-rename names (claude / codex / opencode configs). A leaf module:
// harness install moves them, doctor (setup.mjs) names them - so setup needs no import of harness.mjs (no cycle through mcp.mjs).
import fs from 'node:fs';
import path from 'node:path';

export const SERVER_NAME = 'norn';
// META-ADOPT A4: the machine-scoped setup server sits beside a project's "norn" server, under its own name
export const SETUP_NAME = 'norn-setup';
// META-NAME-W2: the pre-rename server names. A registration under one of them that runs a Norn engine (its args name
// engine/bin/norn.mjs or meta.mjs) is a STORED old name: `harness install` removes it while it registers the new name, doctor names it.
export const OLD_SERVER = { [SERVER_NAME]: 'meta', [SETUP_NAME]: 'meta-setup' };
export const runsNorn = args => (args || []).some(a => /engine[\\/]bin[\\/](?:meta|norn)\.mjs$/.test(String(a)));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const tomlTable = (text, name) => { const m = String(text || '').replace(/\r\n/g, '\n').match(new RegExp(`^\\[mcp_servers\\.${name}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm')); return m ? m[1] : null; };
/** Every stored old-named Norn server: [{ family, name, scope?, dir?, args }]. o: { claudeJson, cwd, codexConfig, opencodeConfig } (only the given files are read). */
export function oldRegistrations({ claudeJson, cwd, codexConfig, opencodeConfig } = {}) {
  const found = [], olds = Object.values(OLD_SERVER);
  const cj = claudeJson && readJson(claudeJson);
  for (const n of olds) {
    if (runsNorn(cj?.mcpServers?.[n]?.args)) found.push({ family: 'claude', name: n, scope: 'user', args: cj.mcpServers[n].args });
    for (const [dir, p] of Object.entries(cj?.projects || {})) if (runsNorn(p?.mcpServers?.[n]?.args)) found.push({ family: 'claude', name: n, scope: 'local', dir, args: p.mcpServers[n].args });
    const pj = cwd && readJson(path.join(cwd, '.mcp.json'));
    if (runsNorn(pj?.mcpServers?.[n]?.args)) found.push({ family: 'claude', name: n, scope: 'project', dir: cwd, args: pj.mcpServers[n].args });
    const t = codexConfig && fs.existsSync(codexConfig) ? tomlTable(fs.readFileSync(codexConfig, 'utf8'), n) : null;
    const targs = t?.match(/^args = (\[.*\])$/m)?.[1];
    if (targs) { let a = []; try { a = JSON.parse(targs); } catch { /* not ours */ } if (runsNorn(a)) found.push({ family: 'codex', name: n, args: a }); }
    const oc = opencodeConfig && readJson(opencodeConfig);
    if (runsNorn(oc?.mcp?.[n]?.command)) found.push({ family: 'opencode', name: n, args: oc.mcp[n].command.slice(1) });
  }
  return found;
}
/** the one command that moves an old registration: the same server args, the new name (`harness install` removes the old one) */
export function moveCommand(r) {
  const a = r.args || [], i = a.indexOf('mcp'), rest = i >= 0 ? a.slice(i + 1) : [], keep = [];
  for (let j = 0; j < rest.length; j++) { if (rest[j] === '--client') { j++; continue; } keep.push(rest[j]); }
  return ['norn harness install --family', r.family, ...keep, ...(r.scope ? ['--scope', r.scope] : [])].join(' ');
}
/** doctor (META-NAME-W2): one PROBLEM per stored old-named server of this user, with the command that moves it. o: { home, env } */
export function oldServerProblems({ home, env = process.env }) {
  const regs = oldRegistrations({ claudeJson: path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), codexConfig: path.join(home, '.codex', 'config.toml'),
    opencodeConfig: path.join(home, '.config', 'opencode', 'opencode.json') });
  return regs.map(r => `MCP server '${r.name}' (${r.family}${r.scope ? `, ${r.scope} scope` : ''}) is Norn's old name - run${r.dir ? ` in ${r.dir}` : ''}: ${moveCommand(r)}`);
}
