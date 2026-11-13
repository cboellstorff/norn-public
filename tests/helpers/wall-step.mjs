// META-GTP-CI-FILLWAKE F1: a preload (node --import) that steps the WALL clock forward 1 h, 300 ms after start, while the monotonic
// clock (performance.now / process.hrtime) runs on - the WSL runner's unsynchronized clock steps like this.
// CIRED-5393965: META_WALL_STEP_MS moves the step (a test's own waitFor starts later than 300 ms; the step must land inside it).
const real = Date.now, t0 = real(), at = Number(process.env.META_WALL_STEP_MS) || 300;
Date.now = () => { const t = real(); return t - t0 > at ? t + 3600000 : t; };
