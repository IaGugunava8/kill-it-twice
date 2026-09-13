import { Test, TestingModule } from '@nestjs/testing';
import { ConsumerController } from './consumer.controller.js';
import { ConsumerService } from './consumer.service.js';

describe('ConsumerController', () => {
  let consumerController: ConsumerController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ConsumerController],
      providers: [ConsumerService],
    }).compile();

    consumerController = app.get<ConsumerController>(ConsumerController);
  });

  describe('health', () => {
    it('identifies the consumer service as healthy', () => {
      expect(consumerController.getHealth()).toMatchObject({
        service: 'consumer',
        status: 'ok',
      });
    });
  });
});
