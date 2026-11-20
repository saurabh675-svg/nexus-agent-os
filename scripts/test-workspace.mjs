import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createEventDecoder, streamPost, panelPoll } from '../public/workspace-runtime.js';

test('returning to an existing workspace activates the selected original panel',async()=>{
  const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const manager=source.slice(source.indexOf('const apps = new Map();'),source.indexOf('/* ------------------------------- chat app'));
  const activated=[];
  const context=vm.createContext({activateWorkspace:id=>activated.push(id),$$:()=>[]});
  vm.runInContext(manager+`\nconst makePanel=()=>({el:{style:{},classList:{remove(){},add(){}}}}); registerApp({id:'chat'}); registerApp({id:'files'}); wins.set('chat',makePanel()); wins.set('files',makePanel()); openApp('files'); openApp('chat');`,context);
  assert.deepEqual(activated,['files','chat']);
});

test('legacy provider navigation opens the unified Connections panel', async () => {
  const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const manager = source.slice(source.indexOf('const apps = new Map();'), source.indexOf('/* ------------------------------- chat app'));
  const activated = [];
  const context = vm.createContext({ activateWorkspace: id => activated.push(id), $$: () => [] });
  vm.runInContext(manager + `
    const panel = { el: { style: {}, classList: { remove() {}, add() {} } } };
    registerApp({ id: 'connect' });
    wins.set('connect', panel);
    openApp('providers');
  `, context);
  assert.deepEqual(activated, ['connect']);
});

test('event stream handles every split boundary, CRLF, multiline data and an unterminated final event', () => {
  const input=': ping\r\nevent: delta\r\ndata: {"text":"hello"}\r\n\r\nevent: answer\r\ndata: {\r\ndata: "text":"done"}\r\n\r\nevent: usage\ndata: {"count":3}';
  for(let i=0;i<=input.length;i++) {
    const got=[];const decoder=createEventDecoder((...event)=>got.push(event));
    decoder.push(input.slice(0,i));decoder.push(input.slice(i));decoder.finish();
    assert.deepEqual(got,[['delta',{text:'hello'}],['answer',{text:'done'}],['usage',{count:3}]]);
  }
});
test('HTTP model errors are shown instead of silently treating JSON as an empty stream',async()=>{
  const got=[];
  await streamPost('/api/chat',{},(...e)=>got.push(e),undefined,async()=>Response.json({error:'Model is unavailable'},{status:503}));
  assert.equal(got.length,1);assert.equal(got[0][0],'error');assert.match(got[0][1].message,/Model is unavailable/);
});
test('UTF-8 tokens survive byte chunk boundaries',async()=>{
  const bytes=new TextEncoder().encode('event: answer\ndata: {"text":"हेलो 🌱"}\n\n');
  const stream=new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}});
  const got=[];await streamPost('/api/chat',{},(...e)=>got.push(e),undefined,async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));
  assert.deepEqual(got,[['answer',{text:'हेलो 🌱'}]]);
});
test('broken connections and cancellation return actionable errors',async()=>{
  for(const error of [new Error('Disconnected'),new DOMException('cancel','AbortError')]){
    const got=[];await streamPost('/api/chat',{},(...e)=>got.push(e),undefined,async()=>{throw error;});
    assert.equal(got[0][0],'error');assert.match(got[0][1].message,error.name==='AbortError'?/Stopped/:/Disconnected/);
  }
});
test('malformed event records fail visibly',()=>{
  assert.throws(()=>createEventDecoder(()=>{}).push('data: not-json\n\n'),/unreadable response/);
});
test('closed, hidden and overlapping panels do not keep polling', async()=>{
  const previous={setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,document:globalThis.document};
  let tick,cleared=0,calls=0,finish;const panel={dataset:{inactive:'false'},style:{}};
  const body=new EventTarget();body.isConnected=true;body.closest=()=>panel;
  globalThis.document={hidden:false};globalThis.setInterval=(f)=>{tick=f;return 7};globalThis.clearInterval=(id)=>{assert.equal(id,7);cleared++};
  try{
    panelPoll(body,()=>{calls++;return new Promise(r=>finish=r)},100);
    const running=tick();await tick();assert.equal(calls,1);finish();await running;
    panel.dataset.inactive='true';await tick();assert.equal(calls,1);
    panel.dataset.inactive='false';globalThis.document.hidden=true;await tick();assert.equal(calls,1);
    body.dispatchEvent(new Event('nexus-dispose'));assert.equal(cleared,1);
  }finally{Object.assign(globalThis,previous);}
});
