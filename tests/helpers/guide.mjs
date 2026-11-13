// META-ONBOARD S5 (SPEC 3.5): the SETUP.md walker. Every fenced block carries a marker on the line before its fence:
//   <!-- guide:run expect=/regex/ -->   run each line of the block (in order, through the real CLI); the joined output must match
//   <!-- guide:skip reason=... -->      a step a test cannot run (an install, the scheduler, the dashboard): never run, reason required
//   <!-- guide:output -->               sample output, not a command
// `<repo>` / `<name>` / `<project>` / `<brief>` / `<lane>` in a command = the user's repo path / its project name / its project.json / the first lane's brief / that lane (the walker's temp repo). A `node ...` line runs with
// this node; a bare `norn ...` line runs as `node engine/bin/norn.mjs ...`.

/** text -> { steps: [{ kind: 'run'|'skip'|'output', lines, expect?, reason?, at }], errors: [string] } */
export function parseGuide(text) {
  const L = text.split(/\r?\n/), steps = [], errors = [];
  for (let i = 0; i < L.length; i++) {
    if (!/^```/.test(L[i])) continue;
    const start = i, body = [];
    for (i++; i < L.length && !/^```\s*$/.test(L[i]); i++) body.push(L[i]);
    const mark = (L[start - 1] || '').trim(), at = start + 1;
    const lines = body.map(s => s.trim()).filter(Boolean);
    let m;
    if ((m = /^<!-- guide:run expect=\/(.+)\/ -->$/.exec(mark))) {
      let expect;
      try { expect = new RegExp(m[1], 'm'); } catch (e) { errors.push(`line ${at}: bad expect ${m[1]}: ${e.message}`); continue; }
      steps.push({ kind: 'run', lines, expect, at });
    } else if ((m = /^<!-- guide:skip(?: reason=(.*?))? -->$/.exec(mark))) {
      if (!m[1] || !m[1].trim()) errors.push(`line ${at}: guide:skip without a reason`);
      else steps.push({ kind: 'skip', lines, reason: m[1].trim(), at });
    } else if (mark === '<!-- guide:output -->') steps.push({ kind: 'output', lines, at });
    else errors.push(`line ${at}: fenced block without a guide marker`);
  }
  return { steps, errors };
}

/** run the guide's run steps in order; run(argv) -> { code, out }. Returns the list of failures ([] = the guide walks). */
export function walkGuide(text, { run, vars = {} }) {
  const { steps, errors } = parseGuide(text);
  const fails = [...errors];
  if (fails.length) return fails;
  for (const s of steps.filter(x => x.kind === 'run')) {
    let all = '';
    for (const raw of s.lines) {
      const line = raw.replace(/<(repo|name|project|brief|lane)>/g, (x, k) => vars[k] ?? x);
      // a "double quoted" argument stays one argument (sh and PowerShell agree on that form; META-OOTB F-1: --task "<text>")
      const argv = line.match(/"[^"]*"|\S+/g).map(a => a.replace(/^"(.*)"$/, '$1'));
      const r = run(argv);
      all += r.out + '\n';
      if (r.code !== 0) { fails.push(`line ${s.at}: ${line} -> exit ${r.code}\n${r.out}`); return fails; }
    }
    const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expect = new RegExp(s.expect.source.replace(/<(repo|name|project|brief|lane)>/g, (x, k) => (vars[k] != null ? esc(vars[k]) : x)), 'm');
    if (!expect.test(all)) { fails.push(`line ${s.at}: output misses /${expect.source}/:\n${all}`); return fails; }
  }
  return fails;
}
