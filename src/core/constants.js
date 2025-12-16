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
  // ИЗМЕНЕНИЕ: Используем Jina вместо OpenAI для векторов
  // Убедитесь, что в Dify -> Settings -> Model Provider -> Jina включена модель Text Embedding
  EMBEDDING_CONFIG: {
    embedding_model_provider: 'jina',
    embedding_model: 'jina-embeddings-v3', // Или 'jina-embeddings-v2-base-en' (проверьте, что доступно в вашем Dify)
  },
  // Настройки для Hybrid Search (Retrieval Settings)
  // Структура согласно ошибке валидации Dify API:
  // - reranking_mode должен быть строкой (не объектом)
  // - reranking_model - отдельный объект с настройками провайдера
  // - weights должен быть объектом или не передаваться при создании датасета
  HYBRID_RETRIEVAL_CONFIG: {
    search_method: 'hybrid_search',
    reranking_enable: true,
    reranking_mode: 'reranking_model', // Строка (как требует API)
    reranking_model: {
      reranking_provider_name: 'jina',
      reranking_model_name: 'jina-reranker-v2-base-multilingual',
    },
    // weights убран - API требует объект или не принимает при создании датасета
    top_k: 5,
    score_threshold_enabled: true,
    score_threshold: 0.5,
  },
};
