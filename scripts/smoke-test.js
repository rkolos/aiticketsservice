/* eslint-disable no-console */
/**
 * E2E Smoke Test для проверки работы всей цепочки обработки задач
 * Эмулирует поведение внешнего сервиса (Main App)
 */

require('dotenv').config({ override: true });

// Для локального запуска скрипта используем localhost, если не указано иное
if (!process.env.REDIS_HOST || process.env.REDIS_HOST === 'redis') {
  process.env.REDIS_HOST = 'localhost';
}

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const crypto = require('crypto');
const { QUEUES } = require('../src/core/constants');
const config = require('../src/config');
const difyApi = require('../src/infrastructure/dify/api');

// Функция для генерации UUID
function uuidv4() {
  return crypto.randomUUID();
}

// Цвета для консоли
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

function getTime() {
  const now = new Date();
  return now.toLocaleTimeString('ru-RU', { hour12: false });
}

// Создаем соединение Redis (будет подключено позже)
let redisConnection;

// Очереди (будут созданы после подключения к Redis)
let entryQueue;
let resultsQueue;

// Map для хранения ожидающих результатов (traceId -> resolve)
const pendingResults = new Map();

// Worker для прослушивания результатов
let resultsWorker;

/**
 * Инициализация Consumer для прослушивания результатов
 */
function initConsumer() {
  resultsWorker = new Worker(
    QUEUES.RESULTS,
    async (job) => {
      // sendResult отправляет данные в формате: { ...data, meta }
      // Поэтому job.data содержит и данные результата, и meta
      const resultData = job.data || {};
      const traceId = resultData.meta?.traceId;

      // Логируем получение задачи для отладки
      console.log(
        colorize(`[${getTime()}]`, 'blue') +
        colorize(' 🔍 RECEIVED JOB', 'yellow') +
        ` (${QUEUES.RESULTS}): ${colorize(job.name, 'magenta')} | TraceID: ${traceId ? colorize(traceId.substring(0, 8), 'yellow') : colorize('missing', 'red')}`
      );

      if (traceId && pendingResults.has(traceId)) {
        const { resolve, jobName, timeoutId } = pendingResults.get(traceId);
        pendingResults.delete(traceId);
        // Очищаем таймаут, если он был установлен
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        // Извлекаем meta из данных и возвращаем остальные данные отдельно
        const { meta, ...data } = resultData;
        resolve({ jobName, data, meta });
      } else {
        // Логируем, если traceId не найден
        if (!traceId) {
          console.log(colorize(`   ⚠️  No traceId in result data`, 'yellow'));
        } else {
          console.log(colorize(`   ⚠️  TraceId ${traceId.substring(0, 8)} not found in pendingResults`, 'yellow'));
        }
      }

      // Возвращаем результат для BullMQ
      return { processed: true, traceId };
    },
    {
      connection: redisConnection,
      concurrency: 10,
    }
  );

  resultsWorker.on('completed', (job) => {
    // Результат уже обработан в processor
  });

  resultsWorker.on('failed', (job, err) => {
    console.error(colorize(`❌ Worker error: ${err.message}`, 'red'));
    if (err.stack) {
      console.error(colorize(`   Stack: ${err.stack}`, 'red'));
    }
  });

  resultsWorker.on('error', (err) => {
    console.error(colorize(`❌ Worker connection error: ${err.message}`, 'red'));
  });

  resultsWorker.on('ready', () => {
    console.log(colorize(`✓ Results Worker ready and listening on ${QUEUES.RESULTS}`, 'green'));
  });

  resultsWorker.on('active', (job) => {
    console.log(
      colorize(`[${getTime()}]`, 'blue') +
      colorize(' 🔄 Worker processing', 'cyan') +
      ` (${QUEUES.RESULTS}): ${colorize(job.name, 'magenta')} | JobID: ${colorize(job.id, 'yellow')}`
    );
  });
}

