import { ServiceEndpoints } from '../generated/IntegrationContent';
/** Use SAP-provided entry points; service IDs are opaque. */
export const getEndpointUrl = (endpoint: ServiceEndpoints): string =>
 endpoint.entryPoints?.find(e => typeof e.url === 'string' && /^https?:\/\//.test(e.url))?.url || '';
