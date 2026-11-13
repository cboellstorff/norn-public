# task MERGE {{lane}} - merge {{branch}} at {{sha_short}} into {{main}} (STAGED merge, written by `norn merge-brief --sha`)

You are the merge worker for lane {{lane}} of project {{project}}. The check-in never merges; you do, on evidence.
Commit {{sha}} of branch {{branch}} (the lane's READY sha), main checkout {{main_checkout}} (the one writer of {{main}}: its worktree lock).
Meta: {{meta}}. NOTES {{notes}} (durable, outside every worktree); last line exactly `## DONE`, `## STOPPED: <why>` or `## HANDOFF`.
STAGED: merge exactly that commit. NEVER touch the lane worktree {{worktree}} - no fetch, rebase, merge, checkout, commit or push
there (the lane's next stage may be writing in it). Every command below runs in {{main_checkout}}. Never force-push, never
rewrite {{main}}, never loosen a test. A conflict you cannot resolve with the lane's intent = STOPPED.

1. `git -C {{main_checkout}} fetch origin`, then `git -C {{main_checkout}} merge-base --is-ancestor {{sha}} origin/{{branch}}`: the commit
   must be pushed on its branch; else `## STOPPED: {{sha_short}} is not on origin/{{branch}}`, nothing merged.
2. `git -C {{main_checkout}} pull --ff-only origin {{main}}`, then `git -C {{main_checkout}} merge --no-ff --no-commit {{sha}}`
   (conflicts: resolve them in {{main_checkout}} keeping both sides' intent; else `git -C {{main_checkout}} merge --abort` and STOPPED).
3. {{suite}}
4. {{shots}}
5. `git -C {{main_checkout}} commit --no-edit -m "merge: {{branch}} at {{sha_short}} ({{lane}})"`, then `{{meta}} smoke` in {{main_checkout}}.
   A red smoke after the merge = `git -C {{main_checkout}} revert -m 1 HEAD` (a NEW commit, never a reset or force), push, and
   `## STOPPED: smoke red after the merge, reverted`.
6. Green smoke: `git -C {{main_checkout}} push origin {{main}}`; restart the live dash (it serves the merged code):
   `{{meta}} dash restart` - nothing else (it stops only this install's recorded dashboard; an error = note it in NOTES, stop no other process).
7. Notify the owner (`{{meta}} notify --class merge --title "merged {{branch}}" --body "<sha>, {{suite_ran}} + smoke green; revert: git -C {{main_checkout}} revert -m 1 <merge sha>"`{{shot_flag}}).
   Write NOTES: merge sha, {{suite_ran}} counts + named reds, smoke result, shots paths, the one-command revert; end `## DONE`.
