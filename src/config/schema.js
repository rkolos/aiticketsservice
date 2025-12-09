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
  DIFY_LIST_DATASETS_PAGE_LIMIT: Joi.number().default(50),

  // Workers (BullMQ)
  WORKER_FAST_LANE_CONCURRENCY: Joi.number().default(15),
  WORKER_SLOW_LANE_CONCURRENCY: Joi.number().default(2),

  // File Service
  // Эти переменные преобразуются в секцию config.fileService.*
  FILE_SERVICE_CONNECTION_TIMEOUT: Joi.number().default(30000), // 30 секунд
  FILE_SERVICE_IDLE_TIMEOUT: Joi.number().default(60000), // 60 секунд

  // Dify Workflow Limits
  DIFY_WORKFLOW_MAX_INPUT_VARIABLE_SIZE: Joi.number().default(49152), // 48KB в байтах (по умолчанию)
  DIFY_WORKFLOW_MAX_REQUEST_BODY_SIZE: Joi.number().default(10485760), // 10MB в байтах

  // Model Configuration
  MODEL_NAME: Joi.string().default('gpt-4'),
  MODEL_CONTEXT_WINDOW: Joi.number().default(8192), // Токенов (по умолчанию для gpt-3.5-turbo)
}).unknown(true); // Разрешаем неизвестные поля для системных переменных Docker

module.exports = schema;
