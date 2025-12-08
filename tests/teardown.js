// Глобальный cleanup для закрытия всех соединений после всех тестов
afterAll(async () => {
  const cleanupPromises = [];

  // Закрываем очереди и соединения, если они были открыты
  try {
    const resultQueueModule = require('../src/infrastructure/bullmq/resultQueue');
    if (resultQueueModule.resultQueue) {
      // Закрываем очередь (это закроет внутренние соединения BullMQ)
      cleanupPromises.push(
        resultQueueModule.resultQueue.close().catch((error) => {
          // Игнорируем ошибки закрытия
        })
      );
    }
    
    // Закрываем соединение Redis напрямую
    if (resultQueueModule.connection) {
      const conn = resultQueueModule.connection;
      if (typeof conn.quit === 'function') {
        cleanupPromises.push(
          conn.quit().catch((error) => {
            // Игнорируем ошибки закрытия
          })
        );
      } else if (typeof conn.disconnect === 'function') {
        cleanupPromises.push(
          new Promise((resolve) => {
            try {
              conn.disconnect();
              resolve();
            } catch (error) {
              resolve();
            }
          })
        );
      }
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

  // Даем дополнительное время на закрытие соединений (используем unref чтобы не блокировать завершение)
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    timer.unref(); // Не блокировать завершение процесса
  });
}, 15000);

