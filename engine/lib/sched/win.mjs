// Windows Task Scheduler (D13): schtasks /Create /XML keeps IgnoreNew, hidden, battery, 55 min limit (= today's install.ps1).
// The action is a hidden PowerShell shim (design 13 fallback) so no console window flashes. GOLDEN-TESTED ONLY in S5.
import { generic, tickArgv, realIo, ownerOf } from './common.mjs';

const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const q = s => `'${String(s).replace(/'/g, "''")}'`;
export function plan(o) {
  const file = `${o.meta}/local/${o.name}.task.xml`;
  const user = o.user || `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ${tickArgv(o).map(q).join(' ')}"`;
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Norn tick: norn status + one check-in per project, every ${o.interval_min} min</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition><Interval>PT${o.interval_min}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${x(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT55M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>powershell.exe</Command><Arguments>${x(args)}</Arguments><WorkingDirectory>${x(o.meta)}</WorkingDirectory></Exec>
  </Actions>
</Task>
`;
  return { files: [{ path: file, content, encoding: 'utf16le' }],
    install: [['schtasks', '/Create', '/TN', o.name, '/XML', file, '/F']],
    remove: [['schtasks', '/Delete', '/TN', o.name, '/F'], ['rm', file]] };
}
export default { ...generic(plan, (o, io = realIo) => io.run('schtasks', ['/Query', '/TN', o.name]).status === 0),
  owner: (o, io = realIo) => { const r = io.run('schtasks', ['/Query', '/TN', o.name, '/XML']); return r.status === 0 ? ownerOf(String(r.stdout || '')) : null; } };
