const {
  assembleContext,
  calculateLimits,
  pruneContext,
  pruneHistory,
} = require('../../src/workers/fastLaneWorker');
const tokenCounter = require('../../src/utils/tokenCounter');

// Моки для логгера и других зависимостей
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('fastLaneWorker - Context Assembly & Pruning', () => {
  describe('assembleContext', () => {
    test('должен собирать контекст из adminChunks и historyChunks', () => {
      const adminChunks = [
        { content: 'Административный чанк 1', score: 0.9 },
        { content: 'Административный чанк 2', score: 0.8 },
      ];
      const historyChunks = [{ content: 'Исторический чанк 1', score: 0.7 }];

      const context = assembleContext(adminChunks, historyChunks);

      expect(context).toContain('## Контекст из базы знаний');
      expect(context).toContain('### Административная база');
      expect(context).toContain('### История тикетов');
      expect(context).toContain('Административный чанк 1');
      expect(context).toContain('Административный чанк 2');
      expect(context).toContain('Исторический чанк 1');
    });

    test('должен возвращать сообщение, если чанков нет', () => {
      const context = assembleContext([], []);

      expect(context).toBe('Контекст не найден');
    });

    test('должен обрабатывать только adminChunks', () => {
      const adminChunks = [{ content: 'Административный чанк', score: 0.9 }];
      const context = assembleContext(adminChunks, []);

      expect(context).toContain('### Административная база');
      expect(context).toContain('Административный чанк');
      expect(context).not.toContain('### История тикетов');
    });

    test('должен обрабатывать только historyChunks', () => {
      const historyChunks = [{ content: 'Исторический чанк', score: 0.7 }];
      const context = assembleContext([], historyChunks);

      expect(context).toContain('### История тикетов');
      expect(context).toContain('Исторический чанк');
      expect(context).not.toContain('### Административная база');
    });

    test('должен использовать поле text, если content отсутствует', () => {
      const adminChunks = [{ text: 'Текст из поля text', score: 0.9 }];
      const context = assembleContext(adminChunks, []);

      expect(context).toContain('Текст из поля text');
    });
  });

  describe('calculateLimits', () => {
    test('должен вычислять лимиты для context и history', () => {
      const contextTokens = 1000;
      const historyTokens = 2000;
      const queryTokens = 100;

      const limits = calculateLimits(contextTokens, historyTokens, queryTokens);

      expect(limits).toHaveProperty('contextLimit');
      expect(limits).toHaveProperty('historyLimit');
      expect(limits).toHaveProperty('limits');
      expect(limits.limits).toHaveProperty('difyInputVariable');
      expect(limits.limits).toHaveProperty('difyRequestBody');
      expect(limits.limits).toHaveProperty('modelContextWindow');

      expect(limits.contextLimit).toBeGreaterThan(0);
      expect(limits.historyLimit).toBeGreaterThan(0);
    });

    test('должен выбирать минимальный лимит из трех уровней', () => {
      const limits = calculateLimits(1000, 2000, 100);

      // Лимит должен быть минимальным из трех
      const minLimit = Math.min(
        limits.limits.difyInputVariable,
        limits.limits.difyRequestBody,
        limits.limits.modelContextWindow
      );

      expect(limits.contextLimit).toBeLessThanOrEqual(minLimit);
      expect(limits.historyLimit).toBeLessThanOrEqual(minLimit);
    });
  });

  describe('pruneContext', () => {
    const modelName = 'gpt-4';
    const jobId = 'test-job-123';

    test('должен возвращать контекст без изменений, если лимит не превышен', () => {
      const adminChunks = [{ content: 'Короткий чанк', score: 0.9 }];
      const historyChunks = [{ content: 'Еще один короткий чанк', score: 0.8 }];
      const contextLimit = 10000; // Большой лимит

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      expect(result.adminChunks.length).toBe(adminChunks.length);
      expect(result.historyChunks.length).toBe(historyChunks.length);
      expect(result.pruningInfo.removedHistoryChunks).toBe(0);
      expect(result.pruningInfo.trimmedAdminChunks).toBe(false);
    });

    test('должен обрезать historyChunks при превышении лимита', () => {
      // Создаем большие чанки
      const largeChunk = 'Большой чанк. '.repeat(500); // ~2000 токенов
      const adminChunks = [{ content: largeChunk, score: 0.9 }];
      const historyChunks = [
        { content: largeChunk, score: 0.8 },
        { content: largeChunk, score: 0.7 },
      ];
      const contextLimit = 3000; // Малый лимит

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      // adminChunks должны остаться нетронутыми
      expect(result.adminChunks.length).toBe(adminChunks.length);
      // historyChunks должны быть обрезаны
      expect(result.historyChunks.length).toBeLessThanOrEqual(historyChunks.length);
      expect(result.pruningInfo.removedHistoryChunks).toBeGreaterThan(0);
    });

    test('должен сохранять все adminChunks перед historyChunks', () => {
      const largeChunk = 'Большой чанк. '.repeat(500);
      const adminChunks = [
        { content: largeChunk, score: 0.9 },
        { content: largeChunk, score: 0.85 },
      ];
      const historyChunks = [
        { content: largeChunk, score: 0.8 },
        { content: largeChunk, score: 0.7 },
      ];
      const contextLimit = 5000; // Средний лимит

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      // Все adminChunks должны остаться
      expect(result.adminChunks.length).toBe(adminChunks.length);
      // historyChunks могут быть обрезаны
      expect(result.pruningInfo.removedHistoryChunks).toBeGreaterThanOrEqual(0);
    });

    test('должен обрезать содержимое adminChunks, если после удаления historyChunks лимит все еще превышен', () => {
      const veryLargeChunk = 'Очень большой чанк. '.repeat(1000); // ~4000 токенов
      const adminChunks = [{ content: veryLargeChunk, score: 0.9 }];
      const historyChunks = [];
      const contextLimit = 2000; // Малый лимит

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      // adminChunks должны остаться, но их содержимое обрезано
      expect(result.adminChunks.length).toBe(adminChunks.length);
      expect(result.pruningInfo.trimmedAdminChunks).toBe(true);

      // Проверяем, что контекст уложился в лимит
      const finalTokens = tokenCounter.countTokens(result.context, modelName);
      expect(finalTokens).toBeLessThanOrEqual(contextLimit * 1.1); // Допускаем небольшую погрешность
    });
  });

  describe('pruneHistory', () => {
    const modelName = 'gpt-4';
    const jobId = 'test-job-123';

    test('должен возвращать историю без изменений, если лимит не превышен', () => {
      const history = 'User: Привет\nAssistant: Здравствуйте!';
      const historyLimit = 10000; // Большой лимит

      const result = pruneHistory(history, modelName, historyLimit, jobId);

      expect(result.history).toBe(history);
      expect(result.pruningInfo.trimmed).toBe(false);
    });

    test('должен обрезать историю при превышении лимита', () => {
      const longHistory = 'User: Сообщение. '.repeat(500); // Длинная история
      const historyLimit = 1000; // Малый лимит

      const result = pruneHistory(longHistory, modelName, historyLimit, jobId);

      expect(result.pruningInfo.trimmed).toBe(true);
      expect(result.pruningInfo.prunedTokens).toBeLessThanOrEqual(historyLimit * 1.1);

      // Проверяем, что обрезанная история короче оригинальной
      const prunedTokens = tokenCounter.countTokens(result.history, modelName);
      const originalTokens = tokenCounter.countTokens(longHistory, modelName);
      expect(prunedTokens).toBeLessThan(originalTokens);
    });

    test('должен обрезать историю с конца', () => {
      const history = 'User: Первое сообщение\nAssistant: Ответ\nUser: Второе сообщение\nAssistant: Второй ответ';
      const historyLimit = 10; // Очень малый лимит

      const result = pruneHistory(history, modelName, historyLimit, jobId);

      expect(result.pruningInfo.trimmed).toBe(true);
      // Обрезанная история должна быть короче
      expect(result.history.length).toBeLessThan(history.length);
    });

    test('должен обрабатывать пустую историю', () => {
      const result = pruneHistory('', modelName, 1000, jobId);

      expect(result.history).toBe('');
      expect(result.pruningInfo.trimmed).toBe(false);
    });
  });

  describe('Интеграционные тесты обрезки', () => {
    const modelName = 'gpt-4';
    const jobId = 'test-job-123';

    test('должен корректно обрабатывать превышение лимита Dify Input Variable', () => {
      const largeChunk = 'Большой чанк. '.repeat(1000);
      const adminChunks = [{ content: largeChunk, score: 0.9 }];
      const historyChunks = [{ content: largeChunk, score: 0.8 }];
      // Лимит меньше размера одного чанка
      const contextLimit = 1000;

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      expect(result.pruningInfo.originalTokens).toBeGreaterThan(contextLimit);
      expect(result.pruningInfo.prunedTokens).toBeLessThanOrEqual(contextLimit * 1.1);
    });

    test('должен корректно обрабатывать превышение лимита Model Context Window', () => {
      const veryLargeChunk = 'Очень большой чанк. '.repeat(2000);
      const adminChunks = [{ content: veryLargeChunk, score: 0.9 }];
      const historyChunks = [];
      // Лимит модели (консервативный)
      const contextLimit = 2000;

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      expect(result.pruningInfo.trimmedAdminChunks).toBe(true);
      expect(result.pruningInfo.prunedTokens).toBeLessThanOrEqual(contextLimit * 1.1);
    });

    test('должен сохранять приоритет adminChunks над historyChunks', () => {
      const chunk = 'Чанк. '.repeat(200);
      const adminChunks = [
        { content: chunk, score: 0.9 },
        { content: chunk, score: 0.85 },
      ];
      const historyChunks = [
        { content: chunk, score: 0.8 },
        { content: chunk, score: 0.7 },
        { content: chunk, score: 0.6 },
      ];
      const contextLimit = 1500; // Лимит, который требует обрезки

      const result = pruneContext(adminChunks, historyChunks, modelName, contextLimit, jobId);

      // Все adminChunks должны остаться
      expect(result.adminChunks.length).toBe(adminChunks.length);
      // historyChunks должны быть обрезаны
      expect(result.historyChunks.length).toBeLessThanOrEqual(historyChunks.length);
      expect(result.pruningInfo.removedHistoryChunks).toBeGreaterThan(0);
    });
  });
});

