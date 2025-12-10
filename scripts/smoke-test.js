/* eslint-disable no-console */
/**
 * E2E Smoke Test для проверки работы всей цепочки обработки задач
 * Эмулирует поведение внешнего сервиса (Main App)
 */

/**
 * Отдельный тест для отладки RAG поиска
 */
async function debugRAGTest() {
  console.log(colorize('\n🔍 DEBUG RAG TEST - Отладка поиска по базе знаний\n', 'cyan'));

  // Используем тот же подход, что и в основном main() - создаем очередь и воркер
  // Создаем соединение Redis
  const redisConnection = new Redis({
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

  // Создаем очереди
  const debugEntryQueue = new Queue(QUEUES.ENTRY, { connection: redisConnection });

  // Создаем Map для хранения ожидающих результатов (traceId -> resolve)
  const debugPendingResults = new Map();

  // Создаем воркер для прослушивания результатов (для отладочного теста)
  const debugResultsWorker = new Worker(
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

      if (traceId && debugPendingResults.has(traceId)) {
        const { resolve, jobName, timeoutId } = debugPendingResults.get(traceId);
        debugPendingResults.delete(traceId);
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
          console.log(colorize(`   ⚠️  TraceId ${traceId.substring(0, 8)} not found in debugPendingResults`, 'yellow'));
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

  debugResultsWorker.on('completed', (job) => {
    // Результат уже обработан в processor
  });

  debugResultsWorker.on('failed', (job, err) => {
    console.error(colorize(`❌ Debug Worker error: ${err.message}`, 'red'));
    if (err.stack) {
      console.error(colorize(`   Stack: ${err.stack}`, 'red'));
    }
  });

  debugResultsWorker.on('error', (err) => {
    console.error(colorize(`❌ Debug Worker connection error: ${err.message}`, 'red'));
  });

  debugResultsWorker.on('ready', () => {
    console.log(colorize(`✓ Debug Results Worker ready and listening on ${QUEUES.RESULTS}`, 'green'));
  });

  debugResultsWorker.on('active', (job) => {
    console.log(
      colorize(`[${getTime()}]`, 'blue') +
      colorize(' 🔄 Debug Worker processing', 'cyan') +
      ` (${QUEUES.RESULTS}): ${colorize(job.name, 'magenta')} | JobID: ${colorize(job.id, 'yellow')}`
    );
  });

  // Функция для запуска тестов в отладочном режиме
  async function debugRunTest(testName, jobName, data, validator, timeout = 10000) {
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
    console.log(
      colorize(`[${getTime()}]`, 'blue') +
      colorize(' 📤 SENT', 'bright') +
      ` (${QUEUES.ENTRY}): ${colorize(jobName, 'magenta')} | TraceID: ${colorize(traceId.substring(0, 8), 'yellow')}`
    );

    // Создаем Promise для ожидания результата
    let timeoutId;
    const resultPromise = new Promise((resolve, reject) => {
      // Таймаут
      timeoutId = setTimeout(() => {
        if (debugPendingResults.has(traceId)) {
          debugPendingResults.delete(traceId);
          reject(new Error('TIMEOUT'));
        }
      }, timeout);

      debugPendingResults.set(traceId, {
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
      await debugEntryQueue.add(jobName, jobData);

      // Ждем результат
      const result = await resultPromise;

      const duration = Date.now() - startTime;
      console.log(
        colorize(`[${getTime()}]`, 'blue') +
        colorize(' ✅ RECEIVED', 'green') +
        ` (${QUEUES.RESULTS}): ${colorize(result.jobName, 'magenta')} | Duration: ${colorize(duration + 'ms', 'yellow')}`
      );

      // Валидируем результат
      const validationResult = await validator(result.data);

      if (validationResult) {
        console.log(colorize(`✅ TEST PASSED (${duration}ms)`, 'green'));
      } else {
        console.log(colorize(`❌ TEST FAILED (${duration}ms)`, 'red'));
      }

      return validationResult;

    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(
        colorize(`[${getTime()}]`, 'blue') +
        colorize(' ❌ ERROR', 'red') +
        ` (${QUEUES.RESULTS}): ${colorize(jobName, 'magenta')} | Duration: ${colorize(duration + 'ms', 'yellow')} | Error: ${error.message}`
      );

      if (error.message !== 'TIMEOUT') {
        console.error(colorize(`   Stack: ${error.stack}`, 'red'));
      }

      return false;
    }
  }

  // 1. Загружаем Open WebUI README
  console.log('1️⃣ Загружаем Open WebUI README...');
  const test1 = await debugRunTest(
    'DEBUG: File Upload (Open WebUI README)',
    'CMD_KB_ADD_FILE',
    {
      orgId: 'test-debug-rag',
      fileUrl: 'https://raw.githubusercontent.com/open-webui/open-webui/main/README.md',
      fileName: 'open-webui-readme.md',
      meta: {},
    },
    validators.CMD_KB_ADD_FILE,
    30000 // Увеличенный таймаут для загрузки файла
  );

  if (!test1) {
    console.error(colorize('❌ Failed to upload Open WebUI README', 'red'));
    return;
  }

  // 2. Загружаем Alpaca WebUI README
  console.log('2️⃣ Загружаем Alpaca WebUI README...');
  const test2 = await debugRunTest(
    'DEBUG: File Upload (Alpaca WebUI README)',
    'CMD_KB_ADD_FILE',
    {
      orgId: 'test-debug-rag',
      fileUrl: 'https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md',
      fileName: 'alpaca-webui-readme.md',
      meta: {},
    },
    validators.CMD_KB_ADD_FILE,
    30000 // Увеличенный таймаут для загрузки файла
  );

  if (!test2) {
    console.error(colorize('❌ Failed to upload Alpaca WebUI README', 'red'));
    return;
  }

  // 3. Ждем индексации (увеличенное время)
  console.log('3️⃣ Ждем индексации файлов...');
  await sleep(30000); // Увеличенное время ожидания индексации

  // 4. Синхронизируем кэш
  console.log('4️⃣ Синхронизируем кэш...');
  const cacheSync = await debugRunTest(
    'DEBUG: Sync Cache',
    'CMD_SYS_RESYNC_CACHE',
    { meta: {} },
    validators.CMD_SYS_RESYNC_CACHE,
    20000 // Увеличенный таймаут для синхронизации
  );

  if (!cacheSync) {
    console.log(colorize('⚠️ Cache sync failed, continuing...', 'yellow'));
  }

  // 5. Проверяем список файлов
  console.log('5️⃣ Проверяем список файлов...');
  const fileList = await debugRunTest(
    'DEBUG: List Files',
    'CMD_KB_LIST_FILES',
    {
      orgId: 'test-debug-rag',
      meta: {},
    },
    (data) => {
      const result = validators.CMD_KB_LIST_FILES(data);
      if (result && data.data && Array.isArray(data.data)) {
        console.log(`   📁 Found ${data.data.length} files:`);
        data.data.forEach(file => {
          console.log(`     - ${file.name} (${file.word_count} words, status: ${file.status})`);
        });
      }
      return result;
    },
    15000 // Увеличенный таймаут для списка файлов
  );

  // 6. Тестируем простой поиск по словам из README
  console.log('6️⃣ Тестируем поиск по слову "Open WebUI"...');
  const searchTest1 = await debugRunTest(
    'DEBUG: Search "Open WebUI"',
    'CMD_GEN_RESPONSE',
    {
      orgId: 'test-debug-rag',
      query: 'What is Open WebUI?',
      history: 'User: I want to learn about AI tools\nAssistant: I can help you learn about AI tools',
      lang: 'en',
      meta: {},
    },
    (data) => {
      const result = validators.CMD_GEN_RESPONSE(data);
      if (data.data) {
        console.log(`   📄 Retrieved chunks: ${data.data.retrievedContext?.length || 0}`);
        if (data.data.retrievedContext && data.data.retrievedContext.length > 0) {
          console.log('   📝 First chunk preview:', data.data.retrievedContext[0].content?.substring(0, 100) + '...');
        }
      }
      return result;
    },
    45000 // Увеличенный таймаут для генерации ответа
  );

  // 6.5. Тестируем поиск по слову "README"
  console.log('6.5️⃣ Тестируем поиск по слову "README"...');
  const searchTest1_5 = await debugRunTest(
    'DEBUG: Search "README"',
    'CMD_GEN_RESPONSE',
    {
      orgId: 'test-debug-rag',
      query: 'Tell me about README files',
      history: 'User: I want to learn about documentation\nAssistant: I can help you with documentation',
      lang: 'en',
      meta: {},
    },
    (data) => {
      const result = validators.CMD_GEN_RESPONSE(data);
      if (data.data) {
        console.log(`   📄 Retrieved chunks: ${data.data.retrievedContext?.length || 0}`);
        if (data.data.retrievedContext && data.data.retrievedContext.length > 0) {
          console.log('   📝 First chunk preview:', data.data.retrievedContext[0].content?.substring(0, 100) + '...');
        }
      }
      return result;
    },
    45000 // Увеличенный таймаут для генерации ответа
  );

  // 7. Тестируем поиск по генерации изображений
  console.log('7️⃣ Тестируем поиск по генерации изображений...');
  const searchTest2 = await debugRunTest(
    'DEBUG: Search "image generation"',
    'CMD_GEN_RESPONSE',
    {
      orgId: 'test-debug-rag',
      query: 'Tell me about image generation in Open WebUI',
      history: 'User: I need information about AI tools\nAssistant: What specifically interests you?',
      lang: 'en',
      meta: {},
    },
    validators.CMD_GEN_RESPONSE,
    45000 // Увеличенный таймаут для генерации ответа
  );

  // 8. Тестируем оригинальный вопрос пользователя
  console.log('8️⃣ Тестируем оригинальный вопрос пользователя...');
  const originalQuestion = await debugRunTest(
    'DEBUG: Original User Question',
    'CMD_GEN_RESPONSE',
    {
      orgId: 'test-debug-rag',
      query: 'Hello! I am trying to decide between installing Alpaca WebUI and Open WebUI, and image generation is very important to me. Could you please clarify if Alpaca WebUI also supports local image engines? Please tell me exactly which models or providers are currently supported for image generation in both Alpaca WebUI and Open WebUI.',
      history: 'User: I want to compare different WebUI projects\nAssistant: I can help you compare different AI WebUI projects',
      lang: 'uk',
      meta: {},
    },
    validators.CMD_GEN_RESPONSE,
    60000 // Большой таймаут для сложного запроса на украинском
  );

  // 9. Очистка
  console.log('9️⃣ Очистка тестовых данных...');
  const cleanup = await debugRunTest(
    'DEBUG: Cleanup',
    'CMD_CLEANUP_ORG',
    {
      orgId: 'test-debug-rag',
      meta: {},
    },
    validators.CMD_CLEANUP_ORG,
    20000 // Увеличенный таймаут для очистки
  );

  console.log(colorize('\n🔍 DEBUG RAG TEST COMPLETED\n', 'green'));

  // Закрываем соединения
  await debugResultsWorker.close();
  await debugEntryQueue.close();
  await redisConnection.quit();
}

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

    // Проверяем статус (но не возвращаем false сразу - валидатор может ожидать ошибку)
    if (result.data?.status === 'error') {
      console.log(colorize(`   ⚠️  WORKER ERROR: ${result.data.error || result.data.message}`, 'yellow'));
      // Продолжаем выполнение - валидатор решит, является ли это ожидаемой ошибкой
    }

    // Вызываем валидатор (может вернуть true даже для ошибок, если ошибка ожидаема)
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
    const hasRetrievedContext = 'retrievedContext' in result && Array.isArray(result.retrievedContext);

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
    if (hasRetrievedContext) {
      console.log(`   > Retrieved chunks: ${result.retrievedContext.length}`);
    } else {
      console.log('   > WARNING: retrievedContext field is missing or not an array');
    }

    return hasText && hasUsage && hasRetrievedContext;
  },

  CMD_TRANSLATE: (data) => {
    if (!data.success && !data.data) return false;
    const result = data.success ? data.data : data;
    // Проверяем поле translated согласно спецификации
    const hasTranslated = result.translated && typeof result.translated === 'string' && result.translated.length > 0;
    // Проверяем наличие кириллицы
    const hasCyrillic = /[а-яё]/i.test(result.translated);
    if (hasTranslated) {
      console.log(`   > Translated: ${result.translated}`);
      if (hasCyrillic) {
        console.log(colorize('   > Contains Cyrillic ✓', 'green'));
      }
    }
    return hasTranslated && hasCyrillic;
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

  CMD_KB_LIST_FILES: (data) => {
    if (!data.success && !data.data) return false;
    const result = data.success ? data.data : data;
    const isArray = Array.isArray(result);
    if (isArray) {
      console.log(`   > Files count: ${result.length}`);
      if (result.length > 0) {
        result.forEach((file, index) => {
          console.log(`   > File ${index + 1}: ${file.name || file.id || 'unknown'}`);
          if (file.id) console.log(`     - ID: ${file.id}`);
          if (file.status) console.log(`     - Status: ${file.status}`);
          if (file.word_count) console.log(`     - Word count: ${file.word_count}`);
          if (file.created_at) console.log(`     - Created: ${file.created_at}`);
        });
      } else {
        console.log('   > No files found');
      }
    }
    return isArray;
  },

  CMD_KB_DELETE_FILE: (data) => {
    if (!data.success && !data.data) return false;
    const result = data.success ? data.data : data;
    const hasDeleted = result.deleted === true || result.deleted === 'true';
    const hasFileId = result.fileId && typeof result.fileId === 'string';
    if (hasDeleted) console.log(`   > Deleted: true`);
    if (hasFileId) console.log(`   > File ID: ${result.fileId}`);
    return hasDeleted || hasFileId;
  },

  CMD_SYS_RESYNC_CACHE: (data) => {
    if (data.status !== 'success') return false;
    const stats = data.data || {};
    const hasStats = typeof stats === 'object' && Object.keys(stats).length > 0;
    if (hasStats) {
      console.log(`   > Stats: ${JSON.stringify(stats)}`);
    }
    return hasStats;
  },

  CMD_CLEANUP_ORG: (data) => {
    if (data.status !== 'success') return false;
    const hasOrgId = data.data?.orgId && typeof data.data.orgId === 'string';
    const hasDeleted = data.data?.deleted && typeof data.data.deleted === 'object';
    if (hasOrgId) console.log(`   > Org ID: ${data.data.orgId}`);
    if (hasDeleted) {
      console.log(`   > Deleted adminKbId: ${data.data.deleted.adminKbId || 'none'}`);
      console.log(`   > Deleted historyKbId: ${data.data.deleted.historyKbId || 'none'}`);
    }
    return hasOrgId && hasDeleted;
  },

  /**
   * Универсальный валидатор для неизвестных команд
   * Работает для любой неизвестной команды (CMD_UNKNOWN_COMMAND, CMD_РРРРРРР и т.д.)
   * Проверяет, что Router Worker корректно обработал неизвестную команду и отправил ошибку
   */
  CMD_UNKNOWN_COMMAND: (data) => {
    // Для неизвестной команды ожидаем ошибку
    if (data.status !== 'error') {
      console.log(`   > Expected status 'error', got '${data.status}'`);
      return false;
    }
    const hasErrorCode = data.errorCode && typeof data.errorCode === 'string';
    const hasMessage = data.message && typeof data.message === 'string';
    const isUnknownCommandError = data.errorCode === 'UNKNOWN_COMMAND';
    const messageContainsUnknown = data.message && data.message.toLowerCase().includes('unknown');

    if (hasErrorCode) console.log(`   > Error Code: ${data.errorCode}`);
    if (hasMessage) {
      console.log(`   > Error Message: ${data.message}`);
      if (messageContainsUnknown) {
        console.log(colorize('   > Contains "unknown" in message ✓', 'green'));
      }
    }

    // Проверяем новый errorCode UNKNOWN_COMMAND
    if (isUnknownCommandError) {
      console.log(colorize('   > Error code is UNKNOWN_COMMAND ✓', 'green'));
    }

    return hasErrorCode && hasMessage && (isUnknownCommandError || messageContainsUnknown);
  },
};

/**
 * Универсальная функция для создания валидатора неизвестной команды
 * Можно использовать для любой неизвестной команды (CMD_UNKNOWN_COMMAND, CMD_РРРРРРР и т.д.)
 * Валидатор проверяет структуру данных (статус ошибки, наличие errorCode и message),
 * а не имя команды, поэтому работает для любой неизвестной команды
 * @returns {Function} Валидатор функции
 */
function createUnknownCommandValidator() {
  return (data) => {
    // Используем тот же валидатор, что и для CMD_UNKNOWN_COMMAND
    // Он проверяет структуру данных, а не имя команды
    return validators.CMD_UNKNOWN_COMMAND(data);
  };
}

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
  // Проверяем аргументы командной строки
  const args = process.argv.slice(2);

  if (args.includes('--debug-rag')) {
    console.log(colorize('🔍 Запуск отладочного теста RAG...', 'bright'));
    await debugRAGTest();
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(colorize('\n📋 Smoke Test Help\n', 'bright'));
    console.log('Использование: node scripts/smoke-test.js [опции]');
    console.log('');
    console.log('Опции:');
    console.log('  --debug-rag    Запустить только отладочный тест RAG');
    console.log('  --help, -h     Показать эту справку');
    console.log('');
    console.log('По умолчанию запускается полный набор smoke-тестов');
    return;
  }

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
  let uploadedFileId = null; // Для хранения fileId из CMD_KB_ADD_FILE

  try {
    // TEST 1: CMD_ANALYZE_NEW_TICKET
    const test1 = await runTest(
      'TEST 1/12: Analyzing Ticket',
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

    // TEST 2: CMD_TRANSLATE
    const test2 = await runTest(
      'TEST 2/12: Translation',
      'CMD_TRANSLATE',
      {
        text: 'Welcome to the system',
        targetLang: 'ru',
        meta: {},
      },
      validators.CMD_TRANSLATE,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_TRANSLATE', passed: test2 });
    await sleep(2000);

    // TEST 3: CMD_KB_ADD_FILE (первый файл - Open WebUI README)
    // Загружаем файлы ПЕРЕД генерацией ответа, чтобы использовать их как базу знаний
    const test3 = await runTest(
      'TEST 3/12: File Upload (Open WebUI README)',
      'CMD_KB_ADD_FILE',
      {
        orgId: 'test-org-smoke',
        fileUrl: 'https://raw.githubusercontent.com/open-webui/open-webui/main/README.md',
        fileName: 'open-webui-readme.md',
        meta: {},
      },
      (data) => {
        const result = validators.CMD_KB_ADD_FILE(data);
        // Сохраняем fileId для последующего удаления
        if (result && data.data?.fileId) {
          uploadedFileId = data.data.fileId;
        }
        return result;
      },
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_KB_ADD_FILE (first)', passed: test3 });
    await sleep(2000);

    // TEST 4: CMD_KB_ADD_FILE (второй файл - Alpaca WebUI README)
    const test4 = await runTest(
      'TEST 4/12: File Upload (Alpaca WebUI README)',
      'CMD_KB_ADD_FILE',
      {
        orgId: 'test-org-smoke',
        fileUrl: 'https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md',
        fileName: 'alpaca-webui-readme.md',
        meta: {},
      },
      validators.CMD_KB_ADD_FILE,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_KB_ADD_FILE (second)', passed: test4 });
    // Даем время на индексацию файлов перед использованием в RAG
    await sleep(5000);
    
    // Синхронизируем кэш, чтобы база знаний была доступна для CMD_GEN_RESPONSE
    console.log(colorize('⏳ Syncing cache to ensure knowledge base is available...', 'yellow'));
    const cacheSync = await runTest(
      'CACHE SYNC: Syncing cache before RAG',
      'CMD_SYS_RESYNC_CACHE',
      {
        meta: {},
      },
      validators.CMD_SYS_RESYNC_CACHE,
      10000,
      entryQueue
    );
    if (!cacheSync) {
      console.log(colorize('⚠️  Cache sync failed, but continuing...', 'yellow'));
    }
    await sleep(2000);

    // TEST 5: CMD_GEN_RESPONSE - вопрос о сравнении WebUI проектов по генерации изображений
    // Теперь файлы загружены и проиндексированы, можно использовать их как базу знаний
    const test5 = await runTest(
      'TEST 5/12: Generating Response (RAG with uploaded files - WebUI comparison)',
      'CMD_GEN_RESPONSE',
      {
        orgId: 'test-org-smoke',
        query: 'Hello! I am trying to decide between installing Alpaca WebUI and Open WebUI, and image generation is very important to me. I noticed that Open WebUI explicitly mentions support for local generation tools like ComfyUI and AUTOMATIC1111. Could you please clarify if Alpaca WebUI also supports these local image engines? Please tell me exactly which models or providers are currently supported for image generation in both Alpaca WebUI and Open WebUI, so I can compare them.',
        // История в markdown-строке с указанием ролей
        history:
          'User: I want to compare different WebUI projects\n' +
          'Assistant: I can help you compare different AI WebUI projects. What aspects are most important to you?\n' +
          'User: I need information about image generation capabilities',
        lang: 'uk',
        meta: {},
      },
      validators.CMD_GEN_RESPONSE,
      30000, // Увеличенный таймаут для генерации ответа с RAG
      entryQueue
    );
    testResults.push({ name: 'CMD_GEN_RESPONSE', passed: test5 });
    await sleep(2000);

    // TEST 6: CMD_ARCHIVE_TICKET
    const test6 = await runTest(
      'TEST 6/12: Archiving Ticket',
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
    testResults.push({ name: 'CMD_ARCHIVE_TICKET', passed: test6 });
    await sleep(2000);

    // TEST 7: CMD_KB_LIST_FILES
    const test7 = await runTest(
      'TEST 7/12: List Files',
      'CMD_KB_LIST_FILES',
      {
        orgId: 'test-org-smoke',
        meta: {},
      },
      validators.CMD_KB_LIST_FILES,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_KB_LIST_FILES', passed: test7 });
    await sleep(2000);

    // TEST 8: CMD_KB_DELETE_FILE
    // Удаляем файл, загруженный в TEST 3
    if (!uploadedFileId) {
      console.log(colorize('⚠️  Skipping CMD_KB_DELETE_FILE: no fileId from previous upload', 'yellow'));
      testResults.push({ name: 'CMD_KB_DELETE_FILE', passed: false });
    } else {
      const test8 = await runTest(
        'TEST 8/12: Delete File',
        'CMD_KB_DELETE_FILE',
        {
          orgId: 'test-org-smoke',
          fileId: uploadedFileId,
          meta: {},
        },
        validators.CMD_KB_DELETE_FILE,
        10000,
        entryQueue
      );
      testResults.push({ name: 'CMD_KB_DELETE_FILE', passed: test8 });
    }
    await sleep(2000);

    // TEST 9: CMD_SYS_RESYNC_CACHE
    const test9 = await runTest(
      'TEST 9/12: Sync Cache',
      'CMD_SYS_RESYNC_CACHE',
      {
        meta: {},
      },
      validators.CMD_SYS_RESYNC_CACHE,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_SYS_RESYNC_CACHE', passed: test9 });
    await sleep(2000);

    // TEST 10: CMD_UNKNOWN_COMMAND (неизвестная команда)
    // Тест проверяет, что Safe Processor Wrapper корректно обрабатывает неизвестные типы задач
    const test10 = await runTest(
      'TEST 10/12: Unknown Command (Error Handling)',
      'CMD_UNKNOWN_COMMAND',
      {
        orgId: 'test-org-smoke',
        someData: 'test data',
        meta: {},
      },
      validators.CMD_UNKNOWN_COMMAND,
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_UNKNOWN_COMMAND', passed: test10 });
    await sleep(2000);

    // TEST 10.5: CMD_РРРРРРР (неизвестная команда с кириллицей)
    // Демонстрирует, что валидатор работает для любой неизвестной команды
    const test10_5 = await runTest(
      'TEST 10.5/12: Unknown Command with Cyrillic (CMD_РРРРРРР)',
      'CMD_РРРРРРР',
      {
        orgId: 'test-org-smoke',
        someData: 'test data',
        meta: {},
      },
      createUnknownCommandValidator(),
      10000,
      entryQueue
    );
    testResults.push({ name: 'CMD_РРРРРРР', passed: test10_5 });
    await sleep(2000);

    // TEST 11: CMD_CLEANUP_ORG
    // ВНИМАНИЕ: Этот тест удаляет данные организации, поэтому он последний
    const test11 = await runTest(
      'TEST 11/12: Cleanup Org',
      'CMD_CLEANUP_ORG',
      {
        orgId: 'test-org-smoke',
        meta: {},
      },
      validators.CMD_CLEANUP_ORG,
      15000, // Увеличенный таймаут для удаления датасетов
      entryQueue
    );
    testResults.push({ name: 'CMD_CLEANUP_ORG', passed: test11 });
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

