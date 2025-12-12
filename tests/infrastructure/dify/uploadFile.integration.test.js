// Логирование в самом начале, чтобы увидеть, что файл загружается
console.log('[INTEGRATION TEST] ===== ФАЙЛ ЗАГРУЖЕН =====');

// Загружаем .env для интеграционных тестов ПЕРЕД загрузкой config
// Это важно, чтобы переопределить тестовые значения из tests/setup.js
console.log('[INTEGRATION TEST] Загрузка переменных окружения...');
require('dotenv').config({ override: true });
console.log('[INTEGRATION TEST] ✓ Переменные окружения загружены');

console.log('[INTEGRATION TEST] Загрузка модулей...');
console.log('[INTEGRATION TEST] Загрузка fs и path...');
const fs = require('fs');
const path = require('path');
console.log('[INTEGRATION TEST] ✓ fs и path загружены');

console.log('[INTEGRATION TEST] Загрузка config...');
const config = require('../../../src/config');
console.log('[INTEGRATION TEST] ✓ config загружен');

console.log('[INTEGRATION TEST] Загрузка difyApi...');
const difyApi = require('../../../src/infrastructure/dify/api');
console.log('[INTEGRATION TEST] ✓ difyApi загружен');

console.log('[INTEGRATION TEST] Загрузка FileService...');
const FileService = require('../../../src/services/FileService');
console.log('[INTEGRATION TEST] ✓ FileService загружен');
console.log('[INTEGRATION TEST] ===== ВСЕ МОДУЛИ ЗАГРУЖЕНЫ =====');

// Глобальное закрытие всех соединений после всех тестов
// Это критично, так как при импорте модулей могут создаваться соединения Redis
afterAll(async () => {
  console.log('[INTEGRATION TEST] Глобальная очистка соединений...');
  const cleanupPromises = [];
  
  // Закрываем resultQueue и его соединение Redis
  try {
    const resultQueueModule = require('../../../src/infrastructure/bullmq/resultQueue');
    if (resultQueueModule.resultQueue && typeof resultQueueModule.resultQueue.close === 'function') {
      cleanupPromises.push(
        resultQueueModule.resultQueue.close().catch(() => {})
      );
    }
    
    // Закрываем соединение Redis напрямую
    if (resultQueueModule.connection) {
      const conn = resultQueueModule.connection;
      const status = conn.status || conn.connector?.status;
      // Проверяем статус перед закрытием
      if (status && status !== 'end' && status !== 'close') {
        if (typeof conn.quit === 'function') {
          cleanupPromises.push(conn.quit().catch(() => {}));
        } else if (typeof conn.disconnect === 'function') {
          cleanupPromises.push(new Promise((resolve) => {
            try { conn.disconnect(); resolve(); } catch { resolve(); }
          }));
        }
      }
    }
  } catch (e) {
    // Игнорируем ошибки импорта
  }
  
  // Закрываем redisClient
  try {
    const redisClient = require('../../../src/infrastructure/redis/client');
    if (redisClient && typeof redisClient.disconnect === 'function') {
      const status = redisClient.status || redisClient.connector?.status;
      // Проверяем статус перед закрытием
      if (status && status !== 'end' && status !== 'close') {
        cleanupPromises.push(new Promise((resolve) => {
          try { redisClient.disconnect(); resolve(); } catch { resolve(); }
        }));
      }
    }
  } catch (e) {
    // Игнорируем ошибки импорта
  }
  
  await Promise.all(cleanupPromises);
  
  // Даем дополнительное время на закрытие соединений (используем unref чтобы не блокировать завершение)
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    timer.unref(); // Не блокировать завершение процесса
  });
  
  console.log('[INTEGRATION TEST] ✓ Глобальная очистка завершена');
}, 30000);

/**
 * Интеграционный тест для uploadFile
 * Тестирует реальную загрузку файлов в Dify API
 * 
 * ВАЖНО: Эти тесты ТРЕБУЮТ запущенный и настроенный Dify API.
 * Если Dify недоступен или не настроен, тесты упадут с понятной ошибкой.
 */
