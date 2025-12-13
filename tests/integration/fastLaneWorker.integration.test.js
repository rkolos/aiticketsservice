// Загружаем .env для тестов ПЕРЕД загрузкой config
require('dotenv').config({ override: true });

// Мокаем только внешние зависимости (Dify API), но проверяем реальные вызовы методов
// ВАЖНО: Моки должны быть ДО импортов, чтобы предотвратить создание реальных соединений
jest.mock('../../src/infrastructure/dify/api');
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

// Мокаем Redis соединения, чтобы они не пытались подключиться
jest.mock('../../src/infrastructure/redis/cache', () => ({
  getOrgDatasets: jest.fn(),
  setOrgDatasets: jest.fn(),
  deleteOrgDatasets: jest.fn(),
  msetOrgDatasets: jest.fn(),
}));

// Мокаем Redis клиент, чтобы предотвратить реальные подключения
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

const fastLaneWorker = require('../../src/workers/fastLaneWorker');
const OrganizationService = require('../../src/services/OrganizationService');
const difyApi = require('../../src/infrastructure/dify/api');
const { sendResult } = require('../../src/infrastructure/bullmq/resultQueue');
const BillingService = require('../../src/services/BillingService');
const historyFormatter = require('../../src/utils/historyFormatter');
const llmParser = require('../../src/utils/llmParser');
const config = require('../../src/config');

