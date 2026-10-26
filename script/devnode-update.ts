import {spawnSync} from 'node:child_process';
import {lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export type UpdateOptions = {repo:string; branch:string; mode:'check'|'apply'};
export type UpdateResult = UpdateOptions & {
  /** HEAD observed before any update. */
  current:string;
  /** Commit fetched from the explicitly requested remote branch. */
  target:string;
  /** True only when this invocation updated the checkout. */
  changed:boolean;
  /** True when the checkout already matched the requested remote branch. */
  noop:boolean;
};
const canonicalOrigins = [
  'https://github.com/rebuildup/dotfiles.git',
  'git@github.com:rebuildup/dotfiles.git',
  'ssh://git@github.com/rebuildup/dotfiles.git',
] as const;

/** Synchronous, bounded update. allowedOrigins is an explicit test dependency only. */
export function runUpdate(options:UpdateOptions, allowedOrigins:readonly string[]=canonicalOrigins):UpdateResult {
  if (!options || !['check','apply'].includes(options.mode) || typeof options.repo!=='string' || !options.repo || typeof options.branch!=='string') throw new Error('Expected repo, explicit branch, and check/apply mode.');
  const {branch,mode}=options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error('Invalid branch.');
  const repo=realpathSync(resolve(options.repo));
  // Disable hooks and automatic maintenance per invocation, without editing config.
  // An actual owned empty directory works on Unix and Windows alike.
  const hooks=mkdtempSync(join(tmpdir(),'devnode-update-hooks-'));
  const env={...process.env};
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_TERMINAL_PROMPT='0';
  const base=['-c',`core.hooksPath=${hooks}`,'-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','fetch.writeCommitGraph=false','-c','submodule.recurse=false','-c','merge.autoStash=false','-C',repo];
  function git(args:string[], allowMissing=false, raw=false):string {
    const p=spawnSync('git',[...base,...args],{env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
    if(p.error || (p.status!==0 && !(allowMissing && p.status===1))) throw new Error(`Git ${args[0]} failed; checkout was not forcibly repaired.`);
    return raw ? p.stdout : p.stdout.trim();
  }
  let fetchedRef:string|undefined;
  try {
    git(['check-ref-format',`refs/heads/${branch}`]);
    if(realpathSync(git(['rev-parse','--show-toplevel']))!==repo) throw new Error('Repo must name the checkout root.');
    const configured=git(['config','--get-all','remote.origin.url']).split('\n');
    const effective=git(['remote','get-url','--all','origin']).split('\n');
    if(configured.length!==1 || effective.length!==1 || !allowedOrigins.includes(configured[0]) || !allowedOrigins.includes(effective[0])) throw new Error('Unexpected origin.');
    const expectedRef=`refs/heads/${branch}`;
    const assertNoActiveFilters=(source?:string)=>{
      const paths=source ? git(['ls-tree','-r','--name-only','-z',source],false,true) : git(['ls-files','-z'],false,true);
      if(!paths) return;
      const result=spawnSync('git',[...base,'check-attr',...(source?['--source',source]:[]),'-z','--stdin','filter'],{env,input:paths,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,stdio:['pipe','pipe','pipe']});
      if(result.error || result.status!==0) throw new Error('Cannot inspect checkout filters safely.');
      const fields=result.stdout.split('\0');
      if(fields.pop()!=='' || fields.length%3) throw new Error('Invalid filter metadata.');
      for(let i=0;i<fields.length;i+=3) if(fields[i+1]!=='filter' || !['unspecified','unset'].includes(fields[i+2])) throw new Error('Active content filters require manual update.');
    };
    const clean=()=>{
      // status may recurse into submodules and execute their content filters.
      // This updater deliberately leaves initialized submodules to the operator.
      const entries=git(['ls-files','--stage','-z'],false,true).split('\0').filter(Boolean);
      for(const entry of entries){
        if(!entry.startsWith('160000 ')) continue;
        const path=join(repo,entry.slice(entry.indexOf('\t')+1));
        let stat;
        try { stat=lstatSync(path); } catch(error){ if((error as NodeJS.ErrnoException).code==='ENOENT') continue; throw error; }
        if(!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length) throw new Error('Initialized submodules require manual update.');
      }
      // Read attributes before status, which itself can invoke clean filters.
      assertNoActiveFilters();
      if(git(['symbolic-ref','--quiet','HEAD'])!==expectedRef) throw new Error('Current branch differs from explicit branch.');
      if(git(['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'])) throw new Error('Checkout has tracked or untracked changes.');
    };
    clean();
    const current=git(['rev-parse','--verify','HEAD^{commit}']);
    fetchedRef=`refs/devnode-update/${randomUUID()}`;
    git(['fetch','--no-tags','--no-recurse-submodules','--no-auto-maintenance','origin',`refs/heads/${branch}:${fetchedRef}`]);
    const target=git(['rev-parse','--verify',`${fetchedRef}^{commit}`]);
    if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target)) throw new Error('Unexpected commit identity.');
    if(git(['merge-base','--is-ancestor',current,target],true)!=='') throw new Error('Unexpected ancestry result.');
    // merge-base status 1 is meaningful; explicitly distinguish it from success.
    const ancestry=spawnSync('git',[...base,'merge-base','--is-ancestor',current,target],{env,encoding:'utf8',timeout:15000});
    if(ancestry.status!==0) throw new Error('Checkout is ahead or diverged; fast-forward refused.');
    assertNoActiveFilters(target);
    if(mode==='apply' && current!==target){
      clean();
      if(git(['rev-parse','--verify','HEAD^{commit}'])!==current) throw new Error('HEAD changed during preflight.');
      // Approved fast-forward mechanism: never create a merge commit or stash.
      git(['merge','--ff-only','--no-edit','--no-autostash','--no-overwrite-ignore',target]);
      if(git(['rev-parse','--verify','HEAD^{commit}'])!==target) throw new Error('Updated HEAD differs from fetched commit.');
    }
    return {repo,branch,mode,current,target,changed:mode==='apply' && current!==target,noop:current===target};
  } finally {
    try { if(fetchedRef) git(['update-ref','-d',fetchedRef]); }
    finally { rmSync(hooks,{recursive:true,force:true}); }
  }
}

export function main(argv:string[]):UpdateResult {
  const mode=argv[0];
  if(mode!=='check' && mode!=='apply') throw new Error('Usage: devnode-update.ts check|apply --repo PATH --branch BRANCH');
  let repo=dirname(import.meta.dir),branch:string|undefined;
  const seen=new Set<string>();
  for(let i=1;i<argv.length;i+=2){
    const flag=argv[i],value=argv[i+1];
    if(!['--repo','--branch'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate, or incomplete option.');
    seen.add(flag); if(flag==='--repo') repo=value; else branch=value;
  }
  if(!branch) throw new Error('Explicit --branch is required; --repo defaults to this script checkout. Pass --repo PATH to select another checkout.');
  return runUpdate({repo,branch,mode});
}
if(import.meta.main){
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch(error){ console.error(error instanceof Error?error.message:'Update failed.');process.exitCode=1; }
}
