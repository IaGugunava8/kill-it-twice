import { Injectable } from '@nestjs/common';
import type { ServiceStatus } from '@app/contracts';
import { createServiceStatus } from '@app/observability';

@Injectable()
export class ConsumerService {
  getHealth(): ServiceStatus {
    return createServiceStatus('consumer');
  }
}
