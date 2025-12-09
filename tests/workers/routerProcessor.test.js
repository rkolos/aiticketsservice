// Загружаем .env для тестов ПЕРЕД загрузкой config
require('dotenv').config({ override: true });

// ВАЖНО: Моки должны быть ДО импортов, чтобы предотвратить создание реальных соединений
jest.mock('ioredis', () => {
  const mockRedis = jest.fn().mockImplementation(() => {
    const mockConnection = {
      quit: jest.fn().mockResolvedValue('OK'),
      disconnect: jest.fn(),
      on: jest.fn(),
      once: jest.fn(),
      status: 'ready',
    };
    return mockConnection;
  });
  return mockRedis;
});

jest.mock('bullmq', () => {
  const mockQueue = jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  }));
  return {
    Queue: mockQueue,
    Worker: jest.fn(),
  };
});

jest.mock('../../src/infrastructure/bullmq/resultQueue', () => {
  const mockResultQueue = {
    add: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
  const mockConnection = {
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    on: jest.fn(),
  };
  return {
    resultQueue: mockResultQueue,
    sendResult: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
    connection: mockConnection,
  };
});

// Мокаем Redis соединения
jest.mock('../../src/infrastructure/redis/cache', () => ({
  getOrgDatasets: jest.fn(),
  setOrgDatasets: jest.fn(),
  deleteOrgDatasets: jest.fn(),
  msetOrgDatasets: jest.fn(),
}));

jest.mock('../../src/infrastructure/redis/client', () => {
  const mockRedisClient = {
    status: 'ready',
    disconnect: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    once: jest.fn(),
  };
  return mockRedisClient;
});

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/utils/errorHandler', () => ({
  createErrorPayload: jest.fn((error, meta) => ({
    status: 'error',
    errorCode: 'INTERNAL_ERROR',
    message: error.message,
    meta,
  })),
}));

const { Queue } = require('bullmq');
const routerProcessor = require('../../src/workers/routerProcessor');
const { QUEUES } = require('../../src/core/constants');
const { sendResult } = require('../../src/infrastructure/bullmq/resultQueue');
const ErrorHandler = require('../../src/utils/errorHandler');

