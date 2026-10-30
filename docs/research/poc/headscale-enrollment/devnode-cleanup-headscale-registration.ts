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
const journal=root+'/credential-cleanup.json';
if(!process.argv.includes('--execute')||existsSync(journal))throw new Error('Requires explicit fresh execution; inspect any prior journal before retry.');
const record:any={instanceId:id,userName,hostName,projectId,server,secretName:'HEADSCALE_REGISTRATION_'+id.replaceAll('-','_').toUpperCase(),stage:'preflight',startedAt:new Date().toISOString()};
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
 human=execFileSync(cli,['user','get','token','--plain','--domain',site+'/api'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
 if(!human||/\s/.test(human))throw new Error('Invalid operator credential.');
 const ws=api('GET','/api/v1/workspace/'+projectId).workspace;
 if(ws.name!=='devnode-operators-04decc5b-c71a-4c96-9e05-bb622909d864'||ws.orgId!=='d808df2c-ec67-4046-b733-8c0db0bfa47d')throw new Error('Operator project ownership differs.');
 const base='/api/v1/projects/'+projectId;
 const humans=api('GET',base+'/memberships').memberships;
 const identities=api('GET',base+'/memberships/identities');
 const groups=api('GET',base+'/memberships/groups').groupMemberships;
 if(!Array.isArray(humans)||humans.length!==1||!humans[0].roles?.some((x:any)=>x.role==='admin')||identities.totalCount!==0||identities.identityMemberships?.length!==0||groups?.length!==0)throw new Error('Operator membership differs.');
 const registration=JSON.parse(readFileSync(root+'/network-recovery.json','utf8'));
 const replay=JSON.parse(readFileSync('/Users/rebui/.local/state/dotfiles/headscale-poc/r-ff48fa9e26c54c85/network-replay-recovery.json','utf8'));
 if(registration.instanceId!==id||registration.preauthKeyId!=='2'||registration.stage!=='network-registered-only'||replay.stage!=='replay-rejected-before-expiry')throw new Error('Prior proof differs.');
 const keys=headscale('preauthkeys list');
 const own=keys.filter((p:any)=>String(p.id)==='2'&&String(p.user?.id)==='1');
 if(own.length!==1||own[0].used!==true)throw new Error('Key ownership differs.');
 record.stage='expiring-used-key';record.preauthKeyId='2';save();
 headscale('preauthkeys expire --id 2');
 const checked=headscale('preauthkeys list').find((p:any)=>String(p.id)==='2');
 if(!checked||Number(checked.expiration?.seconds)*1000>Date.now()+1000)throw new Error('Key expiry unconfirmed.');
 record.keyExpired=true;record.stage='deleting-registration-secret';save();
 const query=new URLSearchParams({projectId,environment:'dev',secretPath:'/',expandSecretReferences:'false',includeImports:'false'});
 const value=api('GET','/api/v4/secrets/'+record.secretName+'?'+query).secret;
 if(value?.secretKey!==record.secretName)throw new Error('Stored secret ownership differs.');
 api('DELETE','/api/v4/secrets/'+record.secretName,{projectId,environment:'dev',secretPath:'/'});
 record.secretDeleted=true;save();
 const config=['url = '+JSON.stringify(site+'/api/v4/secrets/'+record.secretName+'?'+query),'header = '+JSON.stringify('Authorization: Bearer '+human)].join('\n')+'\n';
 const absent=spawnSync('/usr/bin/curl',['-q','--silent','--show-error','--no-location','--proto','=https','--max-time','15','--config','-','--output','/dev/null','--write-out','%{http_code}'],{input:config,encoding:'utf8',timeout:18000,stdio:['pipe','pipe','pipe']});
 if(absent.status!==0||absent.stdout!=='404')throw new Error('Secret absence unconfirmed.');
 const current=local(['status','--json']);if(current.status!==0||JSON.parse(current.stdout).BackendState!=='Running')throw new Error('Original node continuity unconfirmed.');
 record.stage='registration-credential-retired-node-retained';record.secretAbsentHttp=404;record.originalNodeRunning=true;record.completedAt=new Date().toISOString();save();
 console.log(JSON.stringify(record));
}catch{record.failedStage=record.stage;record.stage='failed-preserved';save();console.error('PoC stage failed; consult non-secret ownership journal. No automatic retry or cleanup.');process.exitCode=1;}
finally{human=key='';}
