export type ServiceName = 'api' | 'worker' | 'consumer';

export interface ServiceStatus {
  service: ServiceName;
  status: 'ok';
  timestamp: string;
}

export type PipelineRunState =
  | 'created'
  | 'running'
  | 'paused'
  | 'scanned'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export type DeliveryState =
  | 'pending'
  | 'in_flight'
  | 'retry_scheduled'
  | 'delivered'
  | 'superseded'
  | 'quarantined';
