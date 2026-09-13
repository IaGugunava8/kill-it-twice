import { NestFactory } from '@nestjs/core';
import { ConsumerModule } from './consumer.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ConsumerModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}
await bootstrap();
