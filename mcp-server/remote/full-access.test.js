import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { operations, bindOperation, operationSchema, fullAccessTools } from './api-catalogue.js';
import { inspectApi } from '../scripts/inspect-api.js';
import { z } from 'zod';
import * as policy from './api-policy.js';
import { scopesFor } from './api-policy.js';
import { createResultStore } from './results.js';
import { createApp } from './app.js';
import { createBackend } from './backend.js';
import { readConfig } from './config.js';
import { redact } from './tools.js';

const config = readConfig({ MCP_PUBLIC_URL: 'https://neuro.example/mcp', MCP_AUTH_ISSUER: 'https://auth.example/', MCP_AUTH_JWKS_URL: 'https://auth.example/jwks', MCP_AUTH_SUBJECT: 'nick', NEURO_API_TOKEN: 'backend-test-secret', NEURO_VAULT_KEY: 'vault-test-secret' });
const auth = { scopes: ['neuro:read', 'neuro:write', 'neuro:action', 'neuro:admin'] };

test('every mounted NEURO route is inventoried; source changes cannot silently leave MCP behind', () => {
  const stored = JSON.parse(fs.readFileSync(new URL('./api-inventory.json', import.meta.url)));
  const contract = ({line,description,...op})=>op;
  assert.deepEqual(stored.map(contract), inspectApi().map(contract));
  assert.equal(new Set(operations.map(o=>o.id)).size, operations.length);
  assert.ok(operations.length >= 500);
});
test('all registered operations bind to fixed routes and expose serializable input schemas', () => {
  for (const op of operations) {
    const input = { params: Object.fromEntries(op.params.map(k=>[k,policy.paramEnums[op.id]?.[k]?.[0] ?? 'test-id'])) };
    if (op.multipart) input.file = { filename: 'test.txt', mime_type: 'text/plain', base64: 'dGVzdA==' };
    const bound = bindOperation(op.id, input);
    assert.ok(bound.route.startsWith('/api/')); assert.ok(!bound.route.includes(':'));
    assert.equal(bound.op.method, op.method);
    assert.ok(operationSchema(op));
    assert.ok(['read','write','action','admin'].includes(op.classification));
  }
});
test('read aliases and classification respect mutations hidden behind GET and administrative changes', () => {
  for (const name of ['get_knowledge_memory_reflection', 'get_knowledge_memory_daily_report', 'get_pi_health_watchdog']) assert.equal(operations.find(o=>o.id===name).classification, 'action');
  for (const name of ['post_rooms_by_key_accept','post_email_triage_by_emailId_reply','post_calendar_events','post_actions_by_id_approve']) assert.equal(operations.find(o=>o.id===name).classification, 'action');
  assert.equal(operations.find(o=>o.id==='post_capture_links_by_username_scopes').classification, 'admin');
  assert.equal(bindOperation('post_chat',{}).route, '/api/chat/sync');
  assert.equal(bindOperation('get_nudges_stream',{}).route, '/api/nudges');
});
test('path and query injection, credentials and arbitrary HTTP requests rejected', () => {
  for (const id of ['https://evil.example','shell_exec','get_unknown']) assert.throws(()=>bindOperation(id,{}));
  for (const bad of ['..','../secret','a/b','a\\b']) assert.throws(()=>bindOperation('patch_tasks_by_id',{params:{id:bad}}));
  assert.throws(()=>bindOperation('get_vault_read',{query:{path:'../private.txt'}}));
  assert.throws(()=>bindOperation('get_vault_read',{query:{path:'C:\\private.txt'}}));
  assert.throws(()=>bindOperation('get_vault_read',{query:{path:'Test.md',api_key:'injected'}}));
  assert.throws(()=>bindOperation('get_tasks',{method:'DELETE'}));
});
test('catalogue returns detailed contracts for every operation', async () => {
  const tools = fullAccessTools(config,()=>{},auth,createResultStore(),v=>redact(v,config));
  const catalogue = tools.find(v=>v.name==='neuro_capabilities');
  for (let offset=0; offset<operations.length; offset+=30) {
    const out = await catalogue.run({query:'',offset,limit:30,describe:true});
    assert.equal(out.total,operations.length);
    for (const cap of out.capabilities) assert.ok(cap.input_schema.properties.params);
  }
});
test('all executable operations dispatch once; interactive auth endpoints do not bypass login', async () => {
  const calls = []; const store = createResultStore();
  const tools = fullAccessTools(config, async (route,body,options) => { calls.push({route,body,options}); return {data:{ok:true},format:'json'}; },auth,store,v=>redact(v,config));
  for (const op of operations) {
    const before = calls.length;
    const input = { operation:op.id, params:Object.fromEntries(op.params.map(k=>[k,policy.paramEnums[op.id]?.[k]?.[0] ?? 'abc'])) };
    if (op.multipart) input.file={filename:'test.txt',mime_type:'text/plain',base64:'dGVzdA=='};
    const out = await tools.find(v=>v.name===`neuro_${op.classification}`).run(input);
    assert.equal(calls.length,before+(op.interactive?0:1));
    assert.equal(out.status,op.interactive?'interactive_required':'completed');
    if (!op.interactive) assert.equal(calls.at(-1).options.method,op.method);
  }
});
test('large write results are paged without replay; all pages preserve original scopes and expire', async () => {
  let now=0,calls=0; const store=createResultStore(()=>now);
  const tools=fullAccessTools(config,async()=>{calls++;return {data:'X'.repeat(20000)+'backend-test-secret'};},auth,store,v=>redact(v,config));
  const first=await tools.find(v=>v.name==='neuro_action').run({operation:'post_calendar_events',body:{title:'Test'}});
  const second=await tools.find(v=>v.name==='neuro_result_get').run({result_id:first.result.result_id,offset:first.result.next_offset,length:12000});
  assert.equal(calls,1); assert.equal(second.next_offset,null);
  assert.doesNotMatch(first.result.text+second.text,/backend-test-secret/);
  assert.throws(()=>store.get(first.result.result_id,['neuro:read']),/insufficient_scope/);
  now=300001; assert.throws(()=>store.get(first.result.result_id,auth.scopes),/expired/);
});
test('write scope alone cannot execute external or administrative operations', async () => {
  const tools=fullAccessTools(config,async()=>assert.fail('must not execute'),{scopes:['neuro:read','neuro:write']},createResultStore(),v=>v);
  for (const [tool,operation] of [['neuro_action','post_rooms_by_key_accept'],['neuro_admin','post_ai_settings']]) {
    await assert.rejects(()=>tools.find(v=>v.name===tool).run({operation,...(tool==='neuro_action'?{params:{key:'offer-id'}}:{})}),/insufficient_scope/);
  }
});
test('HTTP transport correctly sends PATCH, DELETE and multipart; handles text and binary responses',async t=>{
  const seen=[];
  const upstream=http.createServer(async(req,res)=>{
    let body='';for await(const c of req) body+=c;
    seen.push({method:req.method,headers:req.headers,body});
    if(req.url==='/api/tts/speak'){res.setHeader('content-type','audio/mpeg');res.end(Buffer.from([1,2,3]));}
    else if(req.url==='/api/weekly-risk/markdown'){res.setHeader('content-type','text/plain');res.end('# Report');}
    else{res.setHeader('content-type','application/json');res.end('{"ok":true}');}
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const api=createBackend({...config,NEURO_API_URL:`http://127.0.0.1:${upstream.address().port}`});
  await api('/api/tasks/1',{text:'changed'},{method:'PATCH',extended:true});
  await api('/api/tasks/1',undefined,{method:'DELETE',extended:true});
  await api('/api/capture/file',{title:'Uploaded'},{method:'POST',extended:true,file:{filename:'test.txt',mime_type:'text/plain',base64:'dGVzdA=='}});
  assert.equal(seen[0].method,'PATCH');assert.equal(seen[1].method,'DELETE');assert.match(seen[2].headers['content-type'],/multipart/);assert.match(seen[2].body,/filename="test.txt"/);
  assert.equal((await api('/api/tts/speak',{text:'hi'},{method:'POST',extended:true})).data,'AQID');
  assert.equal((await api('/api/weekly-risk/markdown',undefined,{extended:true})).data,'# Report');
});
test('D&D vault containment rejects siblings and junction escapes before full remote exposure',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'neuro-dnd-test-'));
  const vault=path.join(root,'vault'),dnd=path.join(vault,'DND'),outside=path.join(root,'outside');
  for(const dir of [dnd,outside,path.join(vault,'DND-other')])fs.mkdirSync(dir,{recursive:true});
  const old={DND_VAULT_PATH:process.env.DND_VAULT_PATH,DND_VAULT_ROOT:process.env.DND_VAULT_ROOT};
  process.env.DND_VAULT_PATH=vault;process.env.DND_VAULT_ROOT='DND';
  const require=createRequire(import.meta.url);
  const modulePath=require.resolve('../../backend/routes/vault-dnd.js');delete require.cache[modulePath];
  const {safeScopedPath}=require(modulePath)._internals;
  t.after(()=>{for(const [k,v]of Object.entries(old))v===undefined?delete process.env[k]:process.env[k]=v;delete require.cache[modulePath];fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(safeScopedPath('note.md'),path.join(dnd,'note.md'));
  assert.equal(safeScopedPath('../DND-other/private.md'),null);
  assert.equal(safeScopedPath('../../outside/private.md'),null);
  fs.symlinkSync(outside,path.join(dnd,'escape'),process.platform==='win32'?'junction':'dir');
  assert.equal(safeScopedPath('escape/new.md'),null);
});
test('credentials and upstream exception text never enter paged results',()=>{
  const cleaned=redact({token:'unknown-token',nested:{apiKey:'unknown-key',error:'SQL error with private content',stack:'trace'},content:'backend-test-secret'},config);
  assert.doesNotMatch(JSON.stringify(cleaned),/unknown-token|unknown-key|SQL error|trace|backend-test-secret/);
});
test('real MCP client discovers and calls the full catalogue, scopes and result reader',async t=>{
  const app=createApp(config,{verify:async token=>({scopes:token==='full'?auth.scopes:['neuro:read']}),api:async()=>({format:'json',data:{tasks:[{id:1,text:'Test'}]}}),log:()=>{}});
  const server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  for(const token of ['full','read']){
    const client=new Client({name:'full-test',version:'1'});t.after(()=>client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const catalogue=await client.callTool({name:'neuro_capabilities',arguments:{query:'tasks',describe:true}});assert.ok(catalogue.structuredContent.capabilities.length);
    const read=await client.callTool({name:'neuro_read',arguments:{operation:'get_tasks'}});assert.ok(!read.isError);
    const action=await client.callTool({name:'neuro_action',arguments:{operation:'post_calendar_events',body:{title:'Test'}}});
    assert.equal(Boolean(action.isError),token==='read');
  }
});

test('standup session kind is a closed set, and a wrong one is refused before NEURO', () => {
  const { paramEnums, notes } = policy;
  for (const id of [...Object.keys(paramEnums), ...Object.keys(notes)]) assert.ok(operations.some(op => op.id === id), `policy names unknown operation ${id}`);
  assert.equal(bindOperation('post_standup_session_by_kind_start', { params: { kind: 'standup' } }).route, '/api/standup-session/standup/start');
  assert.throws(() => bindOperation('post_standup_session_by_kind_start', { params: { kind: 'morning' } }), z.ZodError);
  assert.match(operations.find(op => op.id === 'post_standup_save_to_daily').description, /Focus Today/);
});
