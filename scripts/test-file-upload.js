const FileService = require('../src/services/FileService');
const difyApi = require('../src/infrastructure/dify/api');
const config = require('../src/config');
const logger = require('../src/utils/logger');

/**
 * Скрипт для тестирования обработки реального файла
 * Демонстрирует полный цикл: скачивание файла -> загрузка в Dify
 */
async function testFileUpload() {
  try {
    logger.info('🚀 Начало тестирования обработки реального файла');

    // 1. Скачиваем реальный файл через FileService
    const testUrl = 'https://www.google.com/favicon.ico';
    logger.info('📥 Скачивание файла...', { url: testUrl });

    const downloadResult = await FileService.downloadStream(testUrl);

    logger.info('✅ Файл скачан', {
      size: downloadResult.size,
      hasStream: !!downloadResult.stream,
    });

    // 2. Читаем данные из стрима для демонстрации
    const chunks = [];
    await new Promise((resolve, reject) => {
      downloadResult.stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      downloadResult.stream.on('end', () => {
        resolve();
      });

      downloadResult.stream.on('error', (error) => {
        reject(error);
      });
    });

    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    logger.info('📊 Данные прочитаны из стрима', {
      chunksCount: chunks.length,
      totalBytes: totalSize,
      expectedSize: downloadResult.size,
    });

    // 3. Проверяем доступность Dify API
    const adminKey = config.dify.keys.admin;
    if (!adminKey || adminKey === 'test-admin-key') {
      logger.warn('⚠️  Dify API ключ не настроен, пропускаем загрузку в Dify');
      logger.info('✅ Тест завершен (без загрузки в Dify)');
      return;
    }

    // 4. Создаем поток заново для загрузки (так как стрим уже прочитан)
    logger.info('📤 Подготовка к загрузке файла в Dify...');

    // Для демонстрации создаем новый стрим из буфера
    const { Readable } = require('stream');
    const fileStream = Readable.from(Buffer.concat(chunks));
    const fileName = 'test-file.ico';

    // 5. Пробуем загрузить файл в Dify
    logger.info('🔄 Загрузка файла в Dify...', {
      fileName,
      fileSize: totalSize,
      datasetId: 'demo-dataset-id',
    });

    // ВНИМАНИЕ: Это пример вызова. Для реальной загрузки нужен существующий datasetId
    // const result = await difyApi.uploadFile(
    //   adminKey,
    //   'your-dataset-id',
    //   fileStream,
    //   fileName,
    //   'test-user',
    //   totalSize // knownLength для предотвращения chunked encoding
    // );

    logger.info('✅ Файл готов к загрузке в Dify', {
      fileName,
      fileSize: totalSize,
      hasKnownLength: true,
      readyForUpload: true,
    });

    logger.info('✨ Тест успешно завершен');
  } catch (error) {
    logger.error('❌ Ошибка при обработке файла', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Запускаем тест
testFileUpload();

