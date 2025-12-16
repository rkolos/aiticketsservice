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
  // Правила процессинга для датасетов Dify (Parent-child + Hybrid Search)
  DATASET_PROCESS_RULES: {
    mode: 'custom',
    rules: {
      pre_processing_rules: [
        { id: 'remove_extra_spaces', enabled: true },
        { id: 'remove_urls_emails', enabled: false },
      ],
      segmentation: {
        separator: '\n',
        max_tokens: 1024, // Parent chunk size
        chunking_mode: 'parent_child',
        parent_child_config: {
          parent_chunk_size: 1024,
          child_chunk_size: 512,
        },
      },
    },
  },
  // Настройки для Hybrid Search (Retrieval Settings)
  HYBRID_RETRIEVAL_CONFIG: {
    search_method: 'hybrid_search',
    reranking_enable: true,
    // ИСПРАВЛЕНИЕ: reranking_mode должен быть объектом с настройками провайдера
    reranking_mode: {
      reranking_provider_name: 'jina',
      reranking_model_name: 'jina-reranker-v2-base-multilingual',
    },
    // Старое поле 'reranking_model' удалено, оно больше не нужно
    top_k: 3,
    score_threshold_enabled: false,
    score_threshold: 0.5,
  },
};
