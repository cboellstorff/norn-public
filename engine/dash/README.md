# Norn dashboard

Start: `norn dash` (serves http://127.0.0.1:8737 - machine.json `dash.port` / `dash.bind` - and opens the browser; `--port 0` picks a
random port, `--no-open` skips the browser, `--project <project.json>` limits it to named projects). Ctrl+C stops it. Node built-ins
only, bound to 127.0.0.1. Every POST needs the per-start token embedded in the page (a fresh random token each start).

## What you see (from records, runs, heartbeats and transcripts - never from an LLM; re-renders on change via `/api/stream`, no timer)
- Header: project switcher (one project or All projects), status time, check-ins on / paused, theme (light / dark / system),
  Pause / Resume check-ins, Run tick. The tab title shows `(n)` when something needs you.
- Overview: needs-you items, running runs with age vs their time budget and context size, usage burn vs the weekly guard, latest
  records, ledger tail.
- Inbox: open questions with their options (the recommended one highlighted) and a free-text answer; answered-not-applied
  questions, parked lanes, unreviewed runs.
- Map: lanes are threads, runs are beads on them. Norn look: **the Well** (Yggdrasil over the Well of Urd; the lanes on a ring of
  stakes, the camera fitted to the crown + ring, a stake label per lane with its state and "n needs you", archived lanes behind
  the toggle, 1x / 1.5x / 2x + pan) or **the Tapestry** (the dense view: one row per lane in band order). Live from `/api/stream`:
  a record / run event fires at its record ts, the view runs 3 s behind the wall clock; render on change only (no free-running
  loop, 0 frames when idle), no frames while the tab is hidden, one static frame per change under QUIET, no travel with reduced
  motion. Classic look: the SVG map with the deliverable band pills.
- Plan (`norn plan`): up next (every queued run in start order, what it waits for, its time estimate and start), the chains
  of runs that wait for other runs, landing next (finished work heading to main, in merge order) and the usage forecast: the
  rate now against the hourly cap, this week against the weekly stop, and whether the queued work fits before the reset.
- Roadmap (`norn road`): themes and items with a status derived from the linked lanes, runs and records (never typed); a tree
  or a board, filters, and the unplaced work that has no item yet.
- Lanes: one row per lane record with its latest run (any executor), state and outcome.
- Agents: every running and recent run as a tree (main session + subagents, Codex runs), tokens and context from the transcripts.
- Records: directives and decisions with their history; Add / Revoke directive, Overrule decision.
- Docs: the project's `docs` list rendered as markdown (docs.mjs + pinned vendor/ libs, contents sidebar, record-id chips).
  Ledger: the project ledger, one row per entry, newest first (`ledger.mjs` parses check-in / minor / auto / controller lines into a headline + labelled sub-lines, record ids link to where they live, headings / prose as markdown), search + kind filter, 100 lines then "Show older" (`/api/ledger?count=&offset=`). Settings: categories from the schema (policy.mjs `SECTIONS`) with left nav, search (`@modified`),
  per-row file tag (machine `local/budget.json` | project `project.json` `policy`), modified marker + reset; Review changes shows
  a diff, Save writes atomically and refuses a stale version (409).

## Writes
Every button writes through the records library (`engine/lib/records.mjs`, rules in `engine/prompts/RECORDS.md`): answers,
directives, overrules and stops become events; the generated views are re-rendered. Talk to the controller (prompt
`engine/dash/ASK.md`): a reply line `DIRECTIVE: ...` becomes a directive record (via talk). Settings writes `local/budget.json`
and the project's `project.json` and regenerates the marked policy lines (`<!-- policy:<key> -->`) in `project.policy_targets`.

## API (GET, `?project=<name>`; overview / inbox / lanes / agents also take `all`)
`/api/overview`, `/api/inbox`, `/api/lanes`, `/api/agents`, `/api/records`, `/api/docs`, `/api/ledger`, `/api/settings`,
`/log?run=RUN-n` (last 200 lines of that run's log), `/api/feed?run=RUN-n` (SSE live feed of one run), `/api/stream` (SSE state stream: record appends, flag flips, heartbeat pulse, derived changes - the page re-renders from it).

## Look
Norn (default; `engine/dash/norn/`: pixel kit, 9-slice panels, palette lock to `palette.hex`, integer art scale, state tokens and art behind one asset map `norn/assets.mjs`, drop-in folder `norn/art/`) or classic: the header Look button, `?look=classic`, remembered per browser.
Norn vocabulary (display labels only; tab ids, routes, record kinds, paths and the CLI are unchanged): the tabs are grouped as
**Verdandi**, what is (Overview, Map, Agents, Lanes, Usage), **Urd**, what was (Records, Ledger, Docs) and **Skuld**, what shall
be (Plan, Inbox, Settings), with **Wyrd**, all three (Roadmap), beside them; the title says Norn and the header shows the wordmark; the Overview carries the hero (night / day by ground)
with the three lore lines; empty lists show the empty-state art. The picked art is vendored in `norn/art/` (source + name map in
its README). The classic look keeps the flat tab bar, the plain "norn" title and no art.

## Tests
`node --test tests/dashboard.test.mjs tests/ui.test.mjs tests/norn-look.test.mjs tests/norn-map.test.mjs tests/norn-vocab.test.mjs` (fixture server on a random port, temp state).
