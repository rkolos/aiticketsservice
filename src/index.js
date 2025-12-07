const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');
const redisClient = require('./infrastructure/redis/client');
const difyApi = require('./infrastructure/dify/api');

// Функция для маскирования секретов в конфиге при логировании
function maskSecrets(configObj) {
  const masked = JSON.parse(JSON.stringify(configObj));
  if (masked.redis?.password) {
    masked.redis.password = '***';
  }
  if (masked.dify?.keys) {
    Object.keys(masked.dify.keys).forEach((key) => {
      if (masked.dify.keys[key]) {
        masked.dify.keys[key] = '***';
      }
    });
  }
  return masked;
}

// Обработчики глобальных ошибок
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Инициализация Redis подключения
async function initRedis() {
  return new Promise((resolve, reject) => {
    // Проверяем, готов ли Redis
    if (redisClient.status === 'ready') {
      resolve();
      return;
    }

    // Ждем события ready
    redisClient.once('ready', () => {
      resolve();
    });

    redisClient.once('error', (error) => {
      reject(error);
    });

    // Также делаем ping для проверки соединения
    redisClient
      .ping()
      .then(() => {
        if (redisClient.status === 'ready') {
          resolve();
        }
      })
      .catch(reject);
  });
}

// Тестовый запрос к Dify API
async function testDifyConnection() {
  try {
    logger.info('Testing Dify API connection...');
    const adminKey = config.dify.keys.admin;

    if (!adminKey) {
      logger.warn('Dify admin key not configured, skipping API test');
      return;
    }

    // Тестовый запрос: получить список датасетов
    const result = await difyApi.listDatasets(adminKey, 1, 10);
    logger.info('Dify API connection test successful', {
      datasetsCount: result.data?.length || 0,
      total: result.total || 0,
    });
  } catch (error) {
    // Не блокируем запуск приложения, если Dify недоступен
    logger.warn('Dify API connection test failed (this is OK if Dify is not running)', {
      error: error.message,
      statusCode: error.statusCode || null,
    });
  }
}

// Инициализация приложения
async function startApp() {
  try {
    // Ждем подключения Redis
    await initRedis();
    logger.info('Redis connection verified');

    // Тестируем подключение к Dify API
    await testDifyConnection();

    // Простой HTTP сервер для healthcheck
    const server = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.listen(config.healthcheck.port, () => {
      logger.info('Ticket AI Worker started', {
        config: maskSecrets(config),
      });
    });
  } catch (error) {
    logger.error('Failed to start application', { error: error.message });
    process.exit(1);
  }
}

// Запускаем приложение
startApp();

