import type { Kit } from '../../http/v1/kit.js';
import { dashboard } from './service.js';

export function metricsRoutes(kit: Kit) {
  kit.get('/dashboard', 'read.operations', null, (ctx) => dashboard(ctx));
}
