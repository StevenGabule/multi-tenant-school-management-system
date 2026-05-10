// See gateway/src/instrumentation.ts for why this MUST be the first
// import in main.ts.

import { initOtel } from '@org/observability';

initOtel({
  serviceName: 'sis-service',
});
