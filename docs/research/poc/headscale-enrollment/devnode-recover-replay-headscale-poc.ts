import {matchesListedKey} from './headscale-key-metadata';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root='/Users/rebui/.local/state/dotfiles/headscale-poc/r-ff48fa9e26c54c85';
const binaryRoot='/Users/rebui/.local/state/dotfiles/headscale-poc/mac-9f8f6a26-3686-455f-be33-0e6ddb845105';
const id='ff48fa9e-26c5-4c85-b97e-8d1b9432d152';
const userName='poc-mac-'+id;
const hostName='mac-poc-'+id;
const projectId='65933584-7b10-4469-97eb-bc3c920326fb';
const site='https://secrets.rebuildup.dev';
const server='https://headscale.rebuildup.dev';
const cli='/Users/rebui/.local/share/mise/installs/infisical/0.44.8/infisical';
const journal=root+'/network-replay-recovery.json';
if(!process.argv.includes('--execute')||existsSync(journal))throw new Error('Requires explicit fresh execution; inspect any prior journal before retry.');
const record:any={instanceId:id,userName,hostName,projectId,server,secretName:'HEADSCALE_REGISTRATION_9F8F6A26_3686_455F_BE33_0E6DDB845105',sourceInstanceId:'9f8f6a26-3686-455f-be33-0e6ddb845105',stage:'preflight',startedAt:new Date().toISOString()};
const save=()=>writeFileSync(journal,JSON.stringify(record,null,2)+'\n',{mode:0o600});save();
let human='',key='';
function api(method:string,path:string,body?:unknown){
 const config=['url = '+JSON.stringify(site+path),'request = '+JSON.stringify(method),'header = "Accept: application/json"','header = '+JSON.stringify('Authorization: Bearer '+human),...(body===undefined?[]:['header = "Content-Type: application/json"','data = '+JSON.stringify(JSON.stringify(body))])].join('\n')+'\n';
 const p=spawnSync('/usr/bin/curl',['-q','--silent','--show-error','--no-location','--proto','=https','--max-time','15','--config','-','--write-out','\n%{http_code}'],{input:config,encoding:'utf8',timeout:18000,maxBuffer:1024*1024});
 if(p.status!==0)throw new Error('Provider transport failed.');
 const n=p.stdout.lastIndexOf('\n');if(Number(p.stdout.slice(n+1))!==200)throw new Error('Provider operation failed.');
 return JSON.parse(p.stdout.slice(0,n));
}
function headscale(command:string){
 return JSON.parse(execFileSync('/usr/bin/ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','rebuildup-secrets-host','docker compose --project-name devnode-headscale --project-directory /srv/devnode-headscale exec -T headscale headscale '+command+' --output json'],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}));
}
const childEnv={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TS_LOGS_DIR:root+'/logs'};
function local(args:string[],input?:string){return spawnSync(binaryRoot+'/tailscale/1.104.2/bin/tailscale',['--socket='+root+'/control.sock',...args],{env:childEnv,input,encoding:'utf8',timeout:40000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']});}
try{
 const initial=local(['status','--json']);
 if(initial.status!==0||JSON.parse(initial.stdout).BackendState!=='NeedsLogin')throw new Error('Expected owned unregistered daemon.');
 human=execFileSync(cli,['user','get','token','--plain','--domain',site+'/api'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
 if(!human||/\s/.test(human))throw new Error('Invalid operator credential.');
 const ws=api('GET','/api/v1/workspace/'+projectId).workspace;
 if(ws.name!=='devnode-operators-04decc5b-c71a-4c96-9e05-bb622909d864'||ws.orgId!=='d808df2c-ec67-4046-b733-8c0db0bfa47d')throw new Error('Operator project ownership differs.');
 const base='/api/v1/projects/'+projectId;
 const humans=api('GET',base+'/memberships').memberships;
 const identities=api('GET',base+'/memberships/identities');
 const groups=api('GET',base+'/memberships/groups').groupMemberships;
 if(!Array.isArray(humans)||humans.length!==1||!humans[0].roles?.some((x:any)=>x.role==='admin')||identities.totalCount!==0||identities.identityMemberships?.length!==0||groups?.length!==0)throw new Error('Operator membership differs.');
 const keys=headscale('preauthkeys list');
 const used=keys.filter((p:any)=>String(p.id)==='2'&&String(p.user?.id)==='1');
 if(used.length!==1||used[0].used!==true||used[0].reusable===true||used[0].ephemeral!==true)throw new Error('Expected exact previously consumed key.');
 const expiresAt=Number(used[0].expiration?.seconds)*1000+Number(used[0].expiration?.nanos??0)/1e6;
 if(!Number.isFinite(expiresAt)||Date.now()+5000>=expiresAt)throw new Error('Key too close to natural expiry.');
 const before=headscale('nodes list');
 if(!Array.isArray(before)||before.length!==1||String(before[0].id)!=='1')throw new Error('Expected one original node.');
 const query=new URLSearchParams({projectId,environment:'dev',secretPath:'/',expandSecretReferences:'false',includeImports:'false'});
 key=api('GET','/api/v4/secrets/'+record.secretName+'?'+query).secret?.secretValue;
 if(typeof key!=='string'||!matchesListedKey(key,used[0].key))throw new Error('Central stored credential differs from consumed server key.');
 if(Date.now()+5000>=expiresAt)throw new Error('Key expired before attempt.');
 record.stage='replay-attempt';record.consumedKeyId='2';record.keyExpiresAt=new Date(expiresAt).toISOString();save();
 const replay=local(['up','--login-server='+server,'--hostname='+hostName,'--accept-dns=false','--accept-routes=false','--auth-key=file:/dev/stdin','--timeout=15s'],key);
 key='';
 const beforeExpiry=Date.now()+5000<expiresAt;
 const reason=/already.{0,30}used|invalid.{0,30}key|expired.{0,30}key|unauthorized|authentication.{0,20}fail/i.test(replay.stderr);
 const state=local(['status','--json']);if(state.status!==0)throw new Error('Replay daemon status failed.');
 const observed=JSON.parse(state.stdout);
 const after=headscale('nodes list');
 record.exitCode=replay.status;record.credentialRejectionReasonObserved=reason;record.rejectionBeforeNaturalExpiry=beforeExpiry;record.backendState=observed.BackendState;
 record.nodeCountBefore=before.length;record.nodeCountAfter=Array.isArray(after)?after.length:null;
 if(replay.status===0||!reason||!beforeExpiry||observed.BackendState!=='NeedsLogin'||!Array.isArray(after)||after.length!==1||String(after[0].id)!=='1')throw new Error('Replay rejection not proven.');
 record.stage='replay-rejected-before-expiry';record.completedAt=new Date().toISOString();save();
 console.log(JSON.stringify(record));
}catch{record.failedStage=record.stage;record.stage='failed-preserved';save();console.error('PoC stage failed; consult non-secret ownership journal. No automatic retry or cleanup.');process.exitCode=1;}
finally{human=key='';}
