# task MERGE {{lane}} - merge {{branch}} into {{main}} in its own merge worktree (NORN-WATCH S2 MERGE stage; written by `norn merge-brief`)

You are the merge worker for lane {{lane}} of project {{project}}. The check-in never merges; you do, on evidence.
Branch {{branch}}, worktree {{worktree}}. YOUR merge worktree: {{merge_wt}} (detached at {{main}}; Norn made it for this run and
removes it when the run ends). Other merges run beside you in their own worktrees: never write in {{main_checkout}} (the owner's
checkout) - `norn merge-land` lands your merge on {{main}} and updates it when that is safe.
Norn: {{norn}}. NOTES {{notes}} (durable, outside every worktree); end with `{{norn}} done` (or `{{norn}} done --outcome stopped --why "<why>"` / `{{norn}} done --outcome handoff --handoff-file F`): your outcome.
Never force-push {{main}}, never push {{main}} by hand, never rewrite {{main}}, never loosen a test. A conflict you cannot resolve
with the lane's intent = STOPPED.

1. `git -C {{worktree}} fetch origin` and `git -C {{worktree}} rebase origin/{{main}}` (conflicts: resolve keeping both sides'
   intent; else STOPPED). Push the rebased branch (`git -C {{worktree}} push --force-with-lease origin {{branch}}` is the ONE
   allowed lease push: the lane's own feat/* branch, never {{main}}).
2. {{suite}}
3. {{shots}}
4. `git -C {{merge_wt}} fetch origin`, `git -C {{merge_wt}} checkout --quiet --detach origin/{{main}}`, then
   `git -C {{merge_wt}} merge --no-ff -m "merge: {{branch}} ({{lane}})" origin/{{branch}}`, then `{{norn}} smoke` in {{merge_wt}}.
   A conflict you cannot resolve = `git -C {{merge_wt}} merge --abort`, STOPPED; a red smoke =
   `{{norn}} done --outcome stopped --why "smoke red, nothing landed"` ({{main}} was never touched).
5. Green smoke: land it - `{{land}}`. It fast-forwards {{main}} to your merge under a short lock and pushes it (never a force).
   - exit 0 `LANDED <sha>`: done. If its line says `main checkout: updated`, restart the live dash (it serves the merged code):
     `{{norn}} dash restart` - nothing else (an error = note it in NOTES, stop no other process). Otherwise the owner's checkout was
     left alone (its words say why): no restart; say so in NOTES and in the notice.
   - exit 4 `REMERGED`: {{main}} moved meanwhile and was merged into your merge worktree; run step 2's tests in {{merge_wt}} and
     step 4's smoke again, then this step again (at most 3 lands in all; then `{{norn}} done --outcome stopped --why "{{main}} keeps moving"`).
   - exit 3 `NOT LANDED`: `{{norn}} done --outcome stopped --why "<its words>"` - nothing landed.
6. Notify the owner (`{{norn}} notify --class merge --title "merged {{branch}}" --body "<sha>, {{suite_ran}} + smoke green; revert: git -C {{main_checkout}} revert -m 1 <merge sha>"`{{shot_flag}}).
   Write NOTES: merge sha, the land line, {{suite_ran}} counts + named reds, smoke result, shots paths, the one-command revert; end with `{{norn}} done`.
