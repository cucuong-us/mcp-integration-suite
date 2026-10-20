import { getEndpointUrl } from '../getEndpointUrl';
import { ServiceEndpoints } from '../../generated/IntegrationContent';
describe('SAP canonical entry points',()=>{
 it('uses actual entry point URL independently of protocol and ID',()=>{
  const endpoint={id:'opaque',protocol:'ODATAV2',entryPoints:[{url:'https://runtime.example/odata/SAP/Orders'}]} as unknown as ServiceEndpoints;
  expect(getEndpointUrl(endpoint)).toBe('https://runtime.example/odata/SAP/Orders');
 });
 it('does not invent a URL from an endpoint ID',()=>{
  expect(getEndpointUrl({id:'x$endpointAddress=foo',protocol:'REST'} as ServiceEndpoints)).toBe('');
 });
});
