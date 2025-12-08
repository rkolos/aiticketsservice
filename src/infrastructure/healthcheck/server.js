const express = require('express');
const { Queue } = require('bullmq');
const config = require('../../config');
const logger = require('../../utils/logger');
const redisClient = require('../redis/client');
const difyApi = require('../dify/api');

/**
 * Проверка Redis соединения
 * @returns {Promise<Object>} Результат проверки
 */
async function checkRedis() {
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Redis ping timeout')), 2000);
    });

    const pingPromise = redisClient.ping();

    await Promise.race([pingPromise, timeoutPromise]);

    return {
      status: 'ok',
      message: 'Connection successful',
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.message || 'Connection failed',
      error: error.message,
    };
  }
}

/**
 * Проверка Dify API
 * @returns {Promise<Object>} Результат проверки
 */
async function checkDify() {
  try {
    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      return {
        status: 'error',
        message: 'Admin key not configured',
      };
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Dify API timeout')), 5000);
    });

    // Простой запрос к Dify API для проверки доступности
    const apiPromise = difyApi.listDatasets(adminKey, 1, 1);

    await Promise.race([apiPromise, timeoutPromise]);

    return {
      status: 'ok',
      message: 'API accessible',
    };
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

    return {
      status: 'error',
      message,
      error: error.message || 'Unknown error',
    };
  }
}

/**
 * Проверка статуса воркера BullMQ
 * @param {Worker} worker - Экземпляр воркера BullMQ
 * @param {string} workerName - Имя воркера для логирования
 * @returns {Promise<Object>} Результат проверки
 */
async function checkWorker(worker, workerName) {
  try {
    if (!worker) {
      return {
        status: 'error',
        message: 'Worker is not initialized',
      };
    }

    // Проверяем, что воркер существует и имеет соединение
    const connection = worker.opts?.connection;
    if (!connection) {
      return {
        status: 'error',
        message: 'Worker connection not found',
      };
    }

    // Проверяем статус соединения Redis воркера
    const status = connection.status || connection.connector?.status;
    if (status !== 'ready' && status !== 'connect') {
      return {
        status: 'error',
        message: 'Worker connection not ready',
        error: `Connection status: ${status}`,
      };
    }

    // Получаем имя очереди из воркера и создаем временный Queue для проверки активных задач
    let activeJobs = 0;
    try {
      const queueName = worker.name;
      if (queueName) {
        // Создаем временный Queue с тем же соединением, что использует воркер
        const queue = new Queue(queueName, {
          connection: connection,
        });

        // Получаем активные задачи с таймаутом
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Get active jobs timeout')), 2000);
        });

        const activeJobsPromise = queue.getActiveCount();
        activeJobs = await Promise.race([activeJobsPromise, timeoutPromise]);

        // Закрываем временный Queue
        await queue.close();
      }
    } catch (e) {
      // Игнорируем ошибки при получении количества задач - это не критично
      // Главное, что соединение активно
    }

    return {
      status: 'ok',
      message: 'Worker is running',
      activeJobs,
    };
  } catch (error) {
    return {
      status: 'error',
      message: 'Worker check failed',
      error: error.message || 'Unknown error',
    };
  }
}

/**
 * Создание и настройка Express сервера для healthcheck
 * @param {Object} workers - Объект с воркерами { fastLaneWorker, slowLaneWorker }
 * @returns {express.Application} Express приложение
 */
function createHealthcheckServer(workers) {
  const app = express();

  // Отключаем логирование каждого запроса к /health
  app.use((req, res, next) => {
    if (req.path === '/health') {
      // Пропускаем логирование для healthcheck запросов
      next();
    } else {
      next();
    }
  });

  app.get('/health', async (req, res) => {
    const timestamp = new Date().toISOString();
    const checks = {};

    // Выполняем проверки параллельно для ускорения
    const [redisCheck, difyCheck, fastLaneCheck, slowLaneCheck] = await Promise.all([
      checkRedis(),
      checkDify(),
      checkWorker(workers?.fastLaneWorker, 'fastLane'),
      checkWorker(workers?.slowLaneWorker, 'slowLane'),
    ]);

    checks.redis = redisCheck;
    checks.dify = difyCheck;
    checks.workers = {
      fastLane: fastLaneCheck,
      slowLane: slowLaneCheck,
    };

    // Определяем общий статус
    const allChecks = [redisCheck, difyCheck, fastLaneCheck, slowLaneCheck];
    const isHealthy = allChecks.every((check) => check.status === 'ok');

    const response = {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp,
      checks,
    };

    // Логируем результаты проверок
    if (!isHealthy) {
      logger.warn('Healthcheck: Some components are unhealthy', {
        checks: Object.keys(checks).filter((key) => {
          const check = checks[key];
          if (check.status) {
            return check.status !== 'ok';
          }
          if (check.fastLane) {
            return check.fastLane.status !== 'ok' || check.slowLane.status !== 'ok';
          }
          return false;
        }),
      });
    } else {
      // Логируем успешные проверки на уровне info согласно требованиям
      logger.info('Healthcheck: All components are healthy', {
        redis: redisCheck.status,
        dify: difyCheck.status,
        fastLane: fastLaneCheck.status,
        slowLane: slowLaneCheck.status,
      });
    }

    // Возвращаем соответствующий HTTP статус
    const httpStatus = isHealthy ? 200 : 503;
    res.status(httpStatus).json(response);
  });

  // Обработка 404 для всех остальных путей
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  return app;
}

/**
 * Запуск healthcheck сервера
 * @param {Object} workers - Объект с воркерами { fastLaneWorker, slowLaneWorker }
 * @returns {Promise<http.Server>} HTTP сервер
 */
async function startHealthcheckServer(workers) {
  const app = createHealthcheckServer(workers);
  const port = config.healthcheck.port;

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info('Healthcheck server started', { port });
      resolve(server);
    });

    server.on('error', (error) => {
      logger.error('Healthcheck server error', { error: error.message });
      reject(error);
    });
  });
}

module.exports = {
  createHealthcheckServer,
  startHealthcheckServer,
};

