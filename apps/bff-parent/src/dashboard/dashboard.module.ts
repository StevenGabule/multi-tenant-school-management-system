import { Module } from '@nestjs/common';
import { DownstreamModule } from '../downstream/downstream.module';
import { ChildrenAggregator } from './children.aggregator';
import { DashboardCache } from './dashboard.cache';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [DownstreamModule],
  controllers: [DashboardController],
  providers: [ChildrenAggregator, DashboardCache],
})
export class DashboardModule {}
