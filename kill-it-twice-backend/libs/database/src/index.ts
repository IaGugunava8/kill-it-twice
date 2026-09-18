export const DATABASE_SCHEMAS = {
  source: 'source',
  pipeline: 'pipeline',
  consumer: 'consumer',
} as const;

export * from './pipeline.repository.js';
