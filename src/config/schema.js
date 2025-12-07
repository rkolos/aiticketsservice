const Joi = require('joi');

const schema = Joi.object({
  // Server/App
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  HEALTHCHECK_PORT: Joi.number().default(3000),

  // Redis
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),

  // Dify API
  DIFY_API_URL: Joi.string().uri().required(),
  DIFY_KEY_ADMIN: Joi.string().required(),
  DIFY_KEY_CLASSIFIER: Joi.string().required(),
  DIFY_KEY_SUMMARIZER: Joi.string().required(),
  DIFY_KEY_RESPONSE_WORKFLOW: Joi.string().required(),

  // Workers (BullMQ)
  WORKER_FAST_LANE_CONCURRENCY: Joi.number().default(15),
  WORKER_SLOW_LANE_CONCURRENCY: Joi.number().default(2),

  // File Service
  FILE_SERVICE_CONNECTION_TIMEOUT: Joi.number().default(30000), // 30 секунд
  FILE_SERVICE_IDLE_TIMEOUT: Joi.number().default(60000), // 60 секунд
}).unknown(true); // Разрешаем неизвестные поля для системных переменных Docker

module.exports = schema;
