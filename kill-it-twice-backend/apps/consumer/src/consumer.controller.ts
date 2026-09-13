import { Controller, Get } from '@nestjs/common';
import { ConsumerService } from './consumer.service.js';
import type { ServiceStatus } from '@app/contracts';

@Controller()
export class ConsumerController {
  constructor(private readonly consumerService: ConsumerService) {}

  @Get('health')
  getHealth(): ServiceStatus {
    return this.consumerService.getHealth();
  }
}
