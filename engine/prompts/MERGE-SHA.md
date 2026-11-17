# task MERGE {{lane}} - merge {{branch}} at {{sha_short}} into {{main}} (STAGED merge in its own merge worktree, written by `norn merge-brief --sha`)

You are the merge worker for lane {{lane}} of project {{project}}. The check-in never merges; you do, on evidence.
Commit {{sha}} of branch {{branch}} (the lane's READY sha). YOUR merge worktree: {{merge_wt}} (detached at {{main}}; Norn made it
for this run and removes it when the run ends). Other merges run beside you in their own worktrees: never write in
{{main_checkout}} (the owner's checkout) - `norn merge-land` lands your merge on {{main}} and updates it when that is safe.
Norn: {{norn}}. NOTES {{notes}} (durable, outside every worktree); end with `{{norn}} done` (or `{{norn}} done --outcome stopped --why "<why>"` / `{{norn}} done --outcome handoff --handoff-file F`): your outcome.
STAGED: merge exactly that commit. NEVER touch the lane worktree {{worktree}} - no fetch, rebase, merge, checkout, commit or push
there (the lane's next stage may be writing in it). Every git command below runs in {{merge_wt}}. Never force-push, never
push {{main}} by hand, never rewrite {{main}}, never loosen a test. A conflict you cannot resolve with the lane's intent = STOPPED.

1. `git -C {{merge_wt}} fetch origin`, then `git -C {{merge_wt}} merge-base --is-ancestor {{sha}} origin/{{branch}}`: the commit
   must be pushed on its branch; else `{{norn}} done --outcome stopped --why "{{sha_short}} is not on origin/{{branch}}"`, nothing merged.
2. `git -C {{merge_wt}} checkout --quiet --detach origin/{{main}}`, then `git -C {{merge_wt}} merge --no-ff --no-commit {{sha}}`
   (conflicts: resolve them in {{merge_wt}} keeping both sides' intent; else `git -C {{merge_wt}} merge --abort` and STOPPED -
   nothing landed, {{main}} untouched).
3. {{suite}}
4. {{shots}}
5. `git -C {{merge_wt}} commit --no-edit -m "merge: {{branch}} at {{sha_short}} ({{lane}})"`, then `{{norn}} smoke` in {{merge_wt}}.
   A red smoke = `{{norn}} done --outcome stopped --why "smoke red, nothing landed"` ({{main}} was never touched).
6. Green smoke: land it - `{{land}}`. It fast-forwards {{main}} to your merge under a short lock and pushes it (never a force).
   - exit 0 `LANDED <sha>`: done. If its line says `main checkout: updated`, restart the live dash (it serves the merged code):
     `{{norn}} dash restart` - nothing else (an error = note it in NOTES, stop no other process). Otherwise the owner's checkout was
     left alone (its words say why): no restart; say so in NOTES and in the notice.
   - exit 4 `REMERGED`: {{main}} moved meanwhile and was merged into your worktree; run step 3's tests and step 5's smoke again
     in {{merge_wt}}, then this step again (at most 3 lands in all; then `{{norn}} done --outcome stopped --why "{{main}} keeps moving"`).
   - exit 3 `NOT LANDED`: `{{norn}} done --outcome stopped --why "<its words>"` - nothing landed.
7. Notify the owner (`{{norn}} notify --class merge --title "merged {{branch}}" --body "<sha>, {{suite_ran}} + smoke green; revert: git -C {{main_checkout}} revert -m 1 <merge sha>"`{{shot_flag}}).
   Write NOTES: merge sha, the land line, {{suite_ran}} counts + named reds, smoke result, shots paths, the one-command revert; end with `{{norn}} done`.
