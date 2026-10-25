export function parseIssuedKey(p:any,userId:string,now:number){
 // v0.29.6 CLI uses encoding/json on generated proto structs: false is omitted,
 // Timestamp is an object, not the ISO representation emitted by protojson.
 if(!p||typeof p!=='object'||String(p.user?.id)!==userId||!Number.isSafeInteger(p.id)||p.id<1)throw new Error('Key ownership differs.');
 for(const field of ['reusable','used'])if(p[field]!==undefined&&typeof p[field]!=='boolean')throw new Error('Malformed key boolean.');
 const reusable=p.reusable===true,used=p.used===true;
 const seconds=p.expiration?.seconds,nanos=p.expiration?.nanos??0;
 if(!Number.isSafeInteger(seconds)||!Number.isInteger(nanos)||nanos<0||nanos>=1e9)throw new Error('Malformed key timestamp.');
 const expiresAt=seconds*1000+nanos/1e6;
 if(typeof p.key!=='string'||p.key.length<20||/\s/.test(p.key)||reusable||p.ephemeral!==true||used||!Number.isFinite(expiresAt)||expiresAt<now+30000||expiresAt>now+15*60000)throw new Error('Issued key constraints differ.');
 return {id:String(p.id),key:p.key,expiresAt,reusable,used};
}
export function matchesListedKey(value:string,listed:string){
 if(typeof value!=='string'||typeof listed!=='string'||!/^hskey-auth-[a-zA-Z0-9]+-\*\*\*$/.test(listed))return false;
 const prefix=listed.slice(0,-3);
 return value.startsWith(prefix)&&value.length>prefix.length&&!/\s/.test(value);
}
