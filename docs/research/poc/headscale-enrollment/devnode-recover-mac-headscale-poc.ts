import {parseIssuedKey} from './headscale-key-metadata';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root='/Users/rebui/.local/state/dotfiles/headscale-poc/mac-9f8f6a26-3686-455f-be33-0e6ddb845105';
const id='9f8f6a26-3686-455f-be33-0e6ddb845105';
const userName='poc-mac-'+id;
const hostName='mac-poc-'+id;
const projectId='65933584-7b10-4469-97eb-bc3c920326fb';
const site='https://secrets.rebuildup.dev';
const server='https://headscale.rebuildup.dev';
const cli='/Users/rebui/.local/share/mise/installs/infisical/0.44.8/infisical';
const journal=root+'/network-recovery.json';
if(!process.argv.includes('--execute')||existsSync(journal))throw new Error('Requires explicit fresh execution; inspect any prior journal before retry.');
const record:any={recoveryOf:'network-enrollment.json',retiredPreauthKeyId:'1',instanceId:id,userName,hostName,projectId,server,secretName:'HEADSCALE_REGISTRATION_'+id.replaceAll('-','_').toUpperCase(),stage:'preflight',startedAt:new Date().toISOString()};
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
function local(args:string[],input?:string){return spawnSync(root+'/tailscale/1.104.2/bin/tailscale',['--socket='+root+'/control.sock',...args],{env:childEnv,input,encoding:'utf8',timeout:40000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']});}
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
 const old=JSON.parse(readFileSync(root+'/network-enrollment.json','utf8'));
 if(old.instanceId!==id||old.headscaleUserId!=='1'||old.failedStage!=='issuing-key')throw new Error('Recovery ownership differs.');
 const users=headscale('users list');
 if(!Array.isArray(users)||users.filter((u:any)=>String(u.id)==='1'&&u.name===userName).length!==1)throw new Error('Owned user absent.');
 const keys=headscale('preauthkeys list');
 const previous=Array.isArray(keys)?keys.filter((p:any)=>String(p.id)==='1'&&String(p.user?.id)==='1'):[];
 if(previous.length!==1||previous[0].used===true)throw new Error('Unexpected previous key state.');
 record.stage='expiring-old-key';record.headscaleUserId='1';save();
 headscale('preauthkeys expire --id 1');
 const after=headscale('preauthkeys list');
 const retired=after.find((p:any)=>String(p.id)==='1');
 if(!retired||Number(retired.expiration?.seconds)*1000>Date.now()+1000)throw new Error('Old key expiry unconfirmed.');
 record.oldKeyExpiryConfirmed=true;const uid='1';record.stage='issuing-key';save();
 const issued=headscale('preauthkeys create --user '+uid+' --ephemeral --expiration 10m');
 const p=parseIssuedKey(issued.preAuthKey??issued,uid,Date.now());
 key=p.key;
 record.preauthKeyId=p.id;record.keyExpiresAt=new Date(p.expiresAt).toISOString();record.reusable=false;record.ephemeral=true;record.stage='storing-key';save();
 api('POST','/api/v4/secrets/'+record.secretName,{projectId,environment:'dev',secretPath:'/',secretValue:key,type:'shared'});
 record.stage='key-stored';save();
 const query=new URLSearchParams({projectId,environment:'dev',secretPath:'/',expandSecretReferences:'false',includeImports:'false'});
 const fromStore=api('GET','/api/v4/secrets/'+record.secretName+'?'+query).secret?.secretValue;
 if(fromStore!==key)throw new Error('Central secret readback mismatch.');
 key='';record.stage='registering';save();
 const joined=local(['up','--login-server='+server,'--hostname='+hostName,'--accept-dns=false','--accept-routes=false','--auth-key=file:/dev/stdin','--timeout=30s'],fromStore);
 if(joined.status!==0)throw new Error('Registration failed; credential-bearing output suppressed.');
 const status=local(['status','--json']);if(status.status!==0)throw new Error('Local status failed.');
 const s=JSON.parse(status.stdout);
 const nodes=headscale('nodes list');
 if(!Array.isArray(nodes))throw new Error('Unexpected node list shape.');
 const own=nodes.filter((n:any)=>n.name===hostName||n.givenName===hostName);
 if(s.BackendState!=='Running'||own.length!==1)throw new Error('Registration not independently confirmed.');
 record.nodeId=String(own[0].id);record.addresses=s.Self?.TailscaleIPs;record.backendState=s.BackendState;record.stage='network-registered-only';record.registeredAt=new Date().toISOString();save();
 console.log(JSON.stringify(record));
}catch{record.failedStage=record.stage;record.stage='failed-preserved';save();console.error('PoC stage failed; consult non-secret ownership journal. No automatic retry or cleanup.');process.exitCode=1;}
finally{human=key='';}
