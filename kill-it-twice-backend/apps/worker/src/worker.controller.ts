import { Controller, Get } from '@nestjs/common';
import { WorkerService } from './worker.service.js';
import type { ServiceStatus } from '@app/contracts';

@Controller()
export class WorkerController {
  constructor(private readonly workerService: WorkerService) {}

  @Get('health')
  getHealth(): ServiceStatus {
    return this.workerService.getHealth();
  }
}
