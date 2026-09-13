import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';
import type { ServiceStatus } from '@app/contracts';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth(): ServiceStatus {
    return this.appService.getHealth();
  }
}
