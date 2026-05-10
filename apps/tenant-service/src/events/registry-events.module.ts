import { Global, Module } from '@nestjs/common';
import { RegistryEventsService } from './registry-events.service';

@Global()
@Module({
  providers: [RegistryEventsService],
  exports: [RegistryEventsService],
})
export class RegistryEventsModule {}
