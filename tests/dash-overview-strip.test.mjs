// RM-18 S2: the Overview strip of the three Norns (server stripOf -> overview.strip): Urd landed today + last landed, Verdandi
// running + parked, Skuld open questions + queued + next check-in; and the rendered strip links each part to its page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';
import { overviewStrip } from '../engine/dash/ui.mjs';

test('overview.strip counts landed, running, parked, questions, queued and times the next check-in', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, s0 = (await f.get('/api/overview?project=kestrel')).data.strip;   // the fixture's own parked lane + question
    assert.equal(s0.landed_today, 0); assert.equal(s0.last_landed, null); assert.equal(s0.checkin.next, null, 'no check-in yet: no next time');
    const m = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen', stage: 'MERGE' } });
    record(S, { kind: 'run', ev: 'end', id: m.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    record(S, { kind: 'lane', ev: 'park', id: 'L:seabed', by: 'controller', data: { why: 'waits on the owner' } });
    record(S, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'render', not_before: '2099-01-01T00:00:00Z' } });
    const ck = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } });
    const ov = (await f.get('/api/overview?project=kestrel')).data, s = ov.strip;
    assert.equal(s.landed_today, 1, 'the MERGE run that ended done landed today');
    assert.equal(s.last_landed.run, m.id); assert.equal(s.last_landed.lane, 'gen'); assert.equal(s.last_landed.project, 'kestrel');
    assert.equal(s.running, ov.running.lanes.length, 'Verdandi counts what the Running table lists');
    assert.equal(s.parked, s0.parked + 1); assert.equal(s.questions, s0.questions); assert.equal(s.queued, s0.queued + 1);
    const every = s.checkin.every_min;
    assert.ok(Number.isFinite(every), 'the cadence comes from the policy');
    const start = ck.ts;   // the start event's own time
    assert.equal(s.checkin.next, new Date(Date.parse(start) + every * 60000).toISOString(), 'next check-in = last check-in start + cadence');
    const h = overviewStrip(s, { project: 'kestrel', now: Date.parse(ov.now) });
    for (const [tone, tab] of [['urd', 'history'], ['verd', 'work'], ['skuld', 'inbox']])
      assert.match(h, new RegExp(`<a class="np tone-${tone}" id="strip-${tone}" href="\\?project=kestrel&(amp;)?tab=${tab}" data-tab="${tab}"`), `${tone} links to ${tab}`);
  } finally { await f.done(); }
});