describe('Router Processor', () => {
  let mockJob;

  beforeEach(() => {
    jest.clearAllMocks();

    // Мокаем методы add у реальных очередей
    routerProcessor.fastQueue.add = jest.fn().mockResolvedValue({ id: 'fast-job-123' });
    routerProcessor.slowQueue.add = jest.fn().mockResolvedValue({ id: 'slow-job-456' });

    // Базовый мок для job
    mockJob = {
      id: 'test-job-123',
      name: 'CMD_GEN_RESPONSE',
      data: {
        orgId: 'test-org-123',
        query: 'Test query',
        history: [],
        lang: 'en',
        meta: {
          ticketId: 'ticket-456',
        },
      },
      opts: {},
    };
  });

  describe('Маршрутизация Fast Lane команд', () => {
    const fastCommands = [
      'CMD_GEN_RESPONSE',
      'CMD_ANALYZE_NEW_TICKET',
      'CMD_TRANSLATE',
      'CMD_KB_LIST_FILES',
      'CMD_KB_DELETE_FILE',
    ];

    test.each(fastCommands)('должен маршрутизировать %s в Fast Lane очередь', async (commandName) => {
      mockJob.name = commandName;

      const result = await routerProcessor(mockJob);

      expect(routerProcessor.fastQueue.add).toHaveBeenCalledTimes(1);
      expect(routerProcessor.fastQueue.add).toHaveBeenCalledWith(
        commandName,
        mockJob.data,
        mockJob.opts
      );
      expect(routerProcessor.slowQueue.add).not.toHaveBeenCalled();
      expect(result.status).toBe('routed');
      expect(result.to).toBe('fast');
      expect(result.targetQueue).toBe(QUEUES.INTERACTIVE);
      expect(result.routedJobId).toBe('fast-job-123');
    });
  });

  describe('Маршрутизация Slow Lane команд', () => {
    const slowCommands = [
      'CMD_KB_ADD_FILE',
      'CMD_ARCHIVE_TICKET',
      'CMD_SYS_RESYNC_CACHE',
      'CMD_CLEANUP_ORG',
    ];

    test.each(slowCommands)('должен маршрутизировать %s в Slow Lane очередь', async (commandName) => {
      mockJob.name = commandName;

      const result = await routerProcessor(mockJob);

      expect(routerProcessor.slowQueue.add).toHaveBeenCalledTimes(1);
      expect(routerProcessor.slowQueue.add).toHaveBeenCalledWith(
        commandName,
        mockJob.data,
        mockJob.opts
      );
      expect(routerProcessor.fastQueue.add).not.toHaveBeenCalled();
      expect(result.status).toBe('routed');
      expect(result.to).toBe('slow');
      expect(result.targetQueue).toBe(QUEUES.BACKGROUND);
      expect(result.routedJobId).toBe('slow-job-456');
    });
  });

  describe('Сохранение данных', () => {
    test('должен сохранить все поля data при маршрутизации', async () => {
      const complexData = {
        orgId: 'test-org-123',
        query: 'Test query',
        history: [{ role: 'user', content: 'Hello' }],
        lang: 'en',
        meta: {
          ticketId: 'ticket-456',
          userId: 'user-789',
        },
      };
      mockJob.data = complexData;

      await routerProcessor(mockJob);

      expect(routerProcessor.fastQueue.add).toHaveBeenCalledWith(
        'CMD_GEN_RESPONSE',
        complexData,
        mockJob.opts
      );
    });

    test('должен сохранить параметр lang при маршрутизации', async () => {
      mockJob.data.lang = 'es';

      await routerProcessor(mockJob);

      expect(routerProcessor.fastQueue.add).toHaveBeenCalledWith(
        'CMD_GEN_RESPONSE',
        expect.objectContaining({ lang: 'es' }),
        mockJob.opts
      );
    });

    test('должен сохранить опции задачи при маршрутизации', async () => {
      mockJob.opts = {
        priority: 10,
        delay: 1000,
      };

      await routerProcessor(mockJob);

      expect(routerProcessor.fastQueue.add).toHaveBeenCalledWith(
        'CMD_GEN_RESPONSE',
        mockJob.data,
        mockJob.opts
      );
    });
  });

  describe('Обработка ошибок', () => {
    test('должен пробросить ошибку при неудачной маршрутизации', async () => {
      const error = new Error('Queue error');
      routerProcessor.fastQueue.add.mockRejectedValueOnce(error);

      await expect(routerProcessor(mockJob)).rejects.toThrow('Queue error');
    });

    test('должен логировать ошибку при неудачной маршрутизации', async () => {
      const logger = require('../../src/utils/logger');
      const error = new Error('Queue error');
      routerProcessor.fastQueue.add.mockRejectedValueOnce(error);

      try {
        await routerProcessor(mockJob);
      } catch (e) {
        // Ожидаем ошибку
      }

      expect(logger.error).toHaveBeenCalled();
    });

    test('должен отправить ошибку в result queue при неудачной маршрутизации', async () => {
      jest.clearAllMocks();
      const error = new Error('Queue error');
      routerProcessor.fastQueue.add.mockRejectedValueOnce(error);

      mockJob.data = {
        orgId: 'test-org-123',
        meta: {
          traceId: 'trace-123',
        },
      };

      try {
        await routerProcessor(mockJob);
      } catch (e) {
        // Ожидаем ошибку
      }

      // Проверяем, что ошибка была отправлена в result queue
      expect(sendResult).toHaveBeenCalledTimes(1);
      expect(sendResult).toHaveBeenCalledWith(
        'CMD_GEN_RESPONSE',
        expect.objectContaining({
          status: 'error',
        }),
        expect.objectContaining({
          jobId: 'test-job-123',
          traceId: 'trace-123',
        })
      );
      expect(ErrorHandler.createErrorPayload).toHaveBeenCalledTimes(1);
    });
  });

  describe('Логирование', () => {
    test('должен логировать начало обработки задачи', async () => {
      const logger = require('../../src/utils/logger');
      jest.clearAllMocks();

      await routerProcessor(mockJob);

      expect(logger.info).toHaveBeenCalledWith(
        'Router: processing job',
        expect.objectContaining({
          jobId: 'test-job-123',
          jobName: 'CMD_GEN_RESPONSE',
        })
      );
    });

    test('должен логировать успешную маршрутизацию', async () => {
      const logger = require('../../src/utils/logger');
      jest.clearAllMocks();

      await routerProcessor(mockJob);

      expect(logger.info).toHaveBeenCalledWith(
        'Router: job routed',
        expect.objectContaining({
          jobId: 'test-job-123',
          jobName: 'CMD_GEN_RESPONSE',
          targetQueue: QUEUES.INTERACTIVE,
          routedJobId: expect.any(String),
        })
      );
    });
  });

  describe('Обработка неизвестных типов задач', () => {
    test('должен отправить ошибку в result queue для неизвестного типа задачи', async () => {
      const logger = require('../../src/utils/logger');
      jest.clearAllMocks();

      mockJob.name = 'CMD_UNKNOWN_COMMAND';
      mockJob.data = {
        orgId: 'test-org-123',
        meta: {
          traceId: 'trace-123',
        },
      };

      const result = await routerProcessor(mockJob);

      // Проверяем, что ошибка была отправлена в result queue
      expect(sendResult).toHaveBeenCalledTimes(1);
      expect(sendResult).toHaveBeenCalledWith(
        'CMD_UNKNOWN_COMMAND',
        expect.objectContaining({
          status: 'error',
          errorCode: 'INTERNAL_ERROR',
          message: expect.stringContaining('Unknown job type'),
        }),
        expect.objectContaining({
          jobId: 'test-job-123',
          traceId: 'trace-123',
        })
      );

      // Проверяем, что createErrorPayload был вызван
      expect(ErrorHandler.createErrorPayload).toHaveBeenCalledTimes(1);

      // Проверяем, что задача не была добавлена ни в одну очередь
      expect(routerProcessor.fastQueue.add).not.toHaveBeenCalled();
      expect(routerProcessor.slowQueue.add).not.toHaveBeenCalled();

      // Проверяем возвращаемое значение
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('unknown_job_type');
      expect(result.jobName).toBe('CMD_UNKNOWN_COMMAND');

      // Проверяем логирование
      expect(logger.warn).toHaveBeenCalledWith(
        'Router: unknown job type',
        expect.objectContaining({
          jobId: 'test-job-123',
          jobName: 'CMD_UNKNOWN_COMMAND',
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Router: error sent to result queue for unknown job type',
        expect.objectContaining({
          jobId: 'test-job-123',
          jobName: 'CMD_UNKNOWN_COMMAND',
        })
      );
    });

    test('должен обработать задачу без meta', async () => {
      jest.clearAllMocks();

      mockJob.name = 'CMD_UNKNOWN_COMMAND';
      mockJob.data = {
        orgId: 'test-org-123',
      };

      const result = await routerProcessor(mockJob);

      expect(sendResult).toHaveBeenCalledWith(
        'CMD_UNKNOWN_COMMAND',
        expect.any(Object),
        expect.objectContaining({
          jobId: 'test-job-123',
        })
      );

      expect(result.status).toBe('rejected');
    });

    test('должен обработать задачу с пустым data', async () => {
      jest.clearAllMocks();

      mockJob.name = 'CMD_UNKNOWN_COMMAND';
      mockJob.data = {};

      const result = await routerProcessor(mockJob);

      expect(sendResult).toHaveBeenCalled();
      expect(result.status).toBe('rejected');
    });
  });
});

// Глобальное закрытие всех соединений после всех тестов
afterAll(async () => {
  const cleanupPromises = [];

  // Закрываем resultQueue и его соединение Redis
  try {
    const resultQueueModule = require('../../src/infrastructure/bullmq/resultQueue');
    if (resultQueueModule.resultQueue && typeof resultQueueModule.resultQueue.close === 'function') {
      cleanupPromises.push(
        resultQueueModule.resultQueue.close().catch(() => {})
      );
    }
    if (resultQueueModule.connection) {
      const conn = resultQueueModule.connection;
      if (typeof conn.quit === 'function') {
        cleanupPromises.push(conn.quit().catch(() => {}));
      } else if (typeof conn.disconnect === 'function') {
        cleanupPromises.push(new Promise((resolve) => {
          try { conn.disconnect(); resolve(); } catch { resolve(); }
        }));
      }
    }
  } catch {}

  // Закрываем routerProcessor соединения
  try {
    if (routerProcessor.fastQueueConnection) {
      const conn = routerProcessor.fastQueueConnection;
      if (typeof conn.quit === 'function') {
        cleanupPromises.push(conn.quit().catch(() => {}));
      } else if (typeof conn.disconnect === 'function') {
        cleanupPromises.push(new Promise((resolve) => {
          try { conn.disconnect(); resolve(); } catch { resolve(); }
        }));
      }
    }
    if (routerProcessor.slowQueueConnection) {
      const conn = routerProcessor.slowQueueConnection;
      if (typeof conn.quit === 'function') {
        cleanupPromises.push(conn.quit().catch(() => {}));
      } else if (typeof conn.disconnect === 'function') {
        cleanupPromises.push(new Promise((resolve) => {
          try { conn.disconnect(); resolve(); } catch { resolve(); }
        }));
      }
    }
  } catch {}

  // Закрываем redisClient
  try {
    const redisClient = require('../../src/infrastructure/redis/client');
    if (redisClient && typeof redisClient.disconnect === 'function') {
      const status = redisClient.status || redisClient.connector?.status;
      if (status && status !== 'end' && status !== 'close') {
        cleanupPromises.push(new Promise((resolve) => {
          try { redisClient.disconnect(); resolve(); } catch { resolve(); }
        }));
      }
    }
  } catch {}

  await Promise.all(cleanupPromises);
  
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    timer.unref();
  });
}, 15000);

