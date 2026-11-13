// Engine copy of meta/dash/sessions.mjs (S6): unchanged except the registry records the session project.
// Talkable agent sessions (DASH3): long-lived `claude -p` stream-json processes with stdin kept open.
// Registry meta\sessions\<name>.json + transcript meta\sessions\<name>.jsonl, so a reload / restart re-renders history.
import { readFile, writeFile, appendFile, mkdir, readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const NAME=/^[a-z0-9][a-z0-9-]{0,40}$/;
const clip=(s,n)=>{s=String(s??'');return s.length>n?s.slice(0,n)+'…':s;};

// One compact, renderable item per stream-json event (assistant text, tool call / result collapsed, notices).
export function compact(ev) {
  if(!ev||typeof ev!=='object')return [];
  if(ev.type==='owner')return [{kind:'owner',text:ev.text,ts:ev.ts}];
  if(ev.type==='assistant'&&Array.isArray(ev.message?.content))return ev.message.content.flatMap(c=>
    c.type==='text'&&c.text.trim()?[{kind:'text',text:c.text}]:
    c.type==='tool_use'?[{kind:'tool',name:c.name,text:clip(JSON.stringify(c.input??{}),200)}]:[]);
  if(ev.type==='user'&&Array.isArray(ev.message?.content))return ev.message.content.flatMap(c=>c.type==='tool_result'?
    [{kind:'result',text:clip(Array.isArray(c.content)?c.content.map(x=>x.text??'').join('\n'):c.content,600)}]:[]);
  if(ev.type==='result')return [{kind:'notice',text:`turn ended (${ev.subtype??'?'}) · $${(ev.total_cost_usd??0).toFixed(2)}`}];
  if(ev.type==='system'&&ev.subtype&&ev.subtype!=='init')return [{kind:'notice',text:clip(ev.subtype+(ev.summary?': '+ev.summary:''),200)}];
  if(ev.type==='dash')return [{kind:'notice',text:ev.text}];
  return [];
}
// Context size of the latest model call: input + cache read + cache creation (the handoff rule counts this).
export function contextTokens(ev) {
  const u=ev?.type==='assistant'?ev.message?.usage:undefined;
  return u?(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0):null;
}

export function createSessions({dir,exe,spawnFn=spawn,onText=()=>{}}) {
  const live=new Map();
  // the records this process started: exit / end are set in memory at close, their save queues behind the transcript writes
  const own=new Map();
  const reg=n=>path.join(dir,n+'.json'),log=n=>path.join(dir,n+'.jsonl');
  async function save(rec) { await mkdir(dir,{recursive:true});const tmp=reg(rec.name)+'.tmp';await writeFile(tmp,JSON.stringify(rec,null,2));await rename(tmp,reg(rec.name)); }
  async function record(name,ev) { await appendFile(log(name),JSON.stringify(ev)+'\n','utf8'); }
  async function list() {
    let names=[];try { names=(await readdir(dir)).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5)); } catch(e) { if(e.code!=='ENOENT')throw e; }
    const out=[];
    for(const n of names) { try { const r=own.get(n)??JSON.parse(await readFile(reg(n),'utf8'));out.push({...r,alive:live.has(n),busy:live.get(n)?.busy??false}); } catch {} }
    return out.sort((a,b)=>String(b.start).localeCompare(String(a.start)));
  }
  async function transcript(name,from=0) {
    if(!NAME.test(name))throw Object.assign(new Error('Unknown session'),{status:404});
    let raw;try { raw=await readFile(log(name),'utf8'); } catch(e) { if(e.code==='ENOENT')throw Object.assign(new Error('Unknown session'),{status:404});throw e; }
    const rows=raw.split('\n').filter(Boolean);
    return {count:rows.length,items:rows.slice(from).flatMap(r=>{try{return compact(JSON.parse(r));}catch{return [];}})};
  }
  function userMessage(text) { return JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text}]}})+'\n'; }
  async function start({name,kind,lane=null,project=null,model,effort,cwd,prompt,args=[]}) {
    if(!NAME.test(name))throw Object.assign(new Error('Session name: lower-case letters, digits, dashes'),{status:400});
    if(live.has(name))throw Object.assign(new Error('Session already running'),{status:409});
    const argv=['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model',model,'--effort',effort,...args];
    const child=spawnFn(exe,argv,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const rec={name,kind,lane,project,model,effort,cwd,pid:child.pid,start:new Date().toISOString(),end:null,exit:null,context:null,transcript:log(name)};
    const s={child,rec,busy:true,buf:'',writes:Promise.resolve()};live.set(name,s);own.set(name,rec);
    const queue=fn=>{s.writes=s.writes.then(fn).catch(()=>{});return s.writes;};
    await save(rec);await record(name,{type:'dash',text:`started ${kind} · ${model} / ${effort}`});
    child.stdout.on('data',b=>{
      s.buf+=b.toString('utf8');let i;
      while((i=s.buf.indexOf('\n'))>=0) {
        const row=s.buf.slice(0,i).trim();s.buf=s.buf.slice(i+1);if(!row)continue;
        let ev;try { ev=JSON.parse(row); } catch { continue; }
        const ctx=contextTokens(ev);if(ctx!==null)rec.context=ctx;
        if(ev.type==='result')s.busy=false;
        if(ev.type==='assistant')for(const c of ev.message?.content??[])if(c.type==='text')onText(rec,c.text);
        queue(async()=>{await record(name,ev);if(ctx!==null)await save(rec);});
      }
    });
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',e=>queue(()=>record(name,{type:'dash',text:'spawn failed: '+e.message})));
    child.on('close',code=>{live.delete(name);clearTimeout(s.killTimer);rec.exit=code;rec.end=new Date().toISOString();
      queue(async()=>{await record(name,{type:'dash',text:`process exited ${code}`});await save(rec);});});
    if(prompt)await send(name,prompt);
    return rec;
  }
  async function send(name,text) {
    const s=live.get(name);if(!s)throw Object.assign(new Error('Session is not running'),{status:409});
    await record(name,{type:'owner',text,ts:new Date().toISOString()});
    s.busy=true;s.child.stdin.write(userMessage(text));return {ok:true};
  }
  function stop(name,graceMs=30000) {
    const s=live.get(name);if(!s)throw Object.assign(new Error('Session is not running'),{status:409});
    s.child.stdin.end();
    s.killTimer=setTimeout(()=>{ if(live.has(name)) { if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(s.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});else s.child.kill('SIGKILL'); } },graceMs);
    s.killTimer.unref?.();return {ok:true};
  }
  async function stopAll() { for(const n of [...live.keys()])try{stop(n,2000);}catch{} }
  return {start,send,stop,stopAll,list,transcript,isLive:n=>live.has(n)};
}
