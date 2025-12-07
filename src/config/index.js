require('dotenv').config();
const schema = require('./schema');

// Валидация конфигурации
const { error, value } = schema.validate(process.env);

if (error) {
  // eslint-disable-next-line no-console
  console.error('❌ Configuration validation failed:');
  // eslint-disable-next-line no-console
  console.error(error.details.map((detail) => detail.message).join('\n'));
  process.exit(1);
}

// Экспорт конфигурации
module.exports = {
  env: value.NODE_ENV,
  logLevel: value.LOG_LEVEL,
  redis: {
    host: value.REDIS_HOST,
    port: parseInt(value.REDIS_PORT, 10),
    password: value.REDIS_PASSWORD || undefined,
  },
  dify: {
    url: value.DIFY_API_URL,
    keys: {
      admin: value.DIFY_KEY_ADMIN,
      classifier: value.DIFY_KEY_CLASSIFIER,
      summarizer: value.DIFY_KEY_SUMMARIZER,
      responseWorkflow: value.DIFY_KEY_RESPONSE_WORKFLOW,
    },
  },
  workers: {
    fastLane: {
      concurrency: parseInt(value.WORKER_FAST_LANE_CONCURRENCY, 10),
    },
    slowLane: {
      concurrency: parseInt(value.WORKER_SLOW_LANE_CONCURRENCY, 10),
    },
  },
  healthcheck: {
    port: parseInt(value.HEALTHCHECK_PORT, 10),
  },
};

