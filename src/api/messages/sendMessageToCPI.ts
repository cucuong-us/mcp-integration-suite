import { z } from 'zod';
import { sendRequestSchema } from '../../handlers/messages/types';
import { getOAuthTokenCPI } from '../cpi_auth';
import { getOAuthToken } from '../api_destination';

export const sendRequestToCPI = async (
 path: z.infer<typeof sendRequestSchema.path>, method: z.infer<typeof sendRequestSchema.method>,
 contentType: z.infer<typeof sendRequestSchema.contentType>, body?: string,
 headers?: {key:string;value:string}[], csrfProtected = true, canonicalBase?: string
): Promise<{status:number;response:string;messageGuid?:string}> => {
 if(!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('Use a tenant-relative HTTP path');
 const base=canonicalBase || process.env.CPI_BASE_URL;
 if(!base) throw new Error('CPI_BASE_URL is required');
 const target=new URL(path,base);
 if(target.origin!==new URL(base).origin) throw new Error('Cross-origin runtime request is not allowed');
 const hasRuntime=process.env.CPI_OAUTH_CLIENT_ID && process.env.CPI_OAUTH_CLIENT_SECRET && process.env.CPI_OAUTH_TOKEN_URL;
 const auth=(await (hasRuntime?getOAuthTokenCPI():getOAuthToken())).http_header;
 const reqHeaders:Record<string,string>={[auth.key]:auth.value,'Content-Type':contentType};
 for(const h of headers||[]) {
  if(/^(authorization|host|cookie|x-csrf-token)$/i.test(h.key)) throw new Error('Authentication/session headers are managed by the server');
  reqHeaders[h.key]=h.value;
 }
 if(csrfProtected && method!=='GET') {
  const preflight=await fetch(target,{method:'HEAD',headers:{[auth.key]:auth.value,'X-CSRF-Token':'Fetch'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const token=preflight.headers.get('x-csrf-token');
  if(preflight.status===401||preflight.status===403) throw new Error('Runtime authentication failed (HTTP '+preflight.status+'). Configure an integration-flow service key with ESBMessaging.send in CPI_OAUTH_*; management API access alone is insufficient.');
  if(!token || token.toLowerCase()==='required') throw new Error('CSRF token not returned. Check endpoint and CSRF configuration; set csrfProtected=false only for an endpoint configured without CSRF. HTTP '+preflight.status);
  reqHeaders['X-CSRF-Token']=token;
  const cookies=preflight.headers.getSetCookie().map(v=>v.split(';')[0]);
  if(cookies.length)reqHeaders.Cookie=cookies.join('; ');
 }
 if(method==='GET' && body)throw new Error('GET request must not contain a body');
 const res=await fetch(target,{method,headers:reqHeaders,body:method==='GET'?undefined:body,redirect:'manual',signal:AbortSignal.timeout(60000)});
 return {status:res.status,response:await res.text(),messageGuid:res.headers.get('sap_messageprocessinglogid')||undefined};
};
