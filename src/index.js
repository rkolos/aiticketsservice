const http = require('http');
const config = require('./config');
const logger = require('./utils/logger');

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