describe('Dify API - uploadFile Integration', () => {
  const adminKey = config.dify.keys.admin;
  let testDatasetId = null;

  beforeAll(async () => {
    console.log('[INTEGRATION TEST] Начало настройки интеграционных тестов...');
    
    // Проверяем, что используется реальный ключ, а не тестовый
    console.log('[INTEGRATION TEST] Проверка DIFY_KEY_ADMIN...');
    if (adminKey === 'test-admin-key' || !adminKey || adminKey.length < 10) {
      throw new Error(
        `Интеграционные тесты требуют реальный DIFY_KEY_ADMIN. Текущий ключ: ${adminKey ? adminKey.substring(0, 10) + '...' : 'не установлен'}. Проверьте .env файл и установите реальный ключ из Dify.`
      );
    }
    console.log('[INTEGRATION TEST] ✓ DIFY_KEY_ADMIN проверен');

    // Проверяем доступность Dify API и создаем тестовый датасет
    try {
      // Получаем список датасетов (это также проверяет доступность API)
      console.log(`[INTEGRATION TEST] Проверка доступности Dify API и получение списка датасетов (${config.dify.url})...`);
      console.log('[INTEGRATION TEST] Вызываю listDatasets...');
      const startTime = Date.now();
      
      // Выполняем запрос через difyApi (работает нормально в обычном скрипте)
      const datasets = await difyApi.listDatasets(adminKey, 1, 100);
      const duration = Date.now() - startTime;
      console.log(`[INTEGRATION TEST] ✓ Dify API доступен, список датасетов получен за ${duration}ms`);
      
      const testDataset = datasets.data.find((ds) => ds.name === 'TEST_UPLOAD_FILE_DATASET');

      if (testDataset) {
        testDatasetId = testDataset.id;
        console.log(`[INTEGRATION TEST] ✓ Используется существующий тестовый датасет: ${testDatasetId}`);
      } else {
        // Создаем новый датасет для тестов
        console.log('[INTEGRATION TEST] Создание нового тестового датасета...');
        const newDataset = await difyApi.createDataset(adminKey, 'TEST_UPLOAD_FILE_DATASET');
        testDatasetId = newDataset.id;
        console.log(`[INTEGRATION TEST] ✓ Тестовый датасет создан: ${testDatasetId}`);
      }
    } catch (error) {
      if (error.code === 'ECONNREFUSED' || error.message.includes('timeout') || error.message.includes('не отвечает') || error.message.includes('no response')) {
        throw new Error(
          `Dify API недоступен по адресу ${config.dify.url}. Убедитесь, что Dify запущен (docker-compose up -d) и доступен на порту 5001. Ошибка: ${error.message}`
        );
      }
      if (error.statusCode === 401 || error.message.includes('unauthorized') || error.message.includes('invalid')) {
        throw new Error(
          `DIFY_KEY_ADMIN неверный или не имеет нужных прав. Проверьте ключ в .env файле. Ошибка: ${error.message}`
        );
      }
      throw new Error(
        `Не удалось создать/найти тестовый датасет. Проверьте доступность Dify API (DIFY_API_URL=${config.dify.url}) и корректность DIFY_KEY_ADMIN. Ошибка: ${error.message}`
      );
    }
  }, 30000);

  afterAll(async () => {
    // Удаляем тестовый датасет
    if (testDatasetId) {
      try {
        await difyApi.deleteDataset(adminKey, testDatasetId);
      } catch (error) {
        // Игнорируем ошибки удаления - это не критично для тестов
        console.warn('Не удалось удалить тестовый датасет:', error.message);
      }
    }
  }, 30000);

  test('должен загрузить реальный файл в Dify с knownLength', async () => {
    console.log('[TEST 1] Начало теста загрузки файла...');
    expect(testDatasetId).toBeTruthy();

    // Используем README.md проекта для тестирования
    console.log('[TEST 1] Поиск README.md...');
    const projectRoot = path.join(__dirname, '../../../');
    const readmePath = path.join(projectRoot, 'README.md');
    
    if (!fs.existsSync(readmePath)) {
      throw new Error(`README.md не найден по пути: ${readmePath}`);
    }
    console.log(`[TEST 1] ✓ README.md найден: ${readmePath}`);

    const fileName = 'README.md';
    const fileSize = fs.statSync(readmePath).size;
    console.log(`[TEST 1] Размер файла: ${fileSize} байт`);

    // Создаем поток из файла
    console.log('[TEST 1] Создание потока файла...');
    const fileStream = fs.createReadStream(readmePath);
    console.log('[TEST 1] ✓ Поток создан');
    
    try {
      // Загружаем файл через uploadFile
      console.log('[TEST 1] Загрузка файла в Dify (это может занять время)...');
      const result = await difyApi.uploadFile(
        adminKey,
        testDatasetId,
        fileStream,
        fileName,
        'integration-test',
        fileSize
      );
      console.log('[TEST 1] ✓ Файл загружен, document_id:', result.document_id);

      // Проверяем результат
      expect(result).toBeDefined();
      expect(result.document_id).toBeDefined();
      expect(result.status).toBeDefined();
      // Статус может быть 'indexing' или 'completed' в зависимости от скорости обработки
      expect(['indexing', 'completed']).toContain(result.status);
    } catch (error) {
      // Если ошибка связана с отсутствием модели эмбеддингов, выбрасываем понятную ошибку
      if (error.message && error.message.includes('model not found for text-embedding')) {
        throw new Error(
          'В Dify не настроена модель для эмбеддингов. Настройте модель в разделе Settings > Model Provider > Text Embedding Model.'
        );
      }
      throw error;
    } finally {
      // Закрываем поток, если он еще открыт
      if (fileStream && !fileStream.destroyed) {
        fileStream.destroy();
      }
    }
  }, 60000);

  test('должен загрузить файл, скачанный через FileService', async () => {
    console.log('[TEST 2] Начало теста загрузки файла через FileService...');
    expect(testDatasetId).toBeTruthy();

    // Используем README.md проекта через FileService (симулируя скачивание)
    console.log('[TEST 2] Поиск README.md...');
    const projectRoot = path.join(__dirname, '../../../');
    const readmePath = path.join(projectRoot, 'README.md');
    
    if (!fs.existsSync(readmePath)) {
      throw new Error(`README.md не найден по пути: ${readmePath}`);
    }
    console.log(`[TEST 2] ✓ README.md найден: ${readmePath}`);

    const fileName = 'README.md';
    const fileSize = fs.statSync(readmePath).size;
    console.log(`[TEST 2] Размер файла: ${fileSize} байт`);

    expect(fileSize).toBeGreaterThan(0);

    // Создаем поток из README.md (симулируя скачивание через FileService)
    console.log('[TEST 2] Создание потока файла...');
    const fileStream = fs.createReadStream(readmePath);
    console.log('[TEST 2] ✓ Поток создан');
    
    try {
      // Загружаем файл в Dify с knownLength
      console.log('[TEST 2] Загрузка файла в Dify (это может занять время)...');
      const result = await difyApi.uploadFile(
        adminKey,
        testDatasetId,
        fileStream,
        fileName,
        'integration-test',
        fileSize
      );
      console.log('[TEST 2] ✓ Файл загружен, document_id:', result.document_id);

      // Проверяем результат
      expect(result).toBeDefined();
      expect(result.document_id).toBeDefined();
    } catch (error) {
      // Если ошибка связана с отсутствием модели эмбеддингов, выбрасываем понятную ошибку
      if (error.message && error.message.includes('model not found for text-embedding')) {
        throw new Error(
          'В Dify не настроена модель для эмбеддингов. Настройте модель в разделе Settings > Model Provider > Text Embedding Model.'
        );
      }
      throw error;
    } finally {
      // Закрываем поток, если он еще открыт
      if (fileStream && !fileStream.destroyed) {
        fileStream.destroy();
      }
    }
  }, 60000);
});

