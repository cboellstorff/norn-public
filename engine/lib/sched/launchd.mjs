// macOS launchd LaunchAgent (D13): StartInterval; AbandonProcessGroup keeps the detached supervisor alive.
// GOLDEN-FILE TESTED ONLY (no macOS machine) - to be labelled so in the README (S8).
import { generic, tickArgv, realIo, readOwner } from './common.mjs';

const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function plan(o) {
  const file = `${o.home}/Library/LaunchAgents/${o.name}.plist`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(o.name)}</string>
  <key>ProgramArguments</key>
  <array>
${tickArgv(o).map(a => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${x(o.meta)}</string>
  <key>StartInterval</key><integer>${o.interval_min * 60}</integer>
  <key>RunAtLoad</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
  return { files: [{ path: file, content }], install: [['launchctl', 'load', '-w', file]], remove: [['launchctl', 'unload', '-w', file], ['rm', file]] };
}
export default { ...generic(plan, (o, io = realIo) => io.exists(plan(o).files[0].path) && io.run('launchctl', ['list', o.name]).status === 0), owner: readOwner(o => plan(o).files[0].path) };
