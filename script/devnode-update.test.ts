import {expect, test, setDefaultTimeout} from 'bun:test';
// Local Git/submodule fixtures start many native processes; keep a bounded Windows budget.
if(process.platform==='win32') setDefaultTimeout(30_000);
import {mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {runUpdate} from './devnode-update';
const git=(repo:string,...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}}).trim();
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'devnode update ')),remote=join(root,'remote.git'),seed=join(root,'seed'),repo=join(root,'checkout');
 git(root,'init','--bare',remote);git(root,'init','--initial-branch=main',seed);
 for(const p of [seed]){git(p,'config','user.name','Fixture');git(p,'config','user.email','fixture@example.invalid');git(p,'config','core.autocrlf','false');}
 writeFileSync(join(seed,'config'),'original\n');git(seed,'add','.');git(seed,'commit','-m','initial');git(seed,'remote','add','origin',remote);git(seed,'push','origin','main');
 git(root,'clone','--branch','main',remote,repo);git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');git(repo,'config','core.autocrlf','false');
 const current=git(repo,'rev-parse','HEAD');
 writeFileSync(join(seed,'config'),'updated\n');git(seed,'commit','-am','update');git(seed,'push','origin','main');
 const target=git(seed,'rev-parse','HEAD');
 return {root,remote,seed,repo,current,target,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('check fetches target without changing checkout; apply fast-forwards then noops',()=>{
 const f=fixture();try{
  const check=runUpdate({repo:f.repo,branch:'main',mode:'check'},[f.remote]);
  expect(check.current).toBe(f.current);expect(check.target).toBe(f.target);expect(check.changed).toBe(false);expect(check.noop).toBe(false);
  expect(git(f.repo,'rev-parse','HEAD')).toBe(f.current);expect(readFileSync(join(f.repo,'config'),'utf8')).toBe('original\n');
  const applied=runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote]);expect(applied.changed).toBe(true);expect(git(f.repo,'rev-parse','HEAD')).toBe(f.target);
  expect(readFileSync(join(f.repo,'config'),'utf8')).toBe('updated\n');expect(runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote]).noop).toBe(true);
 }finally{f.cleanup();}
});
test('a nested directory cannot masquerade as the checkout root',()=>{
 const f=fixture();try{
  const nested=join(f.repo,'nested');mkdirSync(nested);
  expect(()=>runUpdate({repo:nested,branch:'main',mode:'apply'},[f.remote])).toThrow('Repo must name the checkout root.');
  expect(git(f.repo,'rev-parse','HEAD')).toBe(f.current);
 }finally{f.cleanup();}
});
for(const dirty of ['tracked','untracked','staged'])test('refuses '+dirty+' files without loss',()=>{
 const f=fixture();try{writeFileSync(join(f.repo,dirty==='untracked'?'keep':'config'),'local\n');if(dirty==='staged')git(f.repo,'add','config');
 expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow();expect(git(f.repo,'rev-parse','HEAD')).toBe(f.current);expect(readFileSync(join(f.repo,dirty==='untracked'?'keep':'config'),'utf8')).toBe('local\n');
 }finally{f.cleanup();}
});
test('refuses diverged or locally ahead history',()=>{
 const f=fixture();try{writeFileSync(join(f.repo,'local'),'retained');git(f.repo,'add','.');git(f.repo,'commit','-m','local');const head=git(f.repo,'rev-parse','HEAD');expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow();expect(git(f.repo,'rev-parse','HEAD')).toBe(head);expect(readFileSync(join(f.repo,'local'),'utf8')).toBe('retained');
 }finally{f.cleanup();}
});
test('rejects wrong origin, branch, detached HEAD and ref-shaped input',()=>{
 const f=fixture();try{
 expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'})).toThrow();
 expect(()=>runUpdate({repo:f.repo,branch:'other',mode:'apply'},[f.remote])).toThrow();
 for(const branch of ['--help','main:other','main;touch','../main','@{-1}','main\nother'])expect(()=>runUpdate({repo:f.repo,branch,mode:'apply'},[f.remote])).toThrow();
 git(f.repo,'checkout','--detach');expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow();
 }finally{f.cleanup();}
});
test('apply suppresses user hooks and refuses active content filters',()=>{
 const f=fixture();try{
 const hooks=join(f.root,'hooks'),sentinel=join(f.root,'hook-fired');mkdirSync(hooks);writeFileSync(join(hooks,'post-merge'),'#!/bin/sh\nprintf fired > "'+sentinel+'"\n',{mode:0o755});git(f.repo,'config','core.hooksPath',hooks);
 writeFileSync(join(f.repo,'.git','info','attributes'),'config filter=custom\n');git(f.repo,'config','filter.custom.smudge','echo external');expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow();git(f.repo,'config','--unset','filter.custom.smudge');writeFileSync(join(f.repo,'.git','info','attributes'),'');
 runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote]);expect(existsSync(sentinel)).toBe(false);expect(git(f.repo,'config','core.hooksPath')).toBe(hooks);
 }finally{f.cleanup();}
});
test('CLI rejects unknown flags, absent branch, and duplicate mode/flags',()=>{
 for(const args of [['check','--repo','/not-a-repo'],['apply','--branch','main','--bogus'],['check','--branch','main','--branch','other'],['check','apply','--branch','main']]){
 const p=spawnSync(process.execPath,[join(import.meta.dir,'devnode-update.ts'),...args],{encoding:'utf8'});expect(p.status).not.toBe(0);expect(p.stdout).toBe('');
 }
});

test('refuses overwriting an ignored local file newly tracked upstream',()=>{
 const f=fixture();try{
  writeFileSync(join(f.repo,'.git','info','exclude'),'keep-ignored\n');
  writeFileSync(join(f.repo,'keep-ignored'),'local data must survive\n');
  writeFileSync(join(f.seed,'keep-ignored'),'remote replacement\n');git(f.seed,'add','keep-ignored');git(f.seed,'commit','-m','track previously ignored name');git(f.seed,'push','origin','main');
  expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow();
  expect(readFileSync(join(f.repo,'keep-ignored'),'utf8')).toBe('local data must survive\n');
  expect(git(f.repo,'rev-parse','HEAD')).toBe(f.current);
 }finally{f.cleanup();}
});

test('unused global-style filter configuration does not block an ordinary checkout update',()=>{
 const f=fixture();try{
  git(f.repo,'config','filter.unused.process','must-not-run-anywhere');
  const result=runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote]);
  expect(result.changed).toBe(true);expect(readFileSync(join(f.repo,'config'),'utf8')).toBe('updated\n');
 }finally{f.cleanup();}
});
test('an active clean filter is refused before status can execute it',()=>{
 const f=fixture();try{
  const sentinel=join(f.root,'filter-fired');
  writeFileSync(join(f.repo,'.git','info','attributes'),'config filter=active\n');
  git(f.repo,'config','filter.active.clean','printf fired > "'+sentinel+'"; cat');
  expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow();
  expect(existsSync(sentinel)).toBe(false);expect(git(f.repo,'rev-parse','HEAD')).toBe(f.current);
 }finally{f.cleanup();}
});

test('initialized submodules require manual update before recursive status side effects',()=>{
 const f=fixture();try{
  git(f.repo,'-c','protocol.file.allow=always','submodule','add','--branch','main',f.remote,'nested');
  expect(()=>runUpdate({repo:f.repo,branch:'main',mode:'apply'},[f.remote])).toThrow('Initialized submodules require manual update');
  expect(existsSync(join(f.repo,'nested','config'))).toBe(true);
 }finally{f.cleanup();}
});