/**
 * Функция для выполнения теста
 * @param {string} testName - Название теста
 * @param {string} jobName - Имя задачи
 * @param {Object} data - Данные задачи
 * @param {Function} validator - Функция валидации результата
 * @param {number} timeout - Таймаут в миллисекундах (по умолчанию 10000)
 * @param {Queue} entryQueueInstance - Экземпляр очереди для отправки
 * @returns {Promise<boolean>} true если тест прошел успешно
 */
async function runTest(testName, jobName, data, validator, timeout = 10000, entryQueueInstance) {
  const traceId = uuidv4();
  const randomMeta = {
    traceId,
    debugTag: `${jobName}-${Math.random().toString(16).slice(2, 8)}`,
    nested: { ts: Date.now() },
    ...(data.meta || {}),
  };
  const startTime = Date.now();

  console.log(colorize(`\n--- [${testName}] ---`, 'cyan'));

  // Добавляем traceId в meta
  const jobData = {
    ...data,
    meta: {
      ...randomMeta,
    },
  };

  // Выводим информацию об отправке
  const langInfo = data.lang ? colorize(` | Lang: ${data.lang}`, 'yellow') : '';
  console.log(
    colorize(`[${getTime()}]`, 'blue') +
    colorize(' 📤 SENT', 'bright') +
    ` (${QUEUES.ENTRY}): ${colorize(jobName, 'magenta')} | TraceID: ${colorize(traceId.substring(0, 8), 'yellow')}${langInfo}`
  );

  // Выводим полное содержимое задания, которое ушло в очередь (вместе с meta/traceId)
  console.log('   Payload (full):', JSON.stringify(jobData, null, 2));

  // Создаем Promise для ожидания результата
  let timeoutId;
  const resultPromise = new Promise((resolve, reject) => {
    // Таймаут
    timeoutId = setTimeout(() => {
      if (pendingResults.has(traceId)) {
        pendingResults.delete(traceId);
        reject(new Error('TIMEOUT'));
      }
    }, timeout);
    
    pendingResults.set(traceId, {
      resolve: (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
      jobName,
      timeoutId,
      expectedMeta: jobData.meta,
    });
  });

  try {
    // Отправляем задачу
    await entryQueueInstance.add(jobName, jobData);

    // Ждем результат
    const result = await resultPromise;
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Выводим информацию о получении
    console.log(
      colorize(`[${getTime()}]`, 'blue') +
      colorize(' 📥 RECEIVED', 'bright') +
      ` (${QUEUES.RESULTS}): ${result.data?.status === 'error' ? colorize('Error', 'red') : colorize('Success', 'green')}`
    );

  // Логируем сырой результат целиком: данные из очереди результатов вместе с meta
  console.log('   Result (full job):', JSON.stringify(result, null, 2));

  // Проверяем, что meta вернулась неизменной (ожидаем как минимум все поля исходной meta)
  const expectedMeta = pendingResults.get(traceId)?.expectedMeta || jobData.meta;
  const actualMeta = result.meta || {};
  const metaKeysMatch = Object.keys(expectedMeta).every(
    (k) => JSON.stringify(expectedMeta[k]) === JSON.stringify(actualMeta[k])
  );
  if (!metaKeysMatch) {
    console.log(
      colorize('   ❌ META MISMATCH', 'red'),
      'expected:',
      JSON.stringify(expectedMeta),
      'actual:',
      JSON.stringify(actualMeta)
    );
    return false;
  } else {
    console.log(colorize('   ✅ META OK', 'green'));
  }

    // Проверяем статус
    if (result.data?.status === 'error') {
      console.log(colorize(`   ❌ WORKER ERROR: ${result.data.error || result.data.message}`, 'red'));
      return false;
    }

    // Вызываем валидатор
    const isValid = validator(result.data);

    if (isValid) {
      console.log(colorize(`✅ TEST PASSED (${duration}s)`, 'green'));
      return true;
    } else {
      console.log(colorize('❌ VALIDATION FAILED', 'red'));
      console.log('   Received data:', JSON.stringify(result.data, null, 2));
      return false;
    }
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    if (error.message === 'TIMEOUT') {
      console.log(colorize(`❌ TIMEOUT (${duration}s)`, 'red'));
    } else {
      console.log(colorize(`❌ ERROR: ${error.message}`, 'red'));
    }
    return false;
  }
}

/**
 * Валидаторы для каждого типа задачи
 */
const validators = {
  CMD_ANALYZE_NEW_TICKET: (data) => {
    if (!data.success && !data.data) return false;
    const result = data.success ? data.data : data;
    const hasTitle = result.title && typeof result.title === 'string';
    const hasSentiment = result.sentiment && typeof result.sentiment === 'string';
    if (hasTitle) console.log(`   > Title: ${result.title}`);
    if (hasSentiment) console.log(`   > Sentiment: ${result.sentiment}`);
    return hasTitle && hasSentiment;
  },

  CMD_GEN_RESPONSE: (data) => {
    if (!data.success && !data.data) return false;
    const result = data.success ? data.data : data;
    const hasText = result.text && typeof result.text === 'string' && result.text.length > 0;
    const hasUsage = result.usage && typeof result.usage === 'object';
    if (!hasText) {
      console.log('   > Text is empty or missing');
      console.log('   > Raw result:', JSON.stringify(result, null, 2));
      // Не валим тест, если текст пустой: вернём false и дадим увидеть проблему,
      // но не TIMEOUT. Валидация уже вернёт fail.
    }
    if (hasText) {
      const preview = result.text.substring(0, 80);
      console.log(`   > Text: ${preview}${result.text.length > 80 ? '...' : ''}`);
    }
    if (hasUsage && result.usage.totalTokens) {
      console.log(`   > Tokens: ${result.usage.totalTokens}`);
    }
    return hasText && hasUsage;
  },

  CMD_TRANSLATE: (data) => {
    if (!data.success && !data.data) return false;
    const result = data.success ? data.data : data;
    const hasText = result.text && typeof result.text === 'string' && result.text.length > 0;
    // Проверяем наличие кириллицы
    const hasCyrillic = /[а-яё]/i.test(result.text);
    if (hasText) {
      console.log(`   > Translated: ${result.text}`);
      if (hasCyrillic) {
        console.log(colorize('   > Contains Cyrillic ✓', 'green'));
      }
    }
    return hasText;
  },

  CMD_KB_ADD_FILE: (data) => {
    if (data.status !== 'success') return false;
    const hasFileId = data.data?.fileId || data.data?.documentId || data.data?.task_id;
    const hasStatus = data.data?.status;
    if (!hasFileId) {
      console.log('   > File ID missing (accepting success due to fallback)');
    }
    if (data.data?.fallback === 'createDocumentByText') {
      console.log('   > Fallback used: createDocumentByText');
    }
    if (hasFileId) console.log(`   > File ID: ${hasFileId}`);
    if (hasStatus) console.log(`   > Status: ${hasStatus}`);
    return hasStatus === 'indexing' || hasStatus === 'completed' || hasFileId;
  },

  CMD_ARCHIVE_TICKET: (data) => {
    if (data.status !== 'success') return false;
    const hasSummary = data.data?.summary && typeof data.data.summary === 'string';
    // docId может отсутствовать, если API не возвращает идентификатор документа
    const hasDocId = data.data?.docId || data.data?.documentId;
    if (hasSummary) {
      const preview = data.data.summary.substring(0, 80);
      console.log(`   > Summary: ${preview}${data.data.summary.length > 80 ? '...' : ''}`);
    }
    if (hasDocId) console.log(`   > Doc ID: ${hasDocId}`);
    return hasSummary;
  },
};

/**
 * Функция задержки между тестами
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Проверка доступности Dify API
 * @returns {Promise<boolean>} true если API доступен
 */
async function checkDifyApi() {
  try {
    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      console.error(colorize('\n❌ Dify Admin key not configured', 'red'));
      console.error(colorize('Please set DIFY_KEY_ADMIN in .env file', 'yellow'));
      return false;
    }

    console.log(colorize(`Checking Dify API at ${config.dify.url}...`, 'yellow'));
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Dify API timeout')), 5000);
    });

    // Простой запрос к Dify API для проверки доступности
    const apiPromise = difyApi.listDatasets(adminKey, 1, 1);

    await Promise.race([apiPromise, timeoutPromise]);

    console.log(colorize(`✓ Dify API is accessible\n`, 'green'));
    return true;
  } catch (error) {
    let message = 'API unavailable';
    if (error.message) {
      if (error.message.includes('timeout')) {
        message = 'Connection timeout';
      } else if (error.statusCode) {
        message = `${error.statusCode} ${error.statusText || 'Error'}`;
      } else {
        message = error.message;
      }
    }

    console.error(colorize(`\n❌ Dify API is not accessible: ${message}`, 'red'));
    console.error(colorize(`   URL: ${config.dify.url}`, 'yellow'));
    console.error(colorize('Please ensure Dify is running and accessible', 'yellow'));
    if (error.stack) {
      console.error(colorize(`   Error: ${error.stack}`, 'red'));
    }
    return false;
  }
}

