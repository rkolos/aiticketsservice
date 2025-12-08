// Настройка переменных окружения для тестов
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Уменьшаем шум в тестах
process.env.HEALTHCHECK_PORT = '3000';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_PASSWORD = '';
process.env.DIFY_API_URL = 'http://localhost:5001/v1';
process.env.DIFY_KEY_ADMIN = 'test-admin-key';
process.env.DIFY_KEY_CLASSIFIER = 'test-classifier-key';
process.env.DIFY_KEY_SUMMARIZER = 'test-summarizer-key';
process.env.DIFY_KEY_RESPONSE_WORKFLOW = 'test-response-key';
process.env.WORKER_FAST_LANE_CONCURRENCY = '15';
process.env.WORKER_SLOW_LANE_CONCURRENCY = '2';
process.env.DIFY_WORKFLOW_MAX_INPUT_VARIABLE_SIZE = '49152';
process.env.DIFY_WORKFLOW_MAX_REQUEST_BODY_SIZE = '10485760';
process.env.MODEL_NAME = 'gpt-4';
process.env.MODEL_CONTEXT_WINDOW = '8192';
process.env.FILE_SERVICE_CONNECTION_TIMEOUT = '30000';
process.env.FILE_SERVICE_IDLE_TIMEOUT = '60000';

