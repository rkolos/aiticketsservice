const winston = require('winston');
const config = require('../config');

// Определяем формат в зависимости от окружения
const format =
  config.env === 'production'
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      );

// Создаем логгер
const logger = winston.createLogger({
  level: config.logLevel,
  format: format,
  transports: [new winston.transports.Console()],
});

module.exports = logger;

