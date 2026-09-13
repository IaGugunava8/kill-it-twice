import { Test, TestingModule } from '@nestjs/testing';
import { WorkerController } from './worker.controller.js';
import { WorkerService } from './worker.service.js';

describe('WorkerController', () => {
  let workerController: WorkerController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [WorkerController],
      providers: [WorkerService],
    }).compile();

    workerController = app.get<WorkerController>(WorkerController);
  });

  describe('health', () => {
    it('identifies the worker service as healthy', () => {
      expect(workerController.getHealth()).toMatchObject({
        service: 'worker',
        status: 'ok',
      });
    });
  });
});