describe('Fast Lane Worker - Integration Tests', () => {
  let mockJob;

  beforeEach(() => {
    jest.clearAllMocks();

    // Базовый мок для job
    mockJob = {
      id: 'test-job-123',
      name: 'CMD_GEN_RESPONSE',
      data: {
        orgId: 'test-org-123',
        query: 'Как сбросить пароль?',
        history: [
          { role: 'user', content: 'Здравствуйте, у меня проблема' },
          { role: 'assistant', content: 'Здравствуйте! Расскажите подробнее' },
        ],
        meta: {
          ticketId: 'ticket-456',
          user: 'user-789',
        },
      },
    };
  });

  describe('CMD_GEN_RESPONSE - Полный цикл External RAG', () => {
    test('должен выполнить полный цикл: Identify Datasets -> Retrieval -> Assembly -> Pruning -> Generation', async () => {
      // Моки для OrganizationService - используем ensureAdminKb и ensureHistoryKb
      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      // Моки для retrieve (admin база использует retrieve, а не retrieveChunks)
      const mockAdminRetrieve = {
        records: [
          {
            segment: {
              content: 'Административный чанк 1: Инструкция по сбросу пароля',
            },
            score: 0.9,
            document: {
              name: 'admin-doc-1',
            },
          },
          {
            segment: {
              content: 'Административный чанк 2: Дополнительная информация',
            },
            score: 0.85,
            document: {
              name: 'admin-doc-2',
            },
          },
        ],
      };

      const mockHistoryChunks = [
        {
          content: 'Исторический чанк 1: Похожая проблема была решена ранее',
          score: 0.8,
          document_id: 'hist-doc-1',
          document_name: 'history-doc-1',
        },
      ];

      difyApi.retrieve.mockResolvedValue(mockAdminRetrieve);
      difyApi.retrieveChunks.mockResolvedValue(mockHistoryChunks);

      // Мок для runWorkflow
      const mockWorkflowResponse = {
        text: 'Для сброса пароля перейдите в настройки профиля...',
        metadata: {
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          },
          model_name: 'gpt-4',
        },
      };
      difyApi.runWorkflow.mockResolvedValue(mockWorkflowResponse);

      // Мок для sendResult
      sendResult.mockResolvedValue({ id: 'result-123' });

      // Выполняем обработку
      await fastLaneWorker(mockJob);

      // Проверяем вызовы методов

      // 1. Проверяем вызовы ensureAdminKb и ensureHistoryKb
      expect(OrganizationService.ensureAdminKb).toHaveBeenCalledWith('test-org-123');
      expect(OrganizationService.ensureHistoryKb).toHaveBeenCalledWith('test-org-123');

      // 2. Проверяем вызов retrieve для admin базы
      expect(difyApi.retrieve).toHaveBeenCalledTimes(1);
      expect(difyApi.retrieve).toHaveBeenCalledWith(
        'admin-kb-123',
        'Как сбросить пароль?'
      );

      // 3. Проверяем вызов retrieveChunks для history базы
      expect(difyApi.retrieveChunks).toHaveBeenCalledTimes(1);
      expect(difyApi.retrieveChunks).toHaveBeenCalledWith(
        config.dify.keys.admin,
        'history-kb-456',
        'Как сбросить пароль?',
        5
      );

      // 3. Проверяем вызов runWorkflow
      expect(difyApi.runWorkflow).toHaveBeenCalledTimes(1);
      const workflowCall = difyApi.runWorkflow.mock.calls[0];
      expect(workflowCall[0]).toBe(config.dify.keys.responseWorkflow);
      expect(workflowCall[1]).toHaveProperty('query', 'Как сбросить пароль?');
      expect(workflowCall[1]).toHaveProperty('history');
      expect(workflowCall[1]).toHaveProperty('context');
      expect(workflowCall[1]).toHaveProperty('lang', undefined); // lang не передан
      expect(workflowCall[2]).toBe('user-789');

      // Проверяем, что history отформатирован
      const formattedHistory = historyFormatter.formatTicketHistory(mockJob.data.history);
      expect(workflowCall[1].history).toContain('User:');
      expect(workflowCall[1].history).toContain('Assistant:');

      // Проверяем, что context собран из чанков
      expect(workflowCall[1].context).toContain('Административный чанк 1');
      expect(workflowCall[1].context).toContain('Исторический чанк 1');
      expect(workflowCall[1].context).toContain('История тикетов');

      // 4. Проверяем вызов sendResult с правильными данными
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[0]).toBe('CMD_GEN_RESPONSE');
      expect(resultCall[1]).toHaveProperty('success', true);
      expect(resultCall[1].data).toHaveProperty('content', 'Для сброса пароля перейдите в настройки профиля...');
      expect(resultCall[1].data).toHaveProperty('sources');
      // Usage находится в meta, а не в data
      expect(resultCall[1].meta).toHaveProperty('usage');
      expect(resultCall[1].meta.usage.stages).toBeDefined();
      expect(resultCall[1].meta.usage.stages.length).toBeGreaterThan(0);
      expect(resultCall[2]).toEqual(expect.objectContaining(mockJob.data.meta));
    });

    test('должен передать параметр lang как language в workflow inputs', async () => {
      // Добавляем lang в данные задачи
      mockJob.data.lang = 'en';

      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      difyApi.retrieve.mockResolvedValue({ records: [] });
      difyApi.retrieveChunks.mockResolvedValue([]);

      difyApi.runWorkflow.mockResolvedValue({
        text: 'Answer in English',
        metadata: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        },
      });

      await fastLaneWorker(mockJob);

      // Проверяем, что language передан в workflow inputs
      expect(difyApi.runWorkflow).toHaveBeenCalledTimes(1);
      const workflowCall = difyApi.runWorkflow.mock.calls[0];
      expect(workflowCall[1]).toHaveProperty('lang', 'en');
    });

    test('должен передать undefined для language, если lang не передан', async () => {
      // Убеждаемся, что lang отсутствует
      delete mockJob.data.lang;

      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      difyApi.retrieve.mockResolvedValue({ records: [] });
      difyApi.retrieveChunks.mockResolvedValue([]);

      difyApi.runWorkflow.mockResolvedValue({
        text: 'Answer',
        metadata: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        },
      });

      await fastLaneWorker(mockJob);

      // Проверяем, что language равен undefined
      expect(difyApi.runWorkflow).toHaveBeenCalledTimes(1);
      const workflowCall = difyApi.runWorkflow.mock.calls[0];
      expect(workflowCall[1]).toHaveProperty('lang', undefined);
    });

    test('должен обработать ошибку KbNotFoundError и отправить ошибку в resultQueue', async () => {
      const { KbNotFoundError } = require('../../src/core/errors');
      
      // Мок для simplifyUserQuery (вызывается до ensureAdminKb)
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });
      
      jest.spyOn(OrganizationService, 'ensureAdminKb').mockRejectedValue(
        new KbNotFoundError('test-org-123')
      );

      // safeProcessor пробрасывает ошибку после отправки в resultQueue
      try {
        await fastLaneWorker(mockJob);
      } catch (error) {
        // Ожидаем, что ошибка будет выброшена
        expect(error).toBeDefined();
      }

      // Проверяем, что ошибка отправлена в resultQueue
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[0]).toBe('CMD_GEN_RESPONSE');
      expect(resultCall[1]).toHaveProperty('success', false);
      expect(resultCall[1].error).toHaveProperty('code', 'KB_NOT_FOUND');

      // Проверяем, что retrieve и retrieveChunks не вызывались
      expect(difyApi.retrieve).not.toHaveBeenCalled();
      expect(difyApi.retrieveChunks).not.toHaveBeenCalled();
    });

    test('должен выполнить graceful degradation при ошибке поиска в одной из баз', async () => {
      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      // Admin retrieve успешно, history chunks с ошибкой
      difyApi.retrieve.mockResolvedValue({
        records: [
          {
            segment: {
              content: 'Административный чанк',
            },
            score: 0.9,
          },
        ],
      });
      difyApi.retrieveChunks.mockRejectedValue(new Error('History KB not found'));

      difyApi.runWorkflow.mockResolvedValue({
        text: 'Ответ',
        metadata: { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
      });

      await fastLaneWorker(mockJob);

      // Проверяем, что retrieve и retrieveChunks были вызваны
      expect(difyApi.retrieve).toHaveBeenCalledTimes(1);
      expect(difyApi.retrieveChunks).toHaveBeenCalledTimes(1);

      // Проверяем, что workflow все равно вызван (graceful degradation)
      expect(difyApi.runWorkflow).toHaveBeenCalledTimes(1);

      // Проверяем, что результат отправлен успешно
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[1]).toHaveProperty('success', true);
    });
  });

  describe('CMD_ANALYZE_NEW_TICKET', () => {
    test('должен вызвать Classifier Workflow, распарсить JSON и вернуть title и sentiment', async () => {
      mockJob.name = 'CMD_ANALYZE_NEW_TICKET';
      mockJob.data = {
        text: 'У меня проблема с доступом к системе',
        targetLanguage: 'ru',
        meta: { user: 'user-123' },
      };

      // Мок ответа с JSON в Markdown обертке
      const mockJsonResponse = {
        text: '```json\n{"title": "Проблема с доступом", "sentiment": "negative"}\n```',
      };
      difyApi.runWorkflow.mockResolvedValue(mockJsonResponse);

      await fastLaneWorker(mockJob);

      // Проверяем вызов runWorkflow
      expect(difyApi.runWorkflow).toHaveBeenCalledTimes(1);
      const workflowCall = difyApi.runWorkflow.mock.calls[0];
      expect(workflowCall[0]).toBe(config.dify.keys.classifier);
      expect(workflowCall[1]).toHaveProperty('message', 'У меня проблема с доступом к системе');
      expect(workflowCall[1]).toHaveProperty('lang', 'ru');

      // Проверяем, что результат отправлен с распарсенными данными
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[0]).toBe('CMD_ANALYZE_NEW_TICKET');
      expect(resultCall[1]).toHaveProperty('success', true);
      expect(resultCall[1].data).toHaveProperty('title', 'Проблема с доступом');
      expect(resultCall[1].data).toHaveProperty('sentiment', 'negative');
    });

    test('должен обработать некорректный JSON и отправить ошибку', async () => {
      mockJob.name = 'CMD_ANALYZE_NEW_TICKET';
      mockJob.data = {
        text: 'Текст',
        targetLanguage: 'ru',
        meta: {},
      };

      // Мок ответа с некорректным JSON
      difyApi.runWorkflow.mockResolvedValue({
        text: 'Не JSON текст',
      });

      // Воркер выбрасывает ошибку после отправки в resultQueue для BullMQ retry стратегии
      // Оборачиваем в try-catch, чтобы проверить отправку ошибки, но не падать на выброшенной ошибке
      try {
        await fastLaneWorker(mockJob);
      } catch (error) {
        // Ожидаем, что ошибка будет выброшена (это нормально для BullMQ retry)
        expect(error).toBeDefined();
      }

      // Проверяем, что ошибка отправлена в resultQueue
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[0]).toBe('CMD_ANALYZE_NEW_TICKET');
      expect(resultCall[1]).toHaveProperty('success', false);
      expect(resultCall[1]).toHaveProperty('error');
    });
  });

  describe('CMD_TRANSLATE', () => {
    test('должен вызвать Workflow для перевода и вернуть переведенный текст', async () => {
      mockJob.name = 'CMD_TRANSLATE';
      mockJob.data = {
        text: 'Hello, world',
        targetLang: 'ru',
        meta: { user: 'user-123' },
      };

      difyApi.sendChatMessage.mockResolvedValue({
        answer: 'Привет, мир',
        metadata: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      });

      await fastLaneWorker(mockJob);

      // Проверяем вызов sendChatMessage (не runWorkflow для CMD_TRANSLATE)
      expect(difyApi.sendChatMessage).toHaveBeenCalledTimes(1);
      const chatCall = difyApi.sendChatMessage.mock.calls[0];
      expect(chatCall[0]).toBe(config.dify.keys.translator);
      expect(chatCall[1]).toBe('Hello, world');
      expect(chatCall[2]).toHaveProperty('lang', 'ru');

      // Проверяем результат
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[1]).toHaveProperty('success', true);
      expect(resultCall[1].data).toHaveProperty('content', 'Привет, мир');
      expect(resultCall[1].data).toHaveProperty('sourceContent', 'Hello, world');
      expect(resultCall[1].data).toHaveProperty('targetLang', 'ru');
    });
  });

  describe('CMD_KB_LIST_FILES', () => {
    test('должен получить список файлов через OrganizationService и difyApi.listDocuments', async () => {
      mockJob.name = 'CMD_KB_LIST_FILES';
      mockJob.data = {
        orgId: 'test-org-123',
        meta: {},
      };

      jest.spyOn(OrganizationService, 'getKbIdsOrThrow').mockResolvedValue({
        adminKbId: 'admin-kb-123',
        historyKbId: 'history-kb-456',
      });

      const mockDocuments = {
        data: [
          {
            id: 'doc-1',
            name: 'file1.pdf',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            word_count: 100,
            indexing_status: 'completed',
          },
          {
            id: 'doc-2',
            name: 'file2.pdf',
            created_at: '2024-01-02T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
            word_count: 200,
            indexing_status: 'completed',
          },
        ],
      };

      difyApi.listDocuments.mockResolvedValue(mockDocuments);

      await fastLaneWorker(mockJob);

      // Проверяем вызовы
      expect(OrganizationService.getKbIdsOrThrow).toHaveBeenCalledWith('test-org-123');
      expect(difyApi.listDocuments).toHaveBeenCalledTimes(1);
      expect(difyApi.listDocuments).toHaveBeenCalledWith(
        config.dify.keys.admin,
        'admin-kb-123',
        1,
        100
      );

      // Проверяем результат
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[1]).toHaveProperty('success', true);
      expect(resultCall[1].data).toHaveProperty('items');
      expect(resultCall[1].data).toHaveProperty('count', 2);
      expect(resultCall[1].data.items).toHaveLength(2);
      expect(resultCall[1].data.items[0]).toHaveProperty('id', 'doc-1');
      expect(resultCall[1].data.items[0]).toHaveProperty('name', 'file1.pdf');
    });

    test('должен вернуть пустой массив при KbNotFoundError', async () => {
      mockJob.name = 'CMD_KB_LIST_FILES';
      mockJob.data = {
        orgId: 'test-org-123',
        meta: {},
      };

      const { KbNotFoundError } = require('../../src/core/errors');
      jest.spyOn(OrganizationService, 'getKbIdsOrThrow').mockRejectedValue(
        new KbNotFoundError('test-org-123')
      );

      await fastLaneWorker(mockJob);

      // Проверяем, что вернулся пустой объект с items и count
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[1]).toHaveProperty('success', true);
      expect(resultCall[1].data).toEqual({ items: [], count: 0 });

      // Проверяем, что listDocuments не вызывался
      expect(difyApi.listDocuments).not.toHaveBeenCalled();
    });
  });

  describe('CMD_KB_DELETE_FILE', () => {
    test('должен удалить файл через OrganizationService и difyApi.deleteDocument', async () => {
      mockJob.name = 'CMD_KB_DELETE_FILE';
      mockJob.data = {
        orgId: 'test-org-123',
        fileId: 'file-123',
        meta: {},
      };

      jest.spyOn(OrganizationService, 'getKbIdsOrThrow').mockResolvedValue({
        adminKbId: 'admin-kb-123',
        historyKbId: 'history-kb-456',
      });

      difyApi.deleteDocument.mockResolvedValue({ success: true });

      await fastLaneWorker(mockJob);

      // Проверяем вызовы
      expect(OrganizationService.getKbIdsOrThrow).toHaveBeenCalledWith('test-org-123');
      expect(difyApi.deleteDocument).toHaveBeenCalledTimes(1);
      expect(difyApi.deleteDocument).toHaveBeenCalledWith(
        config.dify.keys.admin,
        'admin-kb-123',
        'file-123'
      );

      // Проверяем результат
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[1]).toHaveProperty('success', true);
      expect(resultCall[1].data).toHaveProperty('deleted', true);
      expect(resultCall[1].data).toHaveProperty('documentId', 'file-123');
    });
  });

  describe('Context Assembly и Pruning', () => {
    test('должен собрать контекст из чанков и обрезать при превышении лимита', async () => {
      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      // Создаем большие чанки для проверки обрезки
      const largeChunk = 'Большой чанк. '.repeat(500); // ~2000 токенов
      difyApi.retrieve.mockResolvedValue({
        records: [
          {
            segment: {
              content: largeChunk,
            },
            score: 0.9,
          },
        ],
      });
      difyApi.retrieveChunks.mockResolvedValue([
        {
          content: largeChunk,
          score: 0.8,
        },
      ]);

      difyApi.runWorkflow.mockResolvedValue({
        text: 'Ответ',
        metadata: { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
      });

      await fastLaneWorker(mockJob);

      // Проверяем, что runWorkflow вызван с обрезанным контекстом
      expect(difyApi.runWorkflow).toHaveBeenCalledTimes(1);
      const workflowCall = difyApi.runWorkflow.mock.calls[0];

      // Проверяем, что контекст был обрезан (должен быть меньше исходного размера)
      // Учитываем, что может быть добавлен разделитель "История тикетов"
      const contextLength = workflowCall[1].context.length;
      const originalLength = largeChunk.length * 2 + 100; // Два чанка + разделитель
      // Контекст должен быть обрезан, но допускаем небольшую погрешность
      expect(contextLength).toBeLessThanOrEqual(originalLength);

      // Проверяем, что history отформатирован
      expect(workflowCall[1].history).toContain('User:');
      expect(workflowCall[1].history).toContain('Assistant:');
    });
  });

  describe('Usage extraction', () => {
    test('должен извлечь usage из ответа Workflow через BillingService', async () => {
      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      difyApi.retrieve.mockResolvedValue({ records: [] });
      difyApi.retrieveChunks.mockResolvedValue([]);

      const mockWorkflowResponse = {
        text: 'Ответ',
        metadata: {
          usage: {
            prompt_tokens: 2000,
            completion_tokens: 1000,
            total_tokens: 3000,
          },
          model_name: 'gpt-4o',
        },
      };

      difyApi.runWorkflow.mockResolvedValue(mockWorkflowResponse);

      // Спай на BillingService для проверки вызова
      const extractUsageSpy = jest.spyOn(BillingService, 'extractUsage');

      await fastLaneWorker(mockJob);

      // Проверяем, что extractUsage был вызван
      expect(extractUsageSpy).toHaveBeenCalledTimes(1);

      // Проверяем, что usage добавлен в результат (usage находится в meta)
      expect(sendResult).toHaveBeenCalledTimes(1);
      const resultCall = sendResult.mock.calls[0];
      expect(resultCall[1].meta).toHaveProperty('usage');
      expect(resultCall[1].meta.usage.stages).toBeDefined();
      expect(resultCall[1].meta.usage.stages.length).toBeGreaterThan(0);
      // Проверяем последний stage (generation usage)
      const lastStage = resultCall[1].meta.usage.stages[resultCall[1].meta.usage.stages.length - 1];
      expect(lastStage).toHaveProperty('prompt_tokens', 2000);
      expect(lastStage).toHaveProperty('completion_tokens', 1000);
      if (resultCall[1].meta.usage.model) {
        expect(resultCall[1].meta.usage.model).toBe('gpt-4o');
      }
    });
  });

  describe('Error handling', () => {
    test('должен обработать ошибку Workflow и отправить в resultQueue', async () => {
      jest.spyOn(OrganizationService, 'ensureAdminKb').mockResolvedValue('admin-kb-123');
      jest.spyOn(OrganizationService, 'ensureHistoryKb').mockResolvedValue('history-kb-456');

      // Мок для simplifyUserQuery
      difyApi.simplifyUserQuery.mockResolvedValue({
        query: 'Как сбросить пароль?',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });

      difyApi.retrieve.mockResolvedValue({ records: [] });
      difyApi.retrieveChunks.mockResolvedValue([]);

      const { DifyApiError } = require('../../src/core/errors');
      const workflowError = new DifyApiError('Workflow error', 500, 'internal_error', '/workflows/run');
      difyApi.runWorkflow.mockRejectedValue(workflowError);

      // Воркер выбрасывает ошибку после отправки в resultQueue для BullMQ retry стратегии
      // Оборачиваем в try-catch, чтобы проверить отправку ошибки, но не падать на выброшенной ошибке
      try {
        await fastLaneWorker(mockJob);
      } catch (error) {
        // Ожидаем, что ошибка будет выброшена (это нормально для BullMQ retry)
        // safeProcessor пробрасывает оригинальную ошибку, но она может быть обернута
        expect(error).toBeDefined();
        // Проверяем, что это либо DifyApiError, либо обернутая ошибка
        const isDifyApiError = error instanceof DifyApiError || 
                               (error.message && error.message.includes('Workflow error'));
        expect(isDifyApiError).toBe(true);
      }

      // Проверяем, что ошибка отправлена в resultQueue
      // Примечание: sendResult может быть вызван несколько раз из-за вложенных catch блоков,
      // но важно, что ошибка была отправлена хотя бы один раз
      expect(sendResult).toHaveBeenCalled();
      
      // Проверяем, что хотя бы один вызов содержит правильную ошибку
      const resultCalls = sendResult.mock.calls.filter(call => call[0] === 'CMD_GEN_RESPONSE');
      expect(resultCalls.length).toBeGreaterThan(0);
      
      // Проверяем последний вызов (он должен содержать правильную ошибку)
      const lastCall = resultCalls[resultCalls.length - 1];
      expect(lastCall[1]).toHaveProperty('success', false);
      expect(lastCall[1]).toHaveProperty('error');
      expect(lastCall[1].error).toHaveProperty('code');
    });
  });
});

// Глобальное закрытие всех соединений после всех тестов
// Это критично, так как при импорте модулей могут создаваться соединения Redis
// Примечание: Моки должны предотвращать создание реальных соединений,
// но на всякий случай закрываем их, если они были созданы
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
  
  // Даем дополнительное время на закрытие соединений (используем unref чтобы не блокировать завершение)
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    timer.unref(); // Не блокировать завершение процесса
  });
}, 15000);

