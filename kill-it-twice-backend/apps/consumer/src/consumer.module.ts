import { Module } from '@nestjs/common';
import { ConsumerController } from './consumer.controller.js';
import { ConsumerService } from './consumer.service.js';

@Module({
  imports: [],
  controllers: [ConsumerController],
  providers: [ConsumerService],
})
export class ConsumerModule {}
