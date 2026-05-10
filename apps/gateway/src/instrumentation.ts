// MUST be imported as the very first line of main.ts. Auto-instrumentation
// patches happen at require time; anything imported before this is invisible
// to OTel forever.

import { initOtel } from '@org/observability';

initOtel({
  serviceName: 'gateway',
});
