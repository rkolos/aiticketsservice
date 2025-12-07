

# Структура проекта Ticket AI Worker

Этот документ описывает рекомендуемую структуру файлов и папок для микросервиса. Она спроектирована так, чтобы разделить инфраструктурный слой (Redis, Dify API), бизнес-логику (Services) и обработчики задач (Workers/Jobs).

## Корневая директория

Plaintext

    ticket-ai-worker/
    ├── docker/                 # Docker конфигурации
    │   ├── Dockerfile
    │   └── docker-compose.yml  # Локальное окружение (App + Redis)
    ├── src/                    # Исходный код
    │   ├── config/             # Конфигурация и переменные окружения
    │   ├── core/               # Типы, константы, интерфейсы
    │   ├── infrastructure/     # Клиенты внешних сервисов (Redis, Axios, BullMQ)
    │   │   ├── redis/
    │   │   ├── dify/
    │   │   └── bullmq/
    │   ├── services/           # Бизнес-логика (Organization, Billing, File)
    │   ├── workers/            # Обработчики очередей (Consumers)
    │   ├── utils/              # Утилиты и хелперы (Logger, ErrorHandler)
    │   └── index.js            # Точка входа (Entrypoint)
    ├── tests/                  # Тесты
    ├── .env.example            # Шаблон переменных окружения
    ├── .eslintrc.js            # Линтер
    ├── .gitignore
    ├── package.json
    └── README.md

## Детальное описание `src/`

### 1\. `src/config/`

Централизованное управление конфигом. Валидация `.env` при старте.

-   `index.js` — Экспорт конфига.
    
-   `schema.js` — Joi схема валидации (проверка наличия `DIFY_KEY_ADMIN`, `REDIS_PASSWORD` и ключей приложений).
    

### 2\. `src/core/`

Общие определения, используемые во всем приложении.

-   `types.js` — JSDoc типы (JobPayload, JobResult).
    
-   `constants.js` — Имена очередей, имена джобов (`CMD_...`), статусы.
    
-   `errors.js` — Кастомные классы ошибок (`KbNotFoundError`, `DifyApiError`).
    

### 3\. `src/infrastructure/`

Слой работы с внешним миром.

-   **`redis/`**
    
    -   `client.js` — Singleton подключения к Redis (с поддержкой пароля и `maxRetriesPerRequest: null`).
        
    -   `cache.js` — Репозиторий для маппинга `OrgId <-> DatasetId` (методы: `get`, `set`, `mset`, `delete`).
        
-   **`dify/`**
    
    -   `client.js` — Axios инстанс с базовым URL и интерцепторами (логирование, маппинг ошибок).
        
    -   `api.js` — Методы API: `retrieveChunks` (External RAG), `runWorkflow`, `uploadFile`, `listDatasets` и др.
        
-   **`bullmq/`**
    
    -   `factory.js` — Фабрика для создания воркеров с настройками Connection и Limiter.
        
    -   `resultQueue.js` — Экспорт инстанса очереди результатов и метода `sendResult`.
        

### 4\. `src/services/`

Чистая бизнес-логика. Сервисы вызываются из Воркеров.

-   **`OrganizationService.js`**
    
    -   Отвечает за логику "Lazy Loading", "Sync" и проверки доступа.
        
    -   Методы: `ensureAdminKb(orgId)`, `ensureHistoryKb(orgId)`, `getKbIdsOrThrow(orgId)`, `syncCacheWithDify()`.
        
-   **`BillingService.js`**
    
    -   Извлечение и нормализация usage (токенов) из ответов Dify.
        
    -   Методы: `extractUsage(response, defaultModel)`.
        
-   **`FileService.js`**
    
    -   Логика скачивания файла из URL в поток (Stream) через Axios.
        

### 5\. `src/workers/`

Точка входа для задач. Здесь BullMQ вызывает бизнес-логику.

-   **`fastLaneWorker.js`** — Процессор для `ai-interactive-queue`.
    
    -   `switch(job.name)`:
        
        -   `CMD_GEN_RESPONSE` -> **External RAG**: Поиск (Dify API) -> Сборка контекста -> Генерация (Dify Workflow).
            
        -   `CMD_ANALYZE_NEW_TICKET` -> Вызов Dify API + парсинг JSON.
            
        -   `CMD_KB_LIST_FILES` -> `OrganizationService` + Dify API.
            
-   **`slowLaneWorker.js`** — Процессор для `ai-background-queue`.
    
    -   `switch(job.name)`:
        
        -   `CMD_KB_ADD_FILE` -> `OrganizationService.ensure` + `FileService` + Загрузка в Dify (Admin Key).
            
        -   `CMD_ARCHIVE_TICKET` -> `OrganizationService.ensure` + Суммаризация + Индексация.
            
        -   `CMD_SYS_RESYNC_CACHE` -> `OrganizationService.sync`.
            

### 6\. `src/utils/`

-   `logger.js` — Настройка Winston (JSON/Simple format).
    
-   `errorHandler.js` — Нормализация ошибок (`normalizeError`) и создание пейлоада ответа (`createErrorPayload`).
    
-   `llmParser.js` — Хелпер для очистки JSON от Markdown (`cleanLlmJson`).
    

## Пример потока данных в коде

**Задача: `CMD_KB_ADD_FILE` (Slow Lane)**

1.  **BullMQ** берет задачу в `src/workers/slowLaneWorker.js`.
    
2.  **Worker** вызывает `OrganizationService.ensureAdminKb(orgId)`.
    
3.  **OrganizationService** проверяет Redis (`src/infrastructure/redis/cache.js`).
    
    -   Если пусто -> зовет Dify API (через `Admin Key`) для создания датасета -> пишет в Redis.
        
4.  **Worker** вызывает `FileService.downloadStream(url)`.
    
5.  **Worker** вызывает `difyApi.uploadFile(..., stream, ...)`.
    
6.  **Worker** отправляет успешный результат в `resultQueue`.
    

## План по файлам (Checklist)

1.  \[ \] Настроить `config/` и `utils/logger`.
    
2.  \[ \] Реализовать `infrastructure/` (Redis, Dify, BullMQ Factory).
    
3.  \[ \] Реализовать `services/OrganizationService` (Sync & Lazy Loading).
    
4.  \[ \] Реализовать `services/BillingService` и `FileService`.
    
5.  \[ \] Реализовать `workers/` (Fast & Slow с учетом External RAG).
    
6.  \[ \] Собрать всё в `index.js` (Start -> Sync -> Init Workers).



