import type { ServiceName, ServiceStatus } from '@app/contracts';

export function createServiceStatus(service: ServiceName): ServiceStatus {
  return {
    service,
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
}
