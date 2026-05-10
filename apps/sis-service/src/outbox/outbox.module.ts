import { Global, Module } from '@nestjs/common';
import { OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService],
})
export class OutboxModule {}
