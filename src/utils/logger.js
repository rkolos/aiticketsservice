const winston = require('winston');
const config = require('../config');

const format =
  config.env === 'production'
    ? winston.format.json()
    : winston.format.combine(winston.format.colorize(), winston.format.simple());

/**
 * Логгер приложения на основе Winston
 * Используется во всех модулях проекта через require('./utils/logger') или require('../utils/logger')
 */
const logger = winston.createLogger({
  level: config.logLevel,
  format: format,
  transports: [new winston.transports.Console()],
});

module.exports = logger;
