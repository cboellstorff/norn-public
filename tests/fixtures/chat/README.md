# Chat stream fixtures (META-CONTROLLER C0, 2026-11-13)

Recorded on the owner's real, logged-in CLIs (claude 2.1.314, subscription login: `apiKeySource` none; codex-cli 0.162.1)
from a scratch working folder with a scratch Norn state; replayed by tests/chat-events.test.mjs through `chatEvents`.

- `claude-stream.jsonl` - one `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku
  --session-id <uuid> --mcp-config <norn chat stub> --strict-mcp-config --disallowedTools Bash,PowerShell,Edit,Write,NotebookEdit,Agent
  --permission-prompt-tool mcp__norn__norn_approve` process, stdin open, 3 turns (codeword, an MCP call, a reply), then the
  process tree was killed (taskkill /T /F).
- `claude-resume.jsonl` - the same flags with `--resume <uuid>`: one turn asking for the codeword.
- `claude-approvals.jsonl` - the MCP side: each call of the stub `norn_approve` (the permission prompt tool) and its verdict.
- `codex-exec-quota.jsonl` - one `codex exec --json -s read-only` turn with the stub attached by `-c mcp_servers.norn.*`,
  refused for the plan's usage limit (Codex out of quota until 2026-11-15).

The stub server: Norn's `serve()` on profile controller plus a stub `norn_approve` (allow `mcp__norn__meta_*`, deny the rest).
Scrubbed, nothing else changed: the home dir in paths -> `${home}` (tests/lint.test.mjs), the user name elsewhere ->
`owner`; hook outputs over 300 chars (the user's SessionStart
hook texts) clipped with a `<clipped N chars>` marker. Driver, stub and scrub scripts: sdd-codex-reviews/meta-controller/c0/.

The system/init lines list the recording machine's local agents, skills, slash commands and plugins: replaced with a generic
list (agents general-purpose / Explore / Plan, skill example-skill, no plugins) for the public copy (DIR-17 follow-up, 11-13).
