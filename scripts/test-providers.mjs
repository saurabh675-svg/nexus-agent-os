import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const tempParent=path.resolve(os.tmpdir());
const fixture=await fs.mkdtemp(path.join(tempParent,'nexus-provider-test-'));
await fs.mkdir(fixture+'/lib');
await fs.writeFile(fixture+'/package.json','{"type":"module"}');
for(const file of ['llm.js','providers.js','config.js','util.js','vault.js','model-secrets.js'])await fs.copyFile(new URL('../lib/'+file,import.meta.url),fixture+'/lib/'+file);
const config=await import(pathToFileURL(fixture+'/lib/config.js'));
const llm=await import(pathToFileURL(fixture+'/lib/llm.js'));
const providers=await import(pathToFileURL(fixture+'/lib/providers.js'));
const vault=await import(pathToFileURL(fixture+'/lib/vault.js'));
const modelSecrets=await import(pathToFileURL(fixture+'/lib/model-secrets.js'));
const savedFetch=globalThis.fetch;
const profile=(id,extra={})=>({id,label:id,kind:'openai',baseUrl:'https://'+id+'.invalid/v1',model:id+'-model',apiKey:'fixture-key-'+id,...extra});
const stream=(text)=>new Response('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const run=async(options={})=>{let answer='';for await(const token of llm.chatStream([{role:'user',content:'fixture'}],options))answer+=token;return answer;};
test.after(async()=>{
  globalThis.fetch=savedFetch;
  if(path.dirname(fixture)!==tempParent||!path.basename(fixture).startsWith('nexus-provider-test-'))throw Error('Unsafe fixture path');
  await fs.rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
test('automatic provider fallback defaults to disabled',()=>{
  assert.equal(config.settings().routing.allowRemoteFallback,false);
  assert.equal(config.settings().routing.localFallbackEnabled,false);
});
test('saved API profile overrides stale local label and sends its own API key',async()=>{
  const p=profile('primary');config.saveSettings({provider:'ollama',model:'legacy-local',providers:[p],activeProviderId:p.id});
  let actual;const seen=[];
  globalThis.fetch=async(url,opts)=>{actual={url,opts};return stream('API works');};
  assert.match(llm.currentModelLabel(),/primary-model · Remote API/);
  assert.equal(await run({onProvider:p=>seen.push(p)}),'API works');
  assert.equal(actual.url,p.baseUrl+'/chat/completions');
  assert.equal(actual.opts.headers.authorization,'Bearer '+p.apiKey);
  assert.equal(seen[0].model,p.model);assert.equal(JSON.stringify(seen).includes(p.apiKey),false);
});
test('split OpenAI-compatible tool-call chunks are assembled before emission',async()=>{
  const p=profile('split-tools');config.saveSettings({providers:[p],activeProviderId:p.id,routing:{localFallbackEnabled:false}});
  const chunks=[
    {choices:[{delta:{tool_calls:[{index:0,function:{name:'spawn_',arguments:'{"role":'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{name:'agent',arguments:'"researcher"}'}}]}}]},
  ];
  globalThis.fetch=async()=>new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const result=await run();
  assert.match(result,/```tool\n\{"tool":"spawn_agent","args":\{"role":"researcher"\}\}\n```/);
});
test('fallback reports the provider that actually answers',async()=>{
  const a=profile('limited'),b=profile('fallback');config.saveSettings({providers:[a,b],activeProviderId:a.id,routing:{allowRemoteFallback:true}});
  const served=[];globalThis.fetch=async url=>url.includes('limited.invalid')?new Response('rate limit',{status:429}):stream('fallback answer');
  assert.match(await run({onProvider:p=>served.push(p)}),/fallback answer/);
  assert.equal(served.length,1);assert.equal(served[0].id,b.id);
});
test('Ollama local service and cloud proxy are distinguished without attaching API credentials',async()=>{
  const p=profile('ollama',{kind:'ollama',baseUrl:'http://127.0.0.1:11434',model:'gemma:local'});
  config.saveSettings({providers:[p],activeProviderId:p.id});
  assert.equal(llm.providerInfo().location,'Local service');
  p.model='gemma4:31b-cloud';config.saveSettings({providers:[p]});
  assert.equal(llm.providerInfo().location,'Ollama Cloud via local service');
  globalThis.fetch=async(url,opts)=>{assert.equal(opts.headers.authorization,undefined);return new Response('{"message":{"content":"cloud proxy works"},"done":true}\n');};
  assert.equal(await run(),'cloud proxy works');
});
test('model discovery uses the active API profile instead of stale local settings',async()=>{
  const p=profile('discovery');config.saveSettings({provider:'ollama',providers:[p],activeProviderId:p.id});
  globalThis.fetch=async(url,opts)=>{assert.equal(url,p.baseUrl+'/models');assert.equal(opts.headers.authorization,'Bearer '+p.apiKey);return Response.json({data:[{id:p.model}]});};
  const result=await llm.listModels({fresh:true});assert.deepEqual(result.models,[p.model]);assert.equal(result.error,undefined);
});
test('public settings never return the saved API profile key',()=>{
  const p=profile('secret',{key:'legacy-fixture-secret'});config.saveSettings({providers:[p]});
  const settings=config.publicSettings();assert.equal(settings.providers[0].apiKey.startsWith('••••'),true);
  assert.equal(JSON.stringify(settings).includes(p.apiKey),false);assert.equal(JSON.stringify(settings).includes(p.key),false);
  assert.equal(JSON.stringify(providers.list()).includes(p.key),false);
});
test('local compatible API works without an undefined bearer token',async()=>{
  const p=profile('local',{baseUrl:'http://127.0.0.1:1234/v1',apiKey:''});config.saveSettings({providers:[p],activeProviderId:p.id});
  assert.equal(llm.providerInfo().location,'Local service');
  globalThis.fetch=async(url,opts)=>{assert.equal(opts.headers.authorization,undefined);return stream('local answer');};
  assert.equal(await run(),'local answer');
});
test('an unconfigured legacy API still has a readable status label',()=>{
  config.saveSettings({provider:'openai',providers:[],activeProviderId:'',openai:{baseUrl:'https://legacy.invalid/v1',apiKey:'',model:'choose-a-model'}});
  assert.match(llm.currentModelLabel(),/choose-a-model · Remote API/);
});
test('changing providers invalidates the model catalogue cache',async()=>{
  const a=profile('first'),b=profile('second');let requests=0;
  globalThis.fetch=async url=>{requests++;return Response.json({data:[{id:url.includes('first.invalid')?a.model:b.model}]});};
  config.saveSettings({providers:[a,b],activeProviderId:a.id});assert.deepEqual((await llm.listModels({fresh:true})).models,[a.model]);
  config.saveSettings({activeProviderId:b.id});assert.deepEqual((await llm.listModels()).models,[b.model]);assert.equal(requests,2);
});
test('remote and local failover are independently opt-in',()=>{
  const local=profile('local',{baseUrl:'http://127.0.0.1:1234/v1',apiKey:''});
  const cloud=profile('cloud');
  config.saveSettings({providers:[local,cloud],activeProviderId:local.id,routing:{allowRemoteFallback:false,localFallbackEnabled:false}});
  assert.deepEqual(providers.chain().map(p=>p.id),['local']);
  config.saveSettings({routing:{allowRemoteFallback:true}});
  assert.deepEqual(providers.chain().map(p=>p.id),['local','cloud']);
  config.saveSettings({activeProviderId:cloud.id,routing:{allowRemoteFallback:false}});
  assert.deepEqual(providers.chain().map(p=>p.id),['cloud']);
  config.saveSettings({routing:{localFallbackEnabled:true}});
  assert.deepEqual(providers.chain().map(p=>p.id),['cloud','local','ollama-local-fallback']);
});
test('automatic fallback is disabled by default, including configured local providers',async()=>{
  const remote=profile('primary');
  const local=profile('local',{baseUrl:'http://127.0.0.1:1234/v1',apiKey:''});
  config.saveSettings({
    providers:[remote,local],
    activeProviderId:remote.id,
    ollamaUrl:'http://127.0.0.1:11434',
    routing:{allowRemoteFallback:false,localFallbackEnabled:false},
  });
  assert.deepEqual(providers.chain().map(p=>p.id),[remote.id]);
});
test('explicit local fallback retries Ollama without enabling remote failover',async()=>{
  const remote=profile('primary');
  config.saveSettings({
    providers:[remote],
    activeProviderId:remote.id,
    ollamaUrl:'http://127.0.0.1:11434',
    routing:{allowRemoteFallback:false,localFallbackEnabled:true,localFallbackModel:'qwen2.5:7b'},
  });
  assert.deepEqual(providers.chain().map(p=>p.id),[remote.id,'ollama-local-fallback']);
  const attempts=[];
  globalThis.fetch=async(url)=>{
    attempts.push(url);
    if(url.includes('primary.invalid')) return new Response('rate limited',{status:429});
    return new Response('{"message":{"content":"local retry worked"},"done":true}\n');
  };
  assert.match(await run(),/local retry worked/);
  assert.equal(attempts.length,2);
  assert.match(attempts[1],/127\.0\.0\.1:11434\/api\/chat/);
});
test('model API keys do not require Vault and are not written to settings',async()=>{
  const secret='fixture-vercel-api-key-do-not-persist';
  config.saveSettings({providers:[],activeProviderId:''});
  const saved=providers.upsert({
    id:'secure-provider',
    label:'Secure provider',
    kind:'openai',
    baseUrl:'https://secure.invalid/v1',
    model:'secure-model',
    apiKey:secret,
  });
  assert.equal(saved.apiKey,'');
  assert.equal(saved.secretId,'');
  assert.equal(providers.list()[0].keyStorage,'session-only');
  assert.equal(providers.chain()[0].apiKey,secret);
  assert.equal(vault.exists(),false);
  assert.equal(modelSecrets.mode(),'session-only');
  const settingsDisk=await fs.readFile(config.SETTINGS_FILE,'utf8');
  assert.equal(settingsDisk.includes(secret),false);
  assert.equal(JSON.stringify(config.publicSettings()).includes(secret),false);

  const legacySecret='legacy-provider-key-needs-migration';
  config.saveSettings({providers:[profile('legacy',{apiKey:'',key:legacySecret})],activeProviderId:'legacy'});
  providers.upsert({id:'legacy',model:'legacy-model'});
  const migratedDisk=await fs.readFile(config.SETTINGS_FILE,'utf8');
  assert.equal(migratedDisk.includes(legacySecret),false);
  assert.equal(providers.chain()[0].apiKey,legacySecret);
  assert.equal(providers.list()[0].keyStorage,'session-only');
});
test('a legacy Vault API key can be replaced without unlocking or creating Vault settings',()=>{
  const passphrase='fixture vault passphrase';
  vault.create(passphrase);
  const entry=vault.add({service:'legacy provider',password:'legacy-vault-api-key'});
  config.saveSettings({providers:[{...profile('vault-legacy',{apiKey:''}),secretId:entry.id}],activeProviderId:'vault-legacy'});
  vault.lock();
  assert.match(providers.chain()[0].credentialError,/legacy Vault key/);
  providers.upsert({id:'vault-legacy',apiKey:'new-cloud-key'});
  assert.equal(providers.chain()[0].apiKey,'new-cloud-key');
  assert.equal(providers.list()[0].keyStorage,'session-only');
});
test('free-model discovery reports and filters image and tool capabilities',async()=>{
  globalThis.fetch=async()=>Response.json({data:[
    {id:'free-vision',name:'Free vision',pricing:{prompt:'0',completion:'0'},architecture:{input_modalities:['text','image']},supported_parameters:['tools'],context_length:32000},
    {id:'free-text',name:'Free text',pricing:{prompt:'0',completion:'0'},architecture:{input_modalities:['text']},supported_parameters:[],context_length:64000},
    {id:'paid-vision',name:'Paid vision',pricing:{prompt:'0.1',completion:'0.2'},architecture:{input_modalities:['text','image']},supported_parameters:['tools'],context_length:128000},
  ]});
  const result=await providers.discoverFreeModels({onlyFree:true,visionOnly:true});
  assert.equal(result.visionFree,1);
  assert.deepEqual(result.models.map(m=>m.id),['free-vision']);
  assert.equal(result.models[0].supportsTools,true);
});
test('provider presets include Vercel Gateway, NVIDIA NIM and direct Ollama Cloud',()=>{
  const ids=providers.PRESETS.map(p=>p.id);
  assert.ok(ids.includes('vercel-ai-gateway'));
  assert.ok(ids.includes('nvidia-nim'));
  assert.ok(ids.includes('ollama-cloud-api'));
  assert.equal(providers.PRESETS.find(p=>p.id==='vercel-ai-gateway').baseUrl,'https://ai-gateway.vercel.sh/v1');
  assert.equal(providers.PRESETS.find(p=>p.id==='ollama-cloud-api').baseUrl,'https://ollama.com/v1');
});
