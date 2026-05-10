import { Module } from '@nestjs/common';
import { DownstreamClient } from './downstream.client';

@Module({
  providers: [DownstreamClient],
  exports: [DownstreamClient],
})
export class DownstreamModule {}
