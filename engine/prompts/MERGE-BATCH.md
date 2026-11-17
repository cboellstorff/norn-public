# task MERGE {{batch}} - land the gated merge-queue batch on {{main}} ({{count}} branches; written by `norn mergeq`, META-GTP-MERGEQ)

You are the merge worker for merge-queue {{batch}} of project {{project}}. The check-in never merges; you do, on evidence.
{{suite}} the batch tip {{tip}} = {{main}} {{base_short}} + one `--no-ff` merge commit per branch below
(gate log {{gate_log}}; batch worktree {{scratch}}). YOUR merge worktree: {{merge_wt}} (Norn made it for this run and removes it
when the run ends). Other merges run beside you in their own worktrees: never write in {{main_checkout}} (the owner's checkout) -
`norn merge-land` lands the tip on {{main}} and updates it when that is safe.
Norn: {{norn}}. NOTES {{notes}} (durable, outside every worktree); end with `{{norn}} done` (or `{{norn}} done --outcome stopped --why "<why>"` / `{{norn}} done --outcome handoff --handoff-file F`): your outcome.
STAGED: land exactly that tested tip. NEVER touch a lane worktree (no fetch, rebase, merge, checkout, commit or push there).
Never force-push, never push {{main}} by hand, never rewrite {{main}}, never loosen a test.

Branches (each its own merge commit = one revert command each):
{{members}}

1. `git -C {{merge_wt}} fetch origin`, `git -C {{merge_wt}} checkout --quiet --detach {{tip}}`; then
   `git -C {{merge_wt}} merge-base --is-ancestor origin/{{main}} {{tip}}` must succeed. Else
   `{{norn}} done --outcome stopped --why "{{main}} moved since the batch was gated"` - nothing landed (`norn mergeq` rebuilds the batch on the new {{main}}).
2. {{shots}}
3. `{{norn}} smoke` in {{merge_wt}}. A red smoke = `{{norn}} done --outcome stopped --why "smoke red, nothing landed"` ({{main}} was never touched).
4. Green smoke: land it - `{{land}}`. It fast-forwards {{main}} to the tip under a short lock and pushes it (never a force).
   - exit 0 `LANDED <sha>`: done. If its line says `main checkout: updated`, restart the live dash (it serves the merged code):
     `{{norn}} dash restart` - nothing else (an error = note it in NOTES, stop no other process). Otherwise the owner's checkout was
     left alone (its words say why): no restart; say so in NOTES and in the notice.
   - exit 4 `REMERGED` or exit 3 `NOT LANDED`: `{{norn}} done --outcome stopped --why "<its words>"` - {{main}} moved under the
     batch; nothing of it landed (`norn mergeq` rebuilds the batch on the new {{main}}).
5. Notify the owner (`{{norn}} notify --class merge --title "merged {{batch}}: {{count}} branches" --body "<tip>, {{suite_ran}} + smoke green; revert one: <the revert lines above>"`{{shot_flag}}).
   Write NOTES: the landed tip, the land line, the gate log, smoke result, shots paths, one revert command per branch; end with `{{norn}} done`.
