import {test,expect} from 'bun:test';
import {parseIssuedKey,matchesListedKey} from './headscale-key-metadata';
const now=Date.UTC(2026,9,25,10,0,0);
const fixture=()=>({id:1,user:{id:1},key:'synthetic-only-registration-value',ephemeral:true,expiration:{seconds:Math.floor(now/1000)+600,nanos:123000000}});
test('native Go JSON omitted false booleans and protobuf timestamp',()=>{
 const out=parseIssuedKey(fixture(),'1',now);
 expect(out.id).toBe('1');expect(out.expiresAt).toBe(now+600123);
 expect(out.reusable).toBe(false);expect(out.used).toBe(false);
});
for(const [name,patch] of Object.entries({reusable:{reusable:true},used:{used:true},malformedBoolean:{used:'false'},foreignUser:{user:{id:2}},missingEphemeral:{ephemeral:undefined},expired:{expiration:{seconds:now/1000-1}},overlong:{expiration:{seconds:now/1000+3600}},badNanos:{expiration:{seconds:now/1000+600,nanos:1e9}},badKey:{key:'bad\ncredential'}})){
 test('reject '+name,()=>expect(()=>parseIssuedKey({...fixture(),...patch},'1',now)).toThrow());
}
test('listed keys are masked prefixes rather than plaintext credentials',()=>{
 expect(matchesListedKey('hskey-auth-0123456789ab-secret-value','hskey-auth-0123456789ab-***')).toBe(true);
 expect(matchesListedKey('hskey-auth-abcdef012345-secret-value','hskey-auth-0123456789ab-***')).toBe(false);
 expect(matchesListedKey('hskey-auth-0123456789ab-secret-value','hskey-auth-0123456789ab-secret-value')).toBe(false);
});
