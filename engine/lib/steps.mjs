// META-DASH-ASYNC R1 (option a): one path, two drivers. A verb whose writes the CLI runs sync and the dash server must run off the event
// loop is written ONCE as a generator that yields its effects ([op, ...args]); runSteps runs each on the sync io (the CLI), runStepsAsync
// awaits each on the async io (the server). A failed effect is thrown back into the generator (its own try / catch decides), so the
// checks, the order and the error handling are the same code in both.
export function runSteps(gen, io) {
  let r = gen.next();
  while (!r.done) {
    const [op, ...a] = r.value;
    let v;
    try { v = io[op](...a); } catch (e) { r = gen.throw(e); continue; }
    r = gen.next(v);
  }
  return r.value;
}
export async function runStepsAsync(gen, io) {
  let r = gen.next();
  while (!r.done) {
    const [op, ...a] = r.value;
    let v;
    try { v = await io[op](...a); } catch (e) { r = gen.throw(e); continue; }
    r = gen.next(v);
  }
  return r.value;
}
