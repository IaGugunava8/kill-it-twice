import { Injectable } from '@nestjs/common';
import type { ServiceStatus } from '@app/contracts';
import { createServiceStatus } from '@app/observability';

@Injectable()
export class WorkerService {
  getHealth(): ServiceStatus {
    return createServiceStatus('worker');
  }
}
