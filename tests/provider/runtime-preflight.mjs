/** Public runtime diagnostics only. Does not submit any generation turn. */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
const exe = process.env.CODEX_PROBE_EXECUTABLE || 'C:/Users/PC/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
const disabled = ['shell_tool','unified_exec','apps','hooks','plugin_hooks','plugins','remote_plugin','auth_elicitation','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','multi_agent','code_mode','code_mode_host','code_mode_buffered_exec','code_mode_only','js_repl','skill_mcp_dependency_install','skill_search','shell_snapshot','memories','memory_tool','request_permissions','goals','tool_suggest','workspace_dependencies'];
const overrides = ['model_provider="openai"','openai_base_url="https://chatgpt.com/backend-api/codex"','chatgpt_base_url="https://chatgpt.com"','forced_login_method="chatgpt"','mcp_servers={}','plugins={}','web_search="disabled"','allow_login_shell=false','project_doc_max_bytes=0','sandbox_mode="read-only"', 'features.image_generation=true', ...disabled.map(n=>`features.${n}=false`)];
overrides.push('features.multi_agent_v2.enabled=false','analytics.enabled=false','feedback.enabled=false','otel.exporter="none"','otel.trace_exporter="none"','otel.metrics_exporter="none"','otel.log_user_prompt=false');
if(process.env.CODEX_OFFICIAL_MODEL_CATALOG)overrides.push(`model_catalog_json=${JSON.stringify(process.env.CODEX_OFFICIAL_MODEL_CATALOG.replaceAll('\\','/'))}`);
const env = {...process.env};
for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_PROJECT_ID','CODEX_OPENAI_BASE_URL','CHATGPT_BASE_URL','CODEX_CHATGPT_BASE_URL','OPENAI_API_BASE','OPENAI_API_HOST','OPENAI_AUTH_TOKEN','OPENAI_CUSTOM_HEADERS','OPENAI_HTTP_HEADERS']) delete env[name];
const inventory=spawnSync(exe,['mcp','list','--json',...overrides.flatMap(v=>['-c',v])],{env,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024,timeout:15000});
if(inventory.status!==0)throw new Error('Public MCP inventory unavailable');
const serverNames=JSON.parse(inventory.stdout).map(s=>s.name);
for(const name of serverNames){if(typeof name!=='string'||name.length<1||name.length>256||/[.="\u0000-\u001f]/.test(name))throw new Error('MCP inventory invalid');overrides.push(`mcp_servers.${name}.enabled=false`);overrides.push(`mcp_servers.${name}.enabled_tools=[]`)}
const proc=spawn(exe,['app-server','--listen','stdio://',...overrides.flatMap(v=>['-c',v])],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
let seq=0; const pending=new Map(); let stderrBytes=0; let diagnostics='';
proc.stderr.on('data', b=>{stderrBytes+=b.length;if(diagnostics.length<2048)diagnostics+=b.toString('utf8')});
proc.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('runtime exited'));}pending.clear();});
const rl=createInterface({input:proc.stdout});
rl.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(`RPC rejected ${p.method} code=${m.error.code}`)):p.resolve(m.result);}else if(m.id!=null&&m.method){proc.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Client operation not permitted'}})+'\n')}});
function rpc(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout ${method}`));},25000);pending.set(id,{resolve,reject,timer,method});proc.stdin.write(JSON.stringify({id,method,params})+'\n')})}
try{
 await rpc('initialize',{clientInfo:{name:'asset_image_provider',version:'0.1.0'},capabilities:{experimentalApi:true}});
 proc.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const account=await rpc('account/read',{refreshToken:false});
 const config=await rpc('config/read',{includeLayers:false});
 const features=await rpc('experimentalFeature/list',{limit:100});
 const mcp=await rpc('mcpServerStatus/list',{limit:100});
 const cap=await rpc('modelProvider/capabilities/read');
 const models=await rpc('model/list',{includeHidden:false,limit:100});
 if(process.env.CODEX_DIAGNOSTIC_THREAD_ID){
  const threadId=process.env.CODEX_DIAGNOSTIC_THREAD_ID,turnId=process.env.CODEX_DIAGNOSTIC_TURN_ID;
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(threadId)||!/^[A-Za-z0-9_-]{1,256}$/.test(turnId??''))throw new Error('Diagnostic identifier invalid');
  try{
   const read=await rpc('thread/read',{threadId,includeTurns:true});
   const turn=(read.thread?.turns??[]).find(t=>t.id===turnId);
   const allowed=['contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','serverOverloaded','cyberPolicy','internalServerError','unauthorized','badRequest','threadRollbackFailed','sandboxError','other'];
   const info=turn?.error?.codexErrorInfo;
   const objectClasses=['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts','activeTurnNotSteerable'];
   const objectClass=info&&typeof info==='object'?objectClasses.find(k=>Object.hasOwn(info,k)):null;
   const status=objectClass?info[objectClass]?.httpStatusCode:null;
   console.log(JSON.stringify({priorFailureRead:{readOnly:true,threadId,turnId,method:'thread/read',causeRecovered:turn?.status==='failed'&&turn?.error!=null,turnStatus:['inProgress','completed','interrupted','failed'].includes(turn?.status)?turn.status:null,codexErrorInfo:allowed.includes(info)?info:objectClass??'unknown',httpStatusCode:Number.isInteger(status)&&status>=100&&status<=599?status:null,rawTextDiscarded:true}}));
  }catch(e){console.log(JSON.stringify({priorFailureRead:{readOnly:true,threadId,turnId,method:'thread/read',causeRecovered:false,publicRequestError:e.message,rawTextDiscarded:true}}));}
 }
 console.log(JSON.stringify({telemetry:{analyticsEnabled:config.config?.analytics?.enabled??null,feedbackEnabled:config.config?.feedback?.enabled??null,exporter:config.config?.otel?.exporter??null,traceExporter:config.config?.otel?.trace_exporter??null,metricsExporter:config.config?.otel?.metrics_exporter??null,logUserPrompt:config.config?.otel?.log_user_prompt??null}}));
 const safeModel=v=>typeof v==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(v)?v:null;
 const provider=config.config?.model_providers?.openai;
 let originApproved=null;if(typeof provider?.base_url==='string'){try{const u=new URL(provider.base_url);originApproved=['https://api.openai.com','https://chatgpt.com'].includes(u.origin)&&!u.username&&!u.password&&!u.search&&!u.hash}catch{originApproved=false}}
 console.log(JSON.stringify({officialProviderConfiguration:{explicitDefinitionPresent:provider!=null,definitionKeys:provider?Object.keys(provider):[],baseUrlPresent:typeof provider?.base_url==='string',baseUrlOfficialOrigin:originApproved,credentialOverridesPresent:provider?['auth','env_key','experimental_bearer_token','gateway_oauth','http_headers','env_http_headers','query_params'].some(k=>provider[k]!=null):false,topLevelOpenaiBaseUrlPresent:config.config?.openai_base_url!=null,topLevelOpenaiBaseUrlIsOfficialNative:config.config?.openai_base_url==='https://chatgpt.com/backend-api/codex',topLevelOpenaiBaseUrlIsOfficialApi:config.config?.openai_base_url==='https://api.openai.com/v1',chatgptBaseUrlPinned:config.config?.chatgpt_base_url==='https://chatgpt.com'},customModelCatalogConfigured:config.config?.model_catalog_json!=null}));
 console.log(JSON.stringify({generationAttempted:false,authType:account.account?.type??null,modelProvider:config.config?.model_provider,configuredReasoningModel:safeModel(config.config?.model),catalogModels:(models.data??[]).map(m=>({id:safeModel(m.id),model:safeModel(m.model),isDefault:m.isDefault===true})),modelNextCursor:models.nextCursor??null,webSearch:config.config?.web_search,sandbox:config.config?.sandbox_mode,forcedLoginMethod:config.config?.forced_login_method,configFeatureKeys:config.config?.features??null,configMcpEnabledFlags:Object.values(config.config?.mcp_servers??{}).map(s=>s.enabled??null),mcpCount:mcp.data?.length??null,mcpExposedToolCount:(mcp.data??[]).reduce((n,s)=>n+Object.keys(s.tools??{}).length,0),mcpStates:(mcp.data??[]).map(s=>({enabled:s.enabled,authStatus:s.authStatus,toolCount:Object.keys(s.tools??{}).length})),mcpNextCursor:mcp.nextCursor??null,featureFlags:(features.data??[]).filter(x=>disabled.includes(x.name)||x.name==='image_generation').map(x=>({name:x.name,enabled:x.enabled})),featureNextCursor:features.nextCursor??null,nativeImageGeneration:cap.imageGeneration,stderrBytesDiscarded:stderrBytes},null,2));
}catch(e){console.log(JSON.stringify({generationAttempted:false,error:e.message,stderrBytesDiscarded:stderrBytes,knownKeysMentioned:overrides.map(v=>v.split('=')[0]).filter(k=>diagnostics.includes(k)),safeValidationWords:['unknown','duplicate','invalid','missing','feature','field','strict','configuration','parse','command','url','enabled_tools','enabled','empty','transport','exactly','both'].filter(w=>diagnostics.includes(w))}));process.exitCode=1}
finally{rl.close();proc.stdin.end();proc.kill();}
