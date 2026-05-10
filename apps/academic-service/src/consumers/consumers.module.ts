import { Module } from '@nestjs/common';
import { StudentEventsConsumer } from './student-events.consumer';

@Module({
  providers: [StudentEventsConsumer],
})
export class ConsumersModule {}
