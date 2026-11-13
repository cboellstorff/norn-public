// systemd --user timer (D13, Linux; live-tested in WSL at S5). KillMode=process: the tick's detached supervisor outlives the unit.
import { generic, tickArgv, realIo, readOwner } from './common.mjs';

const dq = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
export function plan(o) {
  const dir = `${o.home}/.config/systemd/user`, svc = `${dir}/${o.name}.service`, tmr = `${dir}/${o.name}.timer`;
  const service = `[Unit]
Description=meta-controller tick (norn status + one check-in per project)

[Service]
Type=oneshot
WorkingDirectory=${o.meta}
ExecStart=${tickArgv(o).map(dq).join(' ')}
KillMode=process
TimeoutStartSec=55min
`;
  const timer = `[Unit]
Description=meta-controller tick every ${o.interval_min} min

[Timer]
OnBootSec=2min
OnUnitActiveSec=${o.interval_min}min
AccuracySec=1min

[Install]
WantedBy=timers.target
`;
  return { files: [{ path: svc, content: service }, { path: tmr, content: timer }],
    install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${o.name}.timer`]],
    remove: [['systemctl', '--user', 'disable', '--now', `${o.name}.timer`], ['rm', svc], ['rm', tmr], ['systemctl', '--user', 'daemon-reload']] };
}
export default { ...generic(plan, (o, io = realIo) => io.run('systemctl', ['--user', 'is-enabled', `${o.name}.timer`]).status === 0), owner: readOwner(o => plan(o).files[0].path) };
