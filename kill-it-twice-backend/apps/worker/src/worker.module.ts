import { Module } from '@nestjs/common';
import { WorkerController } from './worker.controller.js';
import { WorkerService } from './worker.service.js';

@Module({
  imports: [],
  controllers: [WorkerController],
  providers: [WorkerService],
})
export class WorkerModule {}