/**
 * Главная функция
 */
async function main() {
  console.log(colorize('\n🚀 Starting E2E Smoke Test...', 'bright'));
  
  // Создаем соединение Redis
  redisConnection = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    retryStrategy: (times) => {
      if (times > 3) {
        return null; // Прекратить попытки
      }
      return Math.min(times * 200, 2000);
    },
  });
  
  // Обработка ошибок подключения
  redisConnection.on('error', (error) => {
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error(colorize(`\n❌ Cannot connect to Redis at ${config.redis.host}:${config.redis.port}`, 'red'));
      console.error(colorize('Please ensure Redis is running and accessible', 'yellow'));
      process.exit(1);
    }
  });
  
  // Подключаемся к Redis с таймаутом
  try {
    console.log(colorize(`Connecting to Redis at ${config.redis.host}:${config.redis.port}...`, 'yellow'));
    const pingPromise = redisConnection.ping();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis connection timeout (5s)')), 5000)
    );
    await Promise.race([pingPromise, timeoutPromise]);
    console.log(colorize(`✓ Connected to Redis at ${config.redis.host}:${config.redis.port}`, 'green'));
  } catch (error) {
    console.error(colorize(`\n❌ Cannot connect to Redis at ${config.redis.host}:${config.redis.port}`, 'red'));
    console.error(colorize('Please ensure Redis is running and accessible', 'yellow'));
    console.error(colorize(`Error: ${error.message}`, 'red'));
    try {
      await redisConnection.quit();
    } catch {}
    process.exit(1);
  }
  
  // Проверяем доступность Dify API
  const isDifyAvailable = await checkDifyApi();
  if (!isDifyAvailable) {
    try {
      await redisConnection.quit();
    } catch {}
    process.exit(1);
  }
  
  // Создаем очереди после подключения
  const entryQueue = new Queue(QUEUES.ENTRY, { connection: redisConnection });
  const resultsQueue = new Queue(QUEUES.RESULTS, { connection: redisConnection });

  // Инициализируем Consumer
  initConsumer();

  // Даем время на инициализацию
  await sleep(1000);
  
  // Проверяем, что воркеры запущены (опционально - можно пропустить, если воркеры не обязательны для проверки)
  console.log(colorize('⚠️  Note: Make sure workers are running (npm run dev) for tests to complete\n', 'yellow'));

  const testResults = [];
  const startTime = Date.now();

  try {
    // TEST 1: CMD_ANALYZE_NEW_TICKET
    const test1 = await runTest(
      'TEST 1/5: Analyzing Ticket',
      'CMD_ANALYZE_NEW_TICKET',
      {
        text: 'У меня не работает вход в систему, ошибка 500',
        targetLanguage: 'en',
        meta: {},
      },
      validators.CMD_ANALYZE_NEW_TICKET,
      20000,
      entryQueue
    );
    testResults.push({ name: 'CMD_ANALYZE_NEW_TICKET', passed: test1 });
    await sleep(2000);

    // TEST 2: CMD_GEN_RESPONSE с lang
    const test2 = await runTest(
      'TEST 2/5: Generating Response (EN)',
      'CMD_GEN_RESPONSE',
      {
        orgId: 'test-org-smoke',
        query: 'How to reset password?',
        // История в markdown-строке с указанием ролей
        history:
          'User: I forgot my password\n' +
          'Assistant: I can help you reset it\n' +
          'User: Thanks, what should I do next?\n' +
          'Assistant: I will guide you through the reset steps.',
        lang: 'en',
        meta: {},
      },
      validators.CMD_GEN_RESPONSE,
      30000, // Увеличенный таймаут для генерации ответа
      entryQueue
    );
    testResults.push({ name: 'CMD_GEN_RESPONSE', passed: test2 });
    await sleep(2000);

    // TEST 3: CMD_TRANSLATE
    const test3 = await runTest(
      'TEST 3/5: Translation',
      'CMD_TRANSLATE',
      {
        text: 'Привет мир',
        targetLang: 'en',
        meta: {},
      },
      validators.CMD_TRANSLATE,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_TRANSLATE', passed: test3 });
    await sleep(2000);

    // TEST 4: CMD_KB_ADD_FILE
    // Используем публичный файл (например, README из GitHub)
    const test4 = await runTest(
      'TEST 4/5: File Upload',
      'CMD_KB_ADD_FILE',
      {
        orgId: 'test-org-smoke',
        fileUrl: 'https://raw.githubusercontent.com/langchain-ai/langchain/master/README.md',
        fileName: 'test-readme.md',
        meta: {},
      },
      validators.CMD_KB_ADD_FILE,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_KB_ADD_FILE', passed: test4 });
    await sleep(2000);

    // TEST 5: CMD_ARCHIVE_TICKET
    const test5 = await runTest(
      'TEST 5/5: Archiving Ticket',
      'CMD_ARCHIVE_TICKET',
      {
        orgId: 'test-org-smoke',
        fullTicketHistory: [
          { role: 'user', content: 'У меня проблема с доступом' },
          { role: 'assistant', content: 'Проверьте настройки безопасности' },
          { role: 'user', content: 'Спасибо, помогло!' },
        ],
        lang: 'en',
        meta: {
          ticketId: 'smoke-test-ticket-123',
        },
      },
      validators.CMD_ARCHIVE_TICKET,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_ARCHIVE_TICKET', passed: test5 });
  } catch (error) {
    console.error(colorize(`\n❌ Fatal error: ${error.message}`, 'red'));
    console.error(error.stack);
  } finally {
    // Закрываем соединения
    console.log(colorize('\n📊 SUMMARY', 'bright'));
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const passed = testResults.filter((t) => t.passed).length;
    const failed = testResults.length - passed;

    console.log(`Total Tests: ${testResults.length}`);
    console.log(colorize(`Passed: ${passed}`, 'green'));
    if (failed > 0) {
      console.log(colorize(`Failed: ${failed}`, 'red'));
      testResults.filter((t) => !t.passed).forEach((t) => {
        console.log(colorize(`  - ${t.name}`, 'red'));
      });
    }
    console.log(`Duration: ${duration}s\n`);

    // Закрываем worker и соединения
    if (resultsWorker) {
      await resultsWorker.close();
    }
    await entryQueue.close();
    await resultsQueue.close();
    await redisConnection.quit();

    process.exit(failed > 0 ? 1 : 0);
  }
}

// Запускаем тест
main().catch((error) => {
  console.error(colorize(`\n❌ Unhandled error: ${error.message}`, 'red'));
  console.error(error.stack);
  process.exit(1);
});

