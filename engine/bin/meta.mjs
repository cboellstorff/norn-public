#!/usr/bin/env node
// The old entry path (old name: meta). Installed artefacts outside this repo still name it: the OS scheduler task, the Norn
// session hook, MCP / harness configs and launchers written before the rename. It runs norn.mjs's main - no parser of its own.
// Remove once nothing calls it (META-RENAME R1 NOTES list the callers).
import { main } from './norn.mjs';
const code = main(process.argv.slice(2));
if (code instanceof Promise) code.then(c => { process.exitCode = c; }); else process.exitCode = code;
