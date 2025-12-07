/**
 * Интеграционные тесты для проверки работоспособности модулей пунктов 5-7
 */

// Закрываем соединения после всех тестов
afterAll(async () => {
  // Даем время на завершение асинхронных операций
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Закрываем очереди и соединения, если они были открыты
  try {
    const { resultQueue } = require('../../src/infrastructure/bullmq/resultQueue');
    if (resultQueue) {
      await resultQueue.close();
    }
  } catch (error) {
    // Игнорируем ошибки закрытия
  }

  try {
    const redisClient = require('../../src/infrastructure/redis/client');
    if (redisClient && redisClient.status !== 'end') {
      redisClient.disconnect();
    }
  } catch (error) {
    // Игнорируем ошибки закрытия
  }
}, 10000);

describe('Интеграционные тесты модулей', () => {
  describe('Пункт 5: Dify API Client', () => {
    test('должен импортировать Dify клиент без ошибок', () => {
      expect(() => {
        const client = require('../../src/infrastructure/dify/client');
        expect(client).toBeDefined();
      }).not.toThrow();
    });

    test('должен импортировать Dify API методы без ошибок', () => {
      expect(() => {
        const api = require('../../src/infrastructure/dify/api');
        expect(api).toBeDefined();
        expect(typeof api.runWorkflow).toBe('function');
        expect(typeof api.listDatasets).toBe('function');
        expect(typeof api.retrieveChunks).toBe('function');
        expect(typeof api.uploadFile).toBe('function');
      }).not.toThrow();
    });

    test('DifyApiError должен быть доступен', () => {
      const { DifyApiError } = require('../../src/core/errors');
      expect(DifyApiError).toBeDefined();
      
      const error = new DifyApiError('Test error', 404, 'not_found', '/test');
      expect(error.statusCode).toBe(404);
      expect(error.difyCode).toBe('not_found');
    });
  });

  describe('Пункт 6: BullMQ Infrastructure', () => {
    test('должен импортировать фабрику воркеров без ошибок', () => {
      expect(() => {
        const factory = require('../../src/infrastructure/bullmq/factory');
        expect(typeof factory).toBe('function');
      }).not.toThrow();
    });

    test('должен импортировать очередь результатов без ошибок', () => {
      expect(() => {
        const { resultQueue, sendResult } = require('../../src/infrastructure/bullmq/resultQueue');
        expect(resultQueue).toBeDefined();
        expect(typeof sendResult).toBe('function');
      }).not.toThrow();
    });

    test('должен импортировать initWorkers без ошибок', () => {
      expect(() => {
        const { initWorkers } = require('../../src/infrastructure/bullmq');
        expect(typeof initWorkers).toBe('function');
      }).not.toThrow();
    });

    test('константы очередей должны быть определены', () => {
      const { QUEUES } = require('../../src/core/constants');
      expect(QUEUES.INTERACTIVE).toBe('ai-interactive-queue');
      expect(QUEUES.BACKGROUND).toBe('ai-background-queue');
      expect(QUEUES.RESULTS).toBe('ai-results-queue');
    });

    test('процессоры должны быть доступны', () => {
      expect(() => {
        const fastProcessor = require('../../src/workers/fastLaneProcessor');
        const slowProcessor = require('../../src/workers/slowLaneProcessor');
        expect(typeof fastProcessor).toBe('function');
        expect(typeof slowProcessor).toBe('function');
      }).not.toThrow();
    });
  });

  describe('Пункт 7: Utils', () => {
    test('tokenCounter должен работать', () => {
      const { countTokens, estimateTotalTokens } = require('../../src/utils/tokenCounter');
      
      expect(typeof countTokens).toBe('function');
      expect(typeof estimateTotalTokens).toBe('function');
      
      const tokens = countTokens('Hello world', 'gpt-4');
      expect(tokens).toBeGreaterThan(0);
      
      const total = estimateTotalTokens('Context', 'History', 'Query', 'gpt-4');
      expect(total.total).toBeGreaterThan(0);
      expect(total.context).toBeGreaterThanOrEqual(0);
      expect(total.history).toBeGreaterThanOrEqual(0);
      expect(total.query).toBeGreaterThanOrEqual(0);
    });

    test('historyFormatter должен работать', () => {
      const { formatTicketHistory } = require('../../src/utils/historyFormatter');
      
      expect(typeof formatTicketHistory).toBe('function');
      
      const messages = [
        { role: 'user', content: 'Вопрос 1' },
        { role: 'assistant', content: 'Ответ 1' },
      ];
      
      const formatted = formatTicketHistory(messages);
      expect(formatted).toContain('User: Вопрос 1');
      expect(formatted).toContain('Assistant: Ответ 1');
    });

    test('llmParser должен работать', () => {
      const { cleanLlmJson } = require('../../src/utils/llmParser');
      
      expect(typeof cleanLlmJson).toBe('function');
      
      const jsonWithWrapper = '```json\n{"key": "value"}\n```';
      const cleaned = cleanLlmJson(jsonWithWrapper);
      expect(cleaned).toBe('{"key": "value"}');
      
      const parsed = JSON.parse(cleaned);
      expect(parsed.key).toBe('value');
    });
  });

  describe('Пункт 8: Error Handler и Billing', () => {
    test('errorHandler должен работать', () => {
      const { normalizeError, createErrorPayload } = require('../../src/utils/errorHandler');
      const { DifyApiError } = require('../../src/core/errors');
      
      expect(typeof normalizeError).toBe('function');
      expect(typeof createErrorPayload).toBe('function');
      
      const difyError = new DifyApiError('Test', 404, 'not_found', '/test');
      const normalized = normalizeError(difyError);
      
      expect(normalized.errorCode).toBeDefined();
      expect(normalized.message).toBeDefined();
      
      const payload = createErrorPayload(difyError, { orgId: '123' });
      expect(payload.status).toBe('error');
      expect(payload.meta.orgId).toBe('123');
    });

    test('BillingService должен работать', () => {
      const { extractUsage } = require('../../src/services/BillingService');
      
      expect(typeof extractUsage).toBe('function');
      
      const response = {
        metadata: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
          model_name: 'gpt-4o',
        },
      };
      
      const usage = extractUsage(response, 'gpt-4');
      expect(usage.prompt_tokens).toBe(10);
      expect(usage.completion_tokens).toBe(20);
      expect(usage.total_tokens).toBe(30);
      expect(usage.model).toBe('gpt-4o');
    });
  });
});

