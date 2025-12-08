// Глобальный cleanup для закрытия всех соединений после всех тестов
afterAll(async () => {
  // Даем время на завершение асинхронных операций
  await new Promise((resolve) => setTimeout(resolve, 100));

  const cleanupPromises = [];

  // Закрываем очереди и соединения, если они были открыты
  try {
    const { resultQueue } = require('../src/infrastructure/bullmq/resultQueue');
    if (resultQueue) {
      cleanupPromises.push(
        resultQueue.close().catch((error) => {
          // Игнорируем ошибки закрытия
        })
      );
    }
  } catch (error) {
    // Игнорируем ошибки импорта (модуль может быть не загружен или замокан)
  }

  try {
    const redisClient = require('../src/infrastructure/redis/client');
    if (redisClient && typeof redisClient.disconnect === 'function') {
      const status = redisClient.status || redisClient.connector?.status;
      if (status && status !== 'end' && status !== 'close') {
        cleanupPromises.push(
          new Promise((resolve) => {
            try {
              redisClient.disconnect();
              resolve();
            } catch (error) {
              // Игнорируем ошибки закрытия
              resolve();
            }
          })
        );
      }
    }
  } catch (error) {
    // Игнорируем ошибки импорта (модуль может быть не загружен или замокан)
  }

  // Ждем завершения всех операций cleanup
  await Promise.all(cleanupPromises);

  // Даем дополнительное время на закрытие соединений
  await new Promise((resolve) => setTimeout(resolve, 200));
}, 15000);

