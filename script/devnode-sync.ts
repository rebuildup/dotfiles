import {spawnSync} from 'node:child_process';
import {mkdirSync, rmdirSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {runUpdate} from './devnode-update';
import {main as machines} from './devnode-machines';

// Compose the existing bounded updater and owned-profile reconciliation.
// No bootstrap, credential copying, profile enrollment, or local fallback.
export function main(argv:string[]) {
  const options=new Map<string,string>();
  for(let i=0;i<argv.length;i+=2){
    const flag=argv[i],value=argv[i+1];
    if(!['--repo','--branch','--bindings','--herdr'].includes(flag) || options.has(flag) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate, or incomplete sync option.');
    options.set(flag,value);
  }
  const repo=options.get('--repo'),branch=options.get('--branch'),bindings=options.get('--bindings'),herdr=options.get('--herdr');
  if(!repo || !branch || !bindings || !herdr || ![repo,bindings,herdr].every(isAbsolute)) throw new Error('sync requires explicit --repo ABSOLUTE_PATH --branch BRANCH --bindings PRIVATE_JSON --herdr ABSOLUTE_BINARY.');
  // Validate ownership, permissions and current profile bindings before fetching.
  machines(['plan','--bindings',bindings,'--herdr',herdr,'--config',join(repo,'config','devnode-machines.json')]);
  const lock=bindings+'.sync-lock';
  mkdirSync(lock,{mode:0o700});
  try {
    const update=runUpdate({repo,branch,mode:'apply'});
    // Execute the fetched checkout's reconciler, rather than old loaded code.
    const result=spawnSync(process.execPath,[join(update.repo,'script','devnode.ts'),'machines','apply','--bindings',bindings,'--herdr',herdr],{cwd:update.repo,encoding:'utf8',timeout:120000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});
    if(result.error || result.status!==0) throw new Error(`Source is at ${update.target}; owned Herdr configuration apply failed. Inspect configuration before retry; source update was not rolled back.`);
    let configuration:unknown;
    try { configuration=JSON.parse(result.stdout); } catch { throw new Error(`Source is at ${update.target}; configuration response was invalid. Inspect official Herdr catalog before retry.`); }
    return {update,configuration};
  } finally { rmdirSync(lock); }
}
