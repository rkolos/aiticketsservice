/**
 * Константы для приложения
 */
module.exports = {
  QUEUES: {
    ENTRY: 'ai-entry-queue',          // Единая точка входа для всех задач
    INTERACTIVE: 'ai-interactive-queue',
    BACKGROUND: 'ai-background-queue',
    RESULTS: 'ai-results-queue',
  },
  // Лимиты размера файлов для защиты от OOM
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024, // 50MB для стриминга
  MAX_TEXT_PROCESSING_LIMIT: 5 * 1024 * 1024, // 5MB для текстовой обработки (fallback)
};
