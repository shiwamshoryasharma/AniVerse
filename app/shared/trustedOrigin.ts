/** URL.origin is "null" for multiple unrelated schemes; never use it alone as an app trust decision. */
export function trustedAppUrl(candidate:string,base:string):boolean {
 try{
  const target=new URL(candidate),expected=new URL(base);
  if(!['app:','http:','https:'].includes(expected.protocol)||target.username||target.password)return false;
  return target.protocol===expected.protocol&&target.hostname===expected.hostname&&target.port===expected.port&&
    (expected.protocol!=='app:'||target.hostname==='aniverse');
 }catch{return false;}
}
