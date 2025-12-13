/**
 * Константы приложения: имена очередей BullMQ и лимиты размера файлов
 * Используется в: src/infrastructure/bullmq/*, src/workers/*, src/services/FileService.js
 */
module.exports = {
  QUEUES: {
    ENTRY: 'ai-entry-queue',
    INTERACTIVE: 'ai-interactive-queue',
    BACKGROUND: 'ai-background-queue',
    RESULTS: 'ai-results-queue',
  },
  // Лимиты размера файлов для защиты от OOM
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024, // 50MB для стриминга
  MAX_TEXT_PROCESSING_LIMIT: 5 * 1024 * 1024, // 5MB для текстовой обработки (fallback)
};
