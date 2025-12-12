const FileService = require('../../src/services/FileService');

describe('FileService - Integration Tests', () => {
  test('должен скачать реальный файл из тестового URL', async () => {
    // Используем небольшой тестовый файл (например, favicon от Google)
    // Этот URL обычно доступен и возвращает небольшой файл
    const testUrl = 'https://www.google.com/favicon.ico';

    const result = await FileService.downloadStream(testUrl);

    // Проверяем, что получили стрим
    expect(result.stream).toBeDefined();
    expect(result.stream).toHaveProperty('on');

    // Проверяем, что размер определен (favicon обычно имеет content-length)
    // Может быть null, если сервер не отдает заголовок
    expect(result.size).toBeGreaterThanOrEqual(0);

    // Читаем данные из стрима для проверки
    const chunks = [];
    await new Promise((resolve, reject) => {
      result.stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      result.stream.on('end', () => {
        resolve();
      });

      result.stream.on('error', (error) => {
        reject(error);
      });
    });

    // Проверяем, что получили данные
    expect(chunks.length).toBeGreaterThan(0);

    // Проверяем, что получили какие-то данные (файл не пустой)
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalSize).toBeGreaterThan(0);

    // Примечание: размер из content-length может не совпадать с реальным размером
    // если используется сжатие (gzip) или редирект, поэтому не проверяем точное соответствие
  }, 30000); // Увеличенный таймаут для реального HTTP запроса

  test('должен обработать ошибку 404 для несуществующего файла', async () => {
    const { FileNotFoundError } = require('../../src/services/FileService');
    const nonExistentUrl = 'https://www.google.com/this-file-does-not-exist-12345.pdf';

    await expect(FileService.downloadStream(nonExistentUrl)).rejects.toThrow(FileNotFoundError);
  }, 30000);
});

// Глобальное закрытие всех соединений после всех тестов
// Для единообразия с другими интеграционными тестами
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
      const status = conn.status || conn.connector?.status;
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

