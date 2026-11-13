// Norn vocabulary as display labels (META-VISUAL-B S3; CONCEPTS "Urd what was, Verdandi what is, Skuld what shall be"): in the
// Norn look the tabs are grouped under the three Norns, the title / header say Norn, the picked art sits where the asset map
// says (hero on the Overview, the four empty states). Tab ids, routes, record kinds and the CLI stay; the classic look is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, NORN_GROUPS, renderNav } from '../engine/dash/ui.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';

test('Norn nav: every tab id in exactly one Norn group (Norn the thread = Home, Verdandi what is, Urd what was, Skuld what shall be, Wyrd all three = the Roadmap); ids, order inside a group and counts kept', () => {
  assert.deepEqual(NORN_GROUPS.map(g => [g[0], g[1], g[2]]), [['norn', 'Norn', 'the thread'], ['verdandi', 'Verdandi', 'what is'], ['urd', 'Urd', 'what was'], ['skuld', 'Skuld', 'what shall be'], ['wyrd', 'Wyrd', 'all three']]);
  assert.deepEqual(NORN_GROUPS[0][3], ['home'], 'META-CONTROLLER C2 (Look 3): the thread is the home page, first');
  assert.deepEqual(NORN_GROUPS[4][3], ['roadmap'], 'META-ROADMAP S2: its own frame after Skuld (SPEC sec. 4)');
  const ids = NORN_GROUPS.flatMap(g => g[3]);
  assert.deepEqual([...ids].sort(), [...SERVER_TABS].sort(), 'each tab once');
  assert.deepEqual(NORN_GROUPS[2][3], ['records', 'ledger', 'docs', 'instructions']);   // META-INSTRUCTIONS R1: next to Docs assert.ok(NORN_GROUPS[3][3].includes('inbox'));
  assert.ok(['overview', 'map', 'agents', 'lanes'].every(t => NORN_GROUPS[1][3].includes(t)));
  const nav = renderNav('inbox', { inbox: 3 }, 'norn');
  for (const [k, label] of TABS) { assert.ok(nav.includes(`id="tab-${k}" data-tab="${k}"`), k); assert.ok(nav.includes(`>${label}<`), label); }
  for (const [k, name, sub] of NORN_GROUPS) assert.match(nav, new RegExp(`ng-${k}[^]*>${name}<[^]*>${sub}<`));
  assert.match(nav, /id="tab-inbox"[^>]*aria-selected="true"/); assert.match(nav, /3 need you/);
  assert.ok(nav.indexOf('tab-records') > nav.indexOf('>Urd<') && nav.indexOf('tab-inbox') > nav.indexOf('>Skuld<'));
});
