#!/usr/bin/env node

/**
 * Скрипт для проверки работоспособности модулей пунктов 5-7
 */

// Устанавливаем переменные окружения перед импортом config
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.HEALTHCHECK_PORT = '3000';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_PASSWORD = '';
process.env.DIFY_API_URL = 'http://localhost/v1';
process.env.DIFY_KEY_ADMIN = 'test-admin-key';
process.env.DIFY_KEY_CLASSIFIER = 'test-classifier-key';
process.env.DIFY_KEY_SUMMARIZER = 'test-summarizer-key';
process.env.DIFY_KEY_RESPONSE_WORKFLOW = 'test-response-key';
process.env.WORKER_FAST_LANE_CONCURRENCY = '15';
process.env.WORKER_SLOW_LANE_CONCURRENCY = '2';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Ошибка: ${error.message}`);
    failed++;
  }
}

console.log('🧪 Проверка работоспособности модулей пунктов 5-7\n');
console.log('='.repeat(60));

// Пункт 5: Dify API Client
console.log('\n📦 Пункт 5: Dify API Client');
test('Импорт Dify клиента', () => {
  const client = require('../src/infrastructure/dify/client');
  if (!client) throw new Error('Client is undefined');
});

test('Импорт Dify API методов', () => {
  const api = require('../src/infrastructure/dify/api');
  const methods = [
    'runWorkflow',
    'sendChatMessage',
    'listDatasets',
    'createDataset',
    'deleteDataset',
    'createDocumentByText',
    'uploadFile',
    'listDocuments',
    'deleteDocument',
    'retrieveChunks',
  ];

  methods.forEach((method) => {
    if (typeof api[method] !== 'function') {
      throw new Error(`Method ${method} is not a function`);
    }
  });
});

test('DifyApiError класс', () => {
  const { DifyApiError } = require('../src/core/errors');
  const error = new DifyApiError('Test', 404, 'not_found', '/test');
  if (error.statusCode !== 404) throw new Error('Invalid statusCode');
  if (error.difyCode !== 'not_found') throw new Error('Invalid difyCode');
});

// Пункт 6: BullMQ Infrastructure
console.log('\n📦 Пункт 6: BullMQ Infrastructure');
test('Импорт фабрики воркеров', () => {
  const factory = require('../src/infrastructure/bullmq/factory');
  if (typeof factory !== 'function') {
    throw new Error('Factory is not a function');
  }
});

test('Импорт очереди результатов', () => {
  const { resultQueue, sendResult } = require('../src/infrastructure/bullmq/resultQueue');
  if (!resultQueue) throw new Error('resultQueue is undefined');
  if (typeof sendResult !== 'function') {
    throw new Error('sendResult is not a function');
  }
});

test('Импорт initWorkers', () => {
  const { initWorkers } = require('../src/infrastructure/bullmq');
  if (typeof initWorkers !== 'function') {
    throw new Error('initWorkers is not a function');
  }
});

test('Константы очередей', () => {
  const { QUEUES } = require('../src/core/constants');
  if (QUEUES.INTERACTIVE !== 'ai-interactive-queue') {
    throw new Error('Invalid INTERACTIVE queue name');
  }
  if (QUEUES.BACKGROUND !== 'ai-background-queue') {
    throw new Error('Invalid BACKGROUND queue name');
  }
  if (QUEUES.RESULTS !== 'ai-results-queue') {
    throw new Error('Invalid RESULTS queue name');
  }
});

test('Процессоры воркеров', () => {
  const fastProcessor = require('../src/workers/fastLaneProcessor');
  const slowProcessor = require('../src/workers/slowLaneProcessor');
  if (typeof fastProcessor !== 'function') {
    throw new Error('fastLaneProcessor is not a function');
  }
  if (typeof slowProcessor !== 'function') {
    throw new Error('slowLaneProcessor is not a function');
  }
});

// Пункт 7: Utils
console.log('\n📦 Пункт 7: Utils');
test('tokenCounter - countTokens', () => {
  const { countTokens } = require('../src/utils/tokenCounter');
  const tokens = countTokens('Hello world', 'gpt-4');
  if (typeof tokens !== 'number' || tokens < 0) {
    throw new Error('Invalid token count');
  }
});

test('tokenCounter - estimateTotalTokens', () => {
  const { estimateTotalTokens } = require('../src/utils/tokenCounter');
  const result = estimateTotalTokens('Context', 'History', 'Query', 'gpt-4');
  if (!result.total || result.total < 0) {
    throw new Error('Invalid total tokens');
  }
  if (typeof result.context !== 'number') {
    throw new Error('Invalid context tokens');
  }
});

test('historyFormatter', () => {
  const { formatTicketHistory } = require('../src/utils/historyFormatter');
  const messages = [
    { role: 'user', content: 'Вопрос 1' },
    { role: 'assistant', content: 'Ответ 1' },
  ];
  const formatted = formatTicketHistory(messages);
  if (!formatted.includes('User: Вопрос 1')) {
    throw new Error('Invalid formatting');
  }
});

test('llmParser', () => {
  const { cleanLlmJson } = require('../src/utils/llmParser');
  const jsonWithWrapper = '```json\n{"key": "value"}\n```';
  const cleaned = cleanLlmJson(jsonWithWrapper);
  const parsed = JSON.parse(cleaned);
  if (parsed.key !== 'value') {
    throw new Error('Invalid JSON parsing');
  }
});

// Пункт 8: Error Handler и Billing
console.log('\n📦 Пункт 8: Error Handler и Billing');
test('errorHandler - normalizeError', () => {
  const { normalizeError } = require('../src/utils/errorHandler');
  const { DifyApiError } = require('../src/core/errors');
  const error = new DifyApiError('Test', 404, 'not_found', '/test');
  const normalized = normalizeError(error);
  if (!normalized.errorCode || !normalized.message) {
    throw new Error('Invalid normalized error');
  }
});

test('errorHandler - createErrorPayload', () => {
  const { createErrorPayload } = require('../src/utils/errorHandler');
  const error = new Error('Test error');
  const payload = createErrorPayload(error, { orgId: '123' });
  if (payload.status !== 'error') {
    throw new Error('Invalid payload status');
  }
  if (!payload.meta || payload.meta.orgId !== '123') {
    throw new Error('Meta not preserved');
  }
});

test('BillingService - extractUsage', () => {
  const { extractUsage } = require('../src/services/BillingService');
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
  if (usage.prompt_tokens !== 10) {
    throw new Error('Invalid prompt_tokens');
  }
  if (usage.model !== 'gpt-4o') {
    throw new Error('Invalid model');
  }
});

// Итоги
console.log('\n' + '='.repeat(60));
console.log('\n📊 Результаты проверки:');
console.log(`   ✅ Пройдено: ${passed}`);
console.log(`   ❌ Провалено: ${failed}`);
console.log(`   📈 Всего тестов: ${passed + failed}`);

if (failed > 0) {
  console.log('\n❌ Обнаружены ошибки в модулях!');
  process.exit(1);
} else {
  console.log('\n🎉 Все модули работают корректно!');
  process.exit(0);
}

