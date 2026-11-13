# task {{epic}} vendor - vendor the owner's pick: {{subject}} (flow {{flow}}, step {{step}}; written by `norn flow`)

You vendor the picked candidate for project {{project}}. Meta: {{meta}}. Worktree {{worktree}}. NOTES {{out_dir}}/VENDOR-NOTES.md
(durable); last line exactly `## DONE`, `## STOPPED: <why>` or `## HANDOFF`.

1. The owner's pick: `{{meta}} rec show {{pick}}` (its answer names the candidate; an empty Q id here = the critique ended DONE
   with a single candidate: read {{out_dir}}/CRITIQUE-NOTES.md). An answer that names no candidate = `## STOPPED: unclear pick`.
2. Rebuild the picked candidate from its recipe in {{out_dir}}/candidates/ and vendor it to {{dest}} in {{worktree}} with its
   recipe and source / licence note; covering tests of the asset's use green; one conventional commit (named files); push.
3. Offscreen verification capture of the asset in use (GPU lock / QUIET rules unchanged) to {{out_dir}}/vendored.png; NOTES and `## DONE`.
