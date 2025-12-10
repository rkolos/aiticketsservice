/* eslint-disable no-console */
/**
 * Простой тест загрузки файла и RAG поиска
 */

require('dotenv').config({ override: true });

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { QUEUES } = require('./src/core/constants');
const config = require('./src/config');

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function simpleRAGTest() {
  console.log(colorize('\n🔍 ПРОСТОЙ RAG ТЕСТ\n', 'bright'));

  // Создаем соединение Redis
  const redisConnection = new Redis({
    host: 'localhost',
    port: 6379,
    password: 'difyai123456',
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  });

  // Создаем очереди
  const entryQueue = new Queue(QUEUES.ENTRY, { connection: redisConnection });
  const resultsQueue = new Queue(QUEUES.RESULTS, { connection: redisConnection });

  // Создаем воркер для результатов
  const resultsWorker = new Worker(
    QUEUES.RESULTS,
    async (job) => {
      const resultData = job.data || {};
      const traceId = resultData.meta?.traceId;

      if (traceId && pendingResults.has(traceId)) {
        const { resolve } = pendingResults.get(traceId);
        pendingResults.delete(traceId);
        const { meta, ...data } = resultData;
        resolve({ data, meta });
      }
    },
    { connection: redisConnection, concurrency: 5 }
  );

  const pendingResults = new Map();

  try {
    // Функция для выполнения теста
    async function runTest(jobName, data, timeout = 30000) {
      const traceId = `simple-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const jobData = { ...data, meta: { traceId, ...(data.meta || {}) } };

      console.log(colorize(`📤 SENT: ${jobName}`, 'bright'));

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
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
        });

        entryQueue.add(jobName, jobData).catch(reject);
      });
    }

    const orgId = 'simple-test-org';

    console.log('1️⃣ Загружаем файл в базу знаний...');
    const uploadResult = await runTest('CMD_KB_ADD_FILE', {
      orgId,
      fileUrl: 'https://raw.githubusercontent.com/open-webui/open-webui/main/README.md',
      fileName: 'open-webui-readme.md',
      meta: {},
    }, 60000);

    console.log(colorize(`✅ Файл загружен: ${uploadResult.data?.fileId}`, 'green'));

    console.log('2️⃣ Ждем индексации (30 сек)...');
    await sleep(30000);

    console.log('3️⃣ Синхронизируем кэш...');
    await runTest('CMD_SYS_RESYNC_CACHE', { meta: {} }, 10000);

    console.log('4️⃣ Проверяем список файлов...');
    const listResult = await runTest('CMD_KB_LIST_FILES', { orgId, meta: {} }, 10000);

    console.log(`📁 Найдено файлов: ${listResult.data?.length || 0}`);
    if (listResult.data && listResult.data.length > 0) {
      listResult.data.forEach(file => {
        console.log(`   - ${file.name} (${file.word_count} слов, статус: ${file.status})`);
      });
    }

    console.log('5️⃣ Выполняем поиск по "Open WebUI"...');
    const searchResult = await runTest('CMD_GEN_RESPONSE', {
      orgId,
      query: 'What is Open WebUI?',
      history: 'User: Tell me about AI tools',
      lang: 'en',
      meta: {},
    }, 30000);

    console.log('\n📊 РЕЗУЛЬТАТЫ ПОИСКА:');
    const actualData = searchResult.data?.data || searchResult.data;
    console.log(`Ответ: ${actualData?.text?.substring(0, 200)}...`);
    console.log(`Контекст найден: ${actualData?.context !== 'Контекст не найден' ? '✅ ДА' : '❌ НЕТ'}`);
    console.log(`Retrieved chunks: ${actualData?.retrievedContext?.length || 0}`);

    // Показываем полную структуру ответа
    console.log('\n🔍 ПОЛНАЯ СТРУКТУРА ОТВЕТА:');
    console.log(JSON.stringify(searchResult, null, 2));

    // Показываем только retrievedContext
    console.log('\n🔍 ПОЛНАЯ СТРУКТУРА retrievedContext:');
    console.log(JSON.stringify(actualData?.retrievedContext, null, 2));

    // Показываем контекст
    console.log('\n📝 КОНТЕКСТ:');
    console.log(actualData?.context?.substring(0, 500) + '...');

    if (actualData?.retrievedContext?.length > 0) {
      console.log('\n🎯 НАЙДЕННЫЕ ЧАНКИ:');
      actualData.retrievedContext.forEach((chunk, i) => {
        console.log(`${i + 1}. Score: ${chunk.score}`);
        console.log(`   Content: ${chunk.content?.substring(0, 100)}...`);
        console.log(`   Segment: ${JSON.stringify(chunk.segment, null, 2)}`);
      });
    }

    console.log('\n🧹 Очищаем тестовые данные...');
    await runTest('CMD_CLEANUP_ORG', { orgId, meta: {} }, 30000);

    console.log(colorize('\n✅ ПРОСТОЙ RAG ТЕСТ ЗАВЕРШЕН', 'green'));

  } catch (error) {
    console.error(colorize(`❌ Ошибка: ${error.message}`, 'red'));
  } finally {
    await resultsWorker.close();
    await entryQueue.close();
    await resultsQueue.close();
    await redisConnection.quit();
  }
}

// Запуск
if (require.main === module) {
  simpleRAGTest().catch(console.error);
}

module.exports = { simpleRAGTest };
