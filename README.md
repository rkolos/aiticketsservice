# Ticket AI Worker

Асинхронный микросервис для обработки тикетов с использованием искусственного интеллекта (через Dify).

Сервис реализует паттерн **External RAG**: воркер самостоятельно управляет базами знаний (создает, наполняет, ищет) через Dify API, обеспечивая изоляцию данных по организациям (`orgId`).

## 🏗 Архитектура

Сервис построен на базе Node.js и BullMQ (Redis). Работает асинхронно по принципу «Producer -> Consumer».

### Схема потоков данных

    Main App -> [Redis: ai-entry-queue] -> Router Worker -> [Redis: Internal Queues] -> Processors <-> Dify API
                                                                                             |
    Main App <- [Redis: ai-results-queue] <- Result Queue <----------------------------------+
    
    

### Очереди (Redis)

Очередь

Название в коде

Тип

Описание

**`ai-entry-queue`**

`ENTRY`

**Вход**

**Единая точка входа.** Внешние сервисы шлют задачи только сюда. Router Worker сам распределяет их.

**`ai-interactive-queue`**

`INTERACTIVE`

Fast Lane

Высокий приоритет/concurrency. Для чата, переводов, анализа.

**`ai-background-queue`**

`BACKGROUND`

Slow Lane

Низкий приоритет, Rate Limiter. Для загрузки файлов, архивации, синхронизации.

**`ai-results-queue`**

`RESULTS`

**Выход**

Единый канал для возврата результатов (успех или ошибка).

## 🚀 Быстрый старт (Local Development)

### Предварительные требования

-   Node.js 18+
    
-   Redis (локально или в Docker)
    
-   Доступ к API Dify (v1)
    

### Установка и запуск

1.  **Установка зависимостей:**
    
        npm install
        
        
    
2.  **Настройка окружения:** Скопируйте пример конфига и заполните ключи (см. раздел [Конфигурация](https://www.google.com/search?q=%23-%D0%BA%D0%BE%D0%BD%D1%84%D0%B8%D0%B3%D1%83%D1%80%D0%B0%D1%86%D0%B8%D1%8F "null")):
    
        cp .env.example .env
        
        
    
3.  **Запуск (Режим разработки):** Команда автоматически проверит доступность Dify API перед стартом.
    
        npm run dev:with-dify-check
        
        
    
    _Альтернатива (без проверки):_ `npm run dev:skip-dify`
    

## ⚙️ Конфигурация

Все настройки задаются через переменные окружения (`.env`).

### Основные настройки

Переменная

Обязательно

Описание

Дефолт

`NODE_ENV`

✅

Окружение (`development`/`production`)

`development`

`LOG_LEVEL`

❌

Уровень логов

`info`

`HEALTHCHECK_PORT`

❌

Порт HTTP-сервера проверок

`3000`

### Redis

Переменная

Обязательно

Описание

`REDIS_HOST`

✅

Хост Redis

`REDIS_PORT`

❌

Порт

`REDIS_PASSWORD`

✅ (Prod)

Пароль

### Dify API

⚠️ **Важно:** API Dify должен быть доступен по сети от воркера.

Переменная

Описание

`DIFY_API_URL`

Базовый URL API (должен заканчиваться на `/v1`). Пример: `http://localhost:5001/v1`

**`DIFY_KEY_ADMIN`**

**Ключ датасетов.** Используется для создания баз знаний и RAG. (См. инструкцию ниже)

`DIFY_KEY_CLASSIFIER`

Ключ Workflow классификации тикетов

`DIFY_KEY_SUMMARIZER`

Ключ Workflow суммаризации тикетов

`DIFY_KEY_RESPONSE_WORKFLOW`

Ключ Workflow генерации ответов (RAG)

`DIFY_APP_KEY_TRANSLATOR`

Ключ Chatflow/Workflow переводчика

#### 🔑 Как получить `DIFY_KEY_ADMIN`

Этот ключ необходим для работы команд `CMD_KB_*` и `CMD_GEN_RESPONSE`.

1.  Зайдите в Dify -> Настройки профиля (или Workspace) -> **API Keys**.
    
2.  Создайте ключ с правами **Dataset Operator** или **Admin**.
    
    🔌 Документация по интеграции (API Reference)
    

Взаимодействие асинхронное. Вы отправляете задачу в `ai-entry-queue` и слушаете `ai-results-queue`.

### 1\. Общий формат задачи (Request)

    {
      "name": "CMD_НАЗВАНИЕ_КОМАНДЫ",
      "data": {
        "orgId": "client-123",       // Бизнес-данные (зависят от команды)
        
        // Pass-through контейнер. Возвращается обратно без изменений.
        // Использовать для связывания запроса и ответа (requestId, socketId и т.д.)
        "meta": {
          "traceId": "abc-123",
          "socketId": "ws-99",
          "userId": "user-55"
        }
      }
    }
    
    

### 2\. Общий формат ответа (Response)

    {
      "success": true,               // true - успех, false - ошибка
      "data": { ... },               // Результат выполнения (payload)
      "meta": {
        "traceId": "abc-123",        // Ваши данные из запроса (вернулись как есть)
        "timestamp": 1715000000,
        "processingTimeMs": 1450,
        "usage": {                   // Расход токенов (если применимо)
           "total_tokens": 150,
           "stages": [...]
        }
      },
      "error": {                     // Заполняется только если success: false
        "code": "ERROR_CODE",
        "message": "Описание ошибки",
        "retryable": false
      }
    }
    
    

## 📚 Справочник команд

### Группа 1: Интерактивные (Fast Lane)

#### `CMD_ANALYZE_NEW_TICKET`

Анализ входящего тикета: определение темы и тональности.

**Параметры (`data`):**

-   `content` (string, required): Текст тикета.
    
-   `targetLang` (string, optional): Язык заголовка (def: 'en').
    

**Пример запроса:**

    {
      "name": "CMD_ANALYZE_NEW_TICKET",
      "data": {
        "content": "У нас упал прод, 500 ошибка на главной! Срочно!",
        "targetLang": "en",
        "meta": { "internalId": "ticket-777" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "title": "Production 500 Error on Main Page",
        "sentiment": "negative"
      },
      "meta": {
        "internalId": "ticket-777",
        "usage": { "total_tokens": 150 }
      }
    }
    
    

#### `CMD_GEN_RESPONSE` (RAG)

Генерация ответа на вопрос пользователя с поиском по базе знаний.

**Параметры (`data`):**

-   `orgId` (string, required): ID организации.
    
-   `query` (string, required): Вопрос пользователя.
    
-   `history` (array/string, optional): История диалога.
    
-   `lang` (string, optional): Язык ответа.
    

**Пример запроса:**

    {
      "name": "CMD_GEN_RESPONSE",
      "data": {
        "orgId": "org-100",
        "query": "Как настроить VPN подключение?",
        "history": [
          { "role": "user", "content": "У меня не работает сеть." },
          { "role": "assistant", "content": "Какую ошибку вы видите?" }
        ],
        "lang": "ru",
        "meta": { "chatId": "chat-555" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "content": "Для настройки VPN откройте приложение Cisco AnyConnect...",
        "sources": [
          { "document_name": "Инструкция VPN.pdf", "score": 0.85 }
        ],
        "retrievedContext": [
          { "content": "...нажмите кнопку Connect...", "score": 0.85, "source": "admin_kb" }
        ]
      },
      "meta": {
        "chatId": "chat-555",
        "usage": { "total_tokens": 450 }
      }
    }
    
    

#### `CMD_TRANSLATE`

Перевод текста.

**Параметры (`data`):**

-   `content` (string, required): Исходный текст.
    
-   `targetLang` (string, optional): Целевой язык (def: 'en').
    

**Пример запроса:**

    {
      "name": "CMD_TRANSLATE",
      "data": {
        "content": "Соединение с сервером было разорвано.",
        "targetLang": "es",
        "meta": { "messageId": "msg-100" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "content": "La conexión con el servidor fue interrumpida.",
        "sourceContent": "Соединение с сервером было разорвано.",
        "targetLang": "es"
      },
      "meta": { "messageId": "msg-100" }
    }
    
    

#### `CMD_KB_LIST_FILES`

Получение списка файлов в базе знаний.

**Параметры (`data`):**

-   `orgId` (string, required).
    

**Пример запроса:**

    {
      "name": "CMD_KB_LIST_FILES",
      "data": {
        "orgId": "client-abc-123",
        "meta": { "userId": "admin-55" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "items": [
          {
            "id": "doc-uuid-1",
            "name": "Инструкция.pdf",
            "status": "completed",
            "word_count": 1500,
            "created_at": 1715000000
          }
        ],
        "count": 1
      },
      "meta": { "userId": "admin-55" }
    }
    
    

#### `CMD_KB_DELETE_FILE`

Удаление файла.

**Параметры (`data`):**

-   `orgId` (string, required).
    
-   `fileId` (string, required).
    

**Пример запроса:**

    {
      "name": "CMD_KB_DELETE_FILE",
      "data": {
        "orgId": "org-555",
        "fileId": "doc-abc-123-uuid",
        "meta": { "reason": "outdated" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "deleted": true,
        "documentId": "doc-abc-123-uuid"
      },
      "meta": { "reason": "outdated" }
    }
    
    

### Группа 2: Фоновые (Slow Lane)

#### `CMD_KB_ADD_FILE`

Загрузка файла по ссылке в базу знаний. Работает долго (скачивание -> загрузка -> индексация).

**Параметры (`data`):**

-   `orgId` (string, required).
    
-   `fileUrl` (string, required): Публичная прямая ссылка.
    
-   `fileName` (string, required): Имя с расширением (напр. `manual.pdf`).
    

**Пример запроса:**

    {
      "name": "CMD_KB_ADD_FILE",
      "data": {
        "orgId": "org-555",
        "fileUrl": "[https://example.com/uploads/manual_v2.pdf](https://example.com/uploads/manual_v2.pdf)",
        "fileName": "Manual_v2.pdf",
        "meta": { "uploaderId": "admin-01" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "documentId": "doc-uuid-888",
        "status": "indexing",
        "fileName": "Manual_v2.pdf",
        "orgId": "org-555"
      },
      "meta": { "uploaderId": "admin-01" }
    }
    
    

#### `CMD_ARCHIVE_TICKET`

Суммаризация тикета и сохранение в архивную базу знаний (`KB_HISTORY_*`).

**Параметры (`data`):**

-   `orgId` (string, required).
    
-   `fullTicketHistory` (array/string, required): История переписки.
    
-   `lang` (string, optional): Язык саммари.
    

**Пример запроса:**

    {
      "name": "CMD_ARCHIVE_TICKET",
      "data": {
        "orgId": "org-555",
        "fullTicketHistory": [
          { "role": "user", "content": "Принтер жует бумагу." },
          { "role": "assistant", "content": "Попробуйте очистить лоток." }
        ],
        "meta": { "ticketId": "T-100500" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "documentId": "doc-summary-uuid-999",
        "docName": "Ticket #T-100500",
        "orgId": "org-555"
      },
      "meta": {
        "ticketId": "T-100500",
        "usage": { "total_tokens": 300 }
      }
    }
    
    

#### `CMD_CLEANUP_ORG`

Полное удаление данных организации (GDPR). Удаляет базы знаний в Dify и чистит кэш в Redis.

**Параметры (`data`):**

-   `orgId` (string, required).
    

**Пример запроса:**

    {
      "name": "CMD_CLEANUP_ORG",
      "data": {
        "orgId": "org-to-delete-555",
        "meta": { "reason": "gdpr-request" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "orgId": "org-to-delete-555",
        "deleted": {
          "adminKbId": "dataset-uuid-1",
          "historyKbId": "dataset-uuid-2"
        }
      },
      "meta": { "reason": "gdpr-request" }
    }
    
    

#### `CMD_SYS_RESYNC_CACHE`

Системная команда. Принудительная синхронизация маппинга `orgId -> datasetId` из Dify в Redis.

**Параметры:** Нет (передавать пустой объект или только meta).

**Пример запроса:**

    {
      "name": "CMD_SYS_RESYNC_CACHE",
      "data": {
        "meta": { "initiator": "devops" }
      }
    }
    
    

**Пример ответа:**

    {
      "success": true,
      "data": {
        "processed": 150,
        "updated": 75
      },
      "meta": { "initiator": "devops" }
    }
    
    

## 🛠 Production & DevOps

### Docker

Сборка production-образа:

    docker build --target production -t ticket-ai-worker:latest .
    
    

Запуск контейнера:

    docker run -d \
      --name ticket-ai-worker \
      --env-file .env \
      ticket-ai-worker:latest
    
    

### Healthcheck API

Используйте для Liveness/Readiness probes (Kubernetes/AWS LB).

-   **URL:** `GET /health` (порт `3000` по умолчанию).
    
-   **Успех (200 OK):** Все компоненты (Redis, Dify, Workers) доступны.
    
-   **Ошибка (503 Service Unavailable):** Если хотя бы один компонент недоступен.
    

Пример ответа:

    {
      "status": "healthy",
      "checks": {
        "redis": { "status": "ok" },
        "dify": { "status": "ok" },
        "workers": { "fastLane": { "status": "ok" }, "slowLane": { "status": "ok" } }
      }
    }
    
    

## 🧪 Тестирование

### Smoke Tests (E2E)

В проекте есть скрипт для end-to-end проверки всей цепочки (отправка -> обработка -> результат). Он последовательно запускает все команды.

**Запуск:**

    npm run test:smoke
    
    

**Полезные флаги:**

-   `--test 1,2` — запустить только тесты №1 и №2.
    
-   `--debug-rag` — включить расширенную отладку для RAG.
    

### Unit тесты

    npm test
    
    

## 🛑 Коды ошибок API

Если выполнение задачи завершилось неудачей (`success: false`), поле `error.code` в ответе будет содержать один из следующих кодов:

Код ошибки

Причина

Действие клиента

**`DIFY_API_ERROR`**

Ошибка на стороне Dify или неверные ключи.

Проверить логи, валидность API ключей в `.env`. Можно попробовать повторить запрос.

**`KB_NOT_FOUND`**

Не найдена база знаний (или кэш устарел).

Выполнить `CMD_SYS_RESYNC_CACHE`. Обычно базы создаются автоматически (Lazy Loading).

**`FILE_TOO_LARGE`**

Файл превышает лимит (50MB).

Уменьшить файл или разбить на части.

**`TIMEOUT`**

Обработка заняла > 60 сек.

LLM думает долго или файл огромный. Повторите запрос.

**`UNKNOWN_COMMAND`**

Неверное имя команды в `name`.

Проверить орфографию названия команды.


----------------------------------------------

## Пример корректно работающего смок теста

```bash
user@Valerias-MacBook-Pro Tickets % cd /Users/user/Documents/Tickets && npm run test:smoke 2>&1

> ticket-ai-worker@1.0.0 test:smoke
> node scripts/smoke-test.js

[dotenv@17.2.3] injecting env (639) from .env -- tip: ⚙️  enable debug logging with { debug: true }
[dotenv@17.2.3] injecting env (0) from .env -- tip: 🔐 prevent building .env in docker: https://dotenvx.com/prebuild

🚀 Starting E2E Smoke Test...

--- [TEST 0/13: Healthcheck Service] ---
Checking Healthcheck API at http://localhost:4000/health...
   Full Healthcheck Response:
{
  "status": "healthy",
  "timestamp": "2025-12-13T19:19:52.970Z",
  "checks": {
    "redis": {
      "status": "ok",
      "message": "Connection successful"
    },
    "dify": {
      "status": "ok",
      "message": "API accessible"
    },
    "workers": {
      "fastLane": {
        "status": "ok",
        "message": "Worker is running",
        "activeJobs": 0
      },
      "slowLane": {
        "status": "ok",
        "message": "Worker is running",
        "activeJobs": 0
      }
    }
  }
}

✓ Healthcheck API is healthy

   Checks:
     Redis: ok
     Dify: ok
     FastLane Worker: ok
     SlowLane Worker: ok
Connecting to Redis at localhost:6379...
✓ Connected to Redis at localhost:6379
Checking Dify API at http://localhost:5001/v1...
✓ Dify API is accessible

✓ Results Worker ready and listening on ai-results-queue
⚠️  Note: Make sure workers are running (npm run dev) for tests to complete


--- [TEST 1/13: Analyzing Ticket] ---
[21:19:54] 📤 SENT (ai-entry-queue): CMD_ANALYZE_NEW_TICKET | TraceID: 737f1b83
   Payload (full): {
  "text": "У меня не работает вход в систему, ошибка 500",
  "targetLanguage": "en",
  "meta": {
    "traceId": "737f1b83-ac45-4b71-8587-cac2fbfbb0de",
    "debugTag": "CMD_ANALYZE_NEW_TICKET-cc0fbe",
    "nested": {
      "ts": 1765653594219
    }
  }
}
[21:19:56] 🔄 Worker processing (ai-results-queue): CMD_ANALYZE_NEW_TICKET | JobID: 1917
[21:19:56] 🔍 RECEIVED JOB (ai-results-queue): CMD_ANALYZE_NEW_TICKET | TraceID: 737f1b83
[21:19:56] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_ANALYZE_NEW_TICKET",
  "data": {
    "success": true,
    "data": {
      "title": "Login error 500",
      "sentiment": "negative"
    }
  },
  "meta": {
    "traceId": "737f1b83-ac45-4b71-8587-cac2fbfbb0de",
    "timestamp": 1765653596757,
    "jobId": "787",
    "processingTimeMs": 2511,
    "debugTag": "CMD_ANALYZE_NEW_TICKET-cc0fbe",
    "nested": {
      "ts": 1765653594219
    },
    "usage": {
      "stages": [
        {
          "prompt_tokens": 214,
          "completion_tokens": 20
        }
      ]
    }
  }
}
   ✅ META OK
   > Title: Login error 500
   > Sentiment: negative
   > Usage in meta: ✓
   > Usage stages: 1
✅ TEST PASSED (2.58s)

--- [TEST 2/13: Translation] ---
[21:19:58] 📤 SENT (ai-entry-queue): CMD_TRANSLATE | TraceID: 5d182e98
   Payload (full): {
  "text": "Welcome to the system",
  "targetLang": "ru",
  "meta": {
    "traceId": "5d182e98-1833-40e9-b875-abbf8c84d2b5",
    "debugTag": "CMD_TRANSLATE-26919b",
    "nested": {
      "ts": 1765653598805
    }
  }
}
[21:19:59] 🔄 Worker processing (ai-results-queue): CMD_TRANSLATE | JobID: 1918
[21:19:59] 🔍 RECEIVED JOB (ai-results-queue): CMD_TRANSLATE | TraceID: 5d182e98
[21:19:59] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_TRANSLATE",
  "data": {
    "success": true,
    "data": {
      "content": "Добро пожаловать в систему",
      "sourceContent": "Welcome to the system",
      "targetLang": "ru"
    }
  },
  "meta": {
    "traceId": "5d182e98-1833-40e9-b875-abbf8c84d2b5",
    "timestamp": 1765653599465,
    "jobId": "788",
    "processingTimeMs": 639,
    "debugTag": "CMD_TRANSLATE-26919b",
    "nested": {
      "ts": 1765653598805
    },
    "usage": {
      "stages": [
        {
          "prompt_tokens": 0,
          "completion_tokens": 0
        }
      ]
    }
  }
}
   ✅ META OK
   > Content (translated): Добро пожаловать в систему
   > Contains Cyrillic ✓
   > Source content: Welcome to the system...
   > Usage in meta: ✓
✅ TEST PASSED (0.67s)

--- [TEST 3/13: File Upload (Open WebUI README)] ---
[21:20:01] 📤 SENT (ai-entry-queue): CMD_KB_ADD_FILE | TraceID: bcb0201c
   Payload (full): {
  "orgId": "test-org-smoke",
  "fileUrl": "https://raw.githubusercontent.com/open-webui/open-webui/main/README.md",
  "fileName": "open-webui-readme.md",
  "meta": {
    "traceId": "bcb0201c-6e0a-4957-a6dd-827d9bd931e0",
    "debugTag": "CMD_KB_ADD_FILE-01cd77",
    "nested": {
      "ts": 1765653601474
    }
  }
}
[21:20:03] 🔄 Worker processing (ai-results-queue): CMD_KB_ADD_FILE | JobID: 1919
[21:20:03] 🔍 RECEIVED JOB (ai-results-queue): CMD_KB_ADD_FILE | TraceID: bcb0201c
[21:20:03] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_KB_ADD_FILE",
  "data": {
    "success": true,
    "data": {
      "documentId": "f8eea823-bf08-4f08-b24f-0f16c3528524",
      "status": "indexing",
      "fileName": "open-webui-readme.md",
      "orgId": "test-org-smoke"
    }
  },
  "meta": {
    "traceId": "bcb0201c-6e0a-4957-a6dd-827d9bd931e0",
    "timestamp": 1765653603849,
    "jobId": "903",
    "processingTimeMs": 0,
    "orgId": "test-org-smoke",
    "fileUrl": "https://raw.githubusercontent.com/open-webui/open-webui/main/README.md",
    "fileName": "open-webui-readme.md",
    "debugTag": "CMD_KB_ADD_FILE-01cd77",
    "nested": {
      "ts": 1765653601474
    }
  }
}
   ✅ META OK
   > Document ID: f8eea823-bf08-4f08-b24f-0f16c3528524
   > Status: indexing
✅ TEST PASSED (2.38s)

--- [TEST 4/13: File Upload (Alpaca WebUI README)] ---
[21:20:05] 📤 SENT (ai-entry-queue): CMD_KB_ADD_FILE | TraceID: f3424d7e
   Payload (full): {
  "orgId": "test-org-smoke",
  "fileUrl": "https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md",
  "fileName": "alpaca-webui-readme.md",
  "meta": {
    "traceId": "f3424d7e-d2db-41e1-a9e3-9149714b8e43",
    "debugTag": "CMD_KB_ADD_FILE-bdd691",
    "nested": {
      "ts": 1765653605854
    }
  }
}
[21:20:08] 🔄 Worker processing (ai-results-queue): CMD_KB_ADD_FILE | JobID: 1920
[21:20:08] 🔍 RECEIVED JOB (ai-results-queue): CMD_KB_ADD_FILE | TraceID: f3424d7e
[21:20:08] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_KB_ADD_FILE",
  "data": {
    "success": true,
    "data": {
      "documentId": "ece32f79-ba68-4f58-86d1-f2b2732230cc",
      "status": "indexing",
      "fileName": "alpaca-webui-readme.md",
      "orgId": "test-org-smoke"
    }
  },
  "meta": {
    "traceId": "f3424d7e-d2db-41e1-a9e3-9149714b8e43",
    "timestamp": 1765653608042,
    "jobId": "904",
    "processingTimeMs": 0,
    "orgId": "test-org-smoke",
    "fileUrl": "https://raw.githubusercontent.com/mmo80/alpaca-webui/main/README.md",
    "fileName": "alpaca-webui-readme.md",
    "debugTag": "CMD_KB_ADD_FILE-bdd691",
    "nested": {
      "ts": 1765653605854
    },
    "usage": {
      "model": "file-indexing",
      "stages": [
        {
          "prompt_tokens": 0,
          "completion_tokens": 1345,
          "model": "file-indexing",
          "type": "indexing"
        }
      ]
    }
  }
}
   ✅ META OK
   > Document ID: ece32f79-ba68-4f58-86d1-f2b2732230cc
   > Status: indexing
✅ TEST PASSED (2.19s)
⏳ Syncing cache to ensure knowledge base is available...

--- [CACHE SYNC: Syncing cache before RAG] ---
[21:20:13] 📤 SENT (ai-entry-queue): CMD_SYS_RESYNC_CACHE | TraceID: 9f0d27a6
   Payload (full): {
  "meta": {
    "traceId": "9f0d27a6-c4b1-44a1-8462-0ccb525e397d",
    "debugTag": "CMD_SYS_RESYNC_CACHE-5111d3",
    "nested": {
      "ts": 1765653613047
    }
  }
}
[21:20:13] 🔄 Worker processing (ai-results-queue): CMD_SYS_RESYNC_CACHE | JobID: 1921
[21:20:13] 🔍 RECEIVED JOB (ai-results-queue): CMD_SYS_RESYNC_CACHE | TraceID: 9f0d27a6
[21:20:13] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_SYS_RESYNC_CACHE",
  "data": {
    "success": true,
    "data": {
      "processed": 1,
      "updated": 1
    }
  },
  "meta": {
    "traceId": "9f0d27a6-c4b1-44a1-8462-0ccb525e397d",
    "timestamp": 1765653613235,
    "jobId": "905",
    "processingTimeMs": 163,
    "debugTag": "CMD_SYS_RESYNC_CACHE-5111d3",
    "nested": {
      "ts": 1765653613047
    }
  }
}
   ✅ META OK
   > Stats: {"processed":1,"updated":1}
✅ TEST PASSED (0.19s)

--- [TEST 5/13: Generating Response (RAG with uploaded files - WebUI comparison)] ---
[21:20:15] 📤 SENT (ai-entry-queue): CMD_GEN_RESPONSE | TraceID: abfbf87a | Lang: uk
   Payload (full): {
  "orgId": "test-org-smoke",
  "query": "Hello! I am trying to decide between installing Alpaca WebUI and Open WebUI, and image generation is very important to me. I noticed that Open WebUI explicitly mentions support for local generation tools like ComfyUI and AUTOMATIC1111. Could you please clarify if Alpaca WebUI also supports these local image engines? Please tell me exactly which models or providers are currently supported for image generation in both Alpaca WebUI and Open WebUI, so I can compare them.",
  "history": "User: I want to compare different WebUI projects\nAssistant: I can help you compare different AI WebUI projects. What aspects are most important to you?\nUser: I need information about image generation capabilities",
  "lang": "uk",
  "meta": {
    "traceId": "abfbf87a-7b5b-4092-a829-00f7ebd371f3",
    "debugTag": "CMD_GEN_RESPONSE-67b2ad",
    "nested": {
      "ts": 1765653615241
    }
  }
}
[21:20:29] 🔄 Worker processing (ai-results-queue): CMD_GEN_RESPONSE | JobID: 1922
[21:20:29] 🔍 RECEIVED JOB (ai-results-queue): CMD_GEN_RESPONSE | TraceID: abfbf87a
[21:20:29] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_GEN_RESPONSE",
  "data": {
    "success": true,
    "data": {
      "content": "Привіт! Дякую за ваше запитання. Я розумію, що можливість генерації зображень є для вас ключовою при виборі інтерфейсу.\n\nНа жаль, у доступній мені інформації про Alpaca WebUI немає жодних згадок про підтримку локальних інструментів для генерації зображень, таких як ComfyUI чи AUTOMATIC1111. Мій опис цього проєкту зосереджений на його функціях як інтерфейсу для чат-моделей (LLM) та підтримці текстових провайдерів, таких як OpenAI, Anthropic, Google тощо.\n\nЗ іншого боку, Open WebUI прямо зазначає підтримку локальних генераторів зображень, що дає йому чітку перевагу для ваших потреб.\n\nОскільки я не маю точної інформації про те, які саме моделі чи провайдери для генерації зображень підтримуються в кожному з цих інтерфейсів, я не можу надати вам детального порівняння.\n\nМені шкода, але я не можу вирішити це конкретне питання наразі. Для отримання детальної інформації про підтримку генерації зображень, особливо в Alpaca WebUI, рекомендую звернутися до офіційної документації цих проєктів або до оператора для отримання розширеної допомоги.",
      "retrievedContext": [
        {
          "content": "Alpaca WebUI\nAlpaca WebUI is a chat conversation interface for working with LLMs, originally built for Ollama and now supporting a wide range of AI providers. It features markup formatting, code syntax highlighting, and lets you use models from providers like OpenAI, Anthropic, Google, Deepseek, OpenRouter, Mistral.ai, Together.ai, Groq.com, and your local or remote Ollama server.",
          "score": 0.60439891,
          "source": "admin_kb",
          "documentName": "alpaca-webui-readme.md"
        },
        {
          "content": "Key Features of Open WebUI ⭐\n- 🚀 **Effortless Setup**: Install seamlessly using Docker or Kubernetes (kubectl, kustomize or helm) for a hassle-free experience with support for both `:ollama` and `:cuda` tagged images.\n\n- 🤝 **Ollama/OpenAI API Integration**: Effortlessly integrate OpenAI-compatible APIs for versatile conversations alongside Ollama models. Customize the OpenAI API URL to link with **LMStudio, GroqCloud, Mistral, OpenRouter, and more**.",
          "score": 0.53946853,
          "source": "admin_kb",
          "documentName": "open-webui-readme.md"
        }
      ]
    }
  },
  "meta": {
    "traceId": "abfbf87a-7b5b-4092-a829-00f7ebd371f3",
    "timestamp": 1765653629588,
    "jobId": "789",
    "processingTimeMs": 14330,
    "debugTag": "CMD_GEN_RESPONSE-67b2ad",
    "nested": {
      "ts": 1765653615241
    },
    "usage": {
      "stages": [
        {
          "prompt_tokens": 709,
          "completion_tokens": 395
        }
      ]
    }
  }
}
   ✅ META OK
   > Content: Привіт! Дякую за ваше запитання. Я розумію, що можливість генерації зображень є ...
   > Usage in meta: ✓
   > Usage stages: 1
   > Retrieved chunks: 2
✅ TEST PASSED (14.35s)

--- [TEST 6/13: Archiving Ticket] ---
[21:20:31] 📤 SENT (ai-entry-queue): CMD_ARCHIVE_TICKET | TraceID: 4d21e532 | Lang: en
   Payload (full): {
  "orgId": "test-org-smoke",
  "fullTicketHistory": [
    {
      "role": "user",
      "content": "У меня проблема с доступом"
    },
    {
      "role": "assistant",
      "content": "Проверьте настройки безопасности"
    },
    {
      "role": "user",
      "content": "Спасибо, помогло!"
    }
  ],
  "lang": "en",
  "meta": {
    "traceId": "4d21e532-6511-4a16-828c-81a3a4bf0fe5",
    "debugTag": "CMD_ARCHIVE_TICKET-fb31e3",
    "nested": {
      "ts": 1765653631596
    },
    "ticketId": "smoke-test-ticket-123"
  }
}
[21:20:42] 🔄 Worker processing (ai-results-queue): CMD_ARCHIVE_TICKET | JobID: 1923
[21:20:42] 🔍 RECEIVED JOB (ai-results-queue): CMD_ARCHIVE_TICKET | TraceID: 4d21e532
[21:20:42] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_ARCHIVE_TICKET",
  "data": {
    "success": true,
    "data": {
      "documentId": "461d75ab-eb33-4908-bd1f-87a3965d6268",
      "docName": "Ticket #smoke-test-ticket-123",
      "orgId": "test-org-smoke"
    }
  },
  "meta": {
    "traceId": "4d21e532-6511-4a16-828c-81a3a4bf0fe5",
    "timestamp": 1765653642298,
    "jobId": "906",
    "processingTimeMs": 0,
    "debugTag": "CMD_ARCHIVE_TICKET-fb31e3",
    "nested": {
      "ts": 1765653631596
    },
    "ticketId": "smoke-test-ticket-123",
    "orgId": "test-org-smoke",
    "usage": {
      "model": "indexing-model",
      "stages": [
        {
          "prompt_tokens": 231,
          "completion_tokens": 19
        },
        {
          "prompt_tokens": 0,
          "completion_tokens": 489,
          "model": "indexing-model"
        }
      ]
    }
  }
}
   ✅ META OK
   > Document ID: 461d75ab-eb33-4908-bd1f-87a3965d6268
   > Usage stages in meta: 2
✅ TEST PASSED (10.71s)

--- [TEST 7/13: List Files] ---
[21:20:44] 📤 SENT (ai-entry-queue): CMD_KB_LIST_FILES | TraceID: d94ead51
   Payload (full): {
  "orgId": "test-org-smoke",
  "meta": {
    "traceId": "d94ead51-b982-4a34-961f-9876c92336ae",
    "debugTag": "CMD_KB_LIST_FILES-44ef5f",
    "nested": {
      "ts": 1765653644317
    }
  }
}
[21:20:44] 🔄 Worker processing (ai-results-queue): CMD_KB_LIST_FILES | JobID: 1924
[21:20:44] 🔍 RECEIVED JOB (ai-results-queue): CMD_KB_LIST_FILES | TraceID: d94ead51
[21:20:44] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_KB_LIST_FILES",
  "data": {
    "success": true,
    "data": {
      "items": [
        {
          "id": "ece32f79-ba68-4f58-86d1-f2b2732230cc",
          "name": "alpaca-webui-readme.md",
          "created_at": 1765653606,
          "word_count": 4132,
          "status": "completed"
        },
        {
          "id": "f8eea823-bf08-4f08-b24f-0f16c3528524",
          "name": "open-webui-readme.md",
          "created_at": 1765653602,
          "word_count": 15728,
          "status": "completed"
        }
      ],
      "count": 2
    }
  },
  "meta": {
    "traceId": "d94ead51-b982-4a34-961f-9876c92336ae",
    "timestamp": 1765653644419,
    "jobId": "790",
    "processingTimeMs": 84,
    "debugTag": "CMD_KB_LIST_FILES-44ef5f",
    "nested": {
      "ts": 1765653644317
    }
  }
}
   ✅ META OK
   > Files count: 2
   > File 1: alpaca-webui-readme.md
     - ID: ece32f79-ba68-4f58-86d1-f2b2732230cc
     - Status: completed
     - Word count: 4132
     - Created: 1765653606
   > File 2: open-webui-readme.md
     - ID: f8eea823-bf08-4f08-b24f-0f16c3528524
     - Status: completed
     - Word count: 15728
     - Created: 1765653602
✅ TEST PASSED (0.11s)
⏳ Syncing cache before delete...

--- [CACHE SYNC: Syncing cache before delete] ---
[21:20:46] 📤 SENT (ai-entry-queue): CMD_SYS_RESYNC_CACHE | TraceID: e91967c6
   Payload (full): {
  "meta": {
    "traceId": "e91967c6-b7f1-4cdd-9151-022d004eac9b",
    "debugTag": "CMD_SYS_RESYNC_CACHE-b61664",
    "nested": {
      "ts": 1765653646425
    }
  }
}
[21:20:46] 🔄 Worker processing (ai-results-queue): CMD_SYS_RESYNC_CACHE | JobID: 1925
[21:20:46] 🔍 RECEIVED JOB (ai-results-queue): CMD_SYS_RESYNC_CACHE | TraceID: e91967c6
[21:20:46] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_SYS_RESYNC_CACHE",
  "data": {
    "success": true,
    "data": {
      "processed": 2,
      "updated": 1
    }
  },
  "meta": {
    "traceId": "e91967c6-b7f1-4cdd-9151-022d004eac9b",
    "timestamp": 1765653646591,
    "jobId": "907",
    "processingTimeMs": 146,
    "debugTag": "CMD_SYS_RESYNC_CACHE-b61664",
    "nested": {
      "ts": 1765653646425
    }
  }
}
   ✅ META OK
   > Stats: {"processed":2,"updated":1}
✅ TEST PASSED (0.17s)

--- [TEST 8/13: Delete File] ---
[21:20:47] 📤 SENT (ai-entry-queue): CMD_KB_DELETE_FILE | TraceID: 89696bd3
   Payload (full): {
  "orgId": "test-org-smoke",
  "fileId": "f8eea823-bf08-4f08-b24f-0f16c3528524",
  "meta": {
    "traceId": "89696bd3-1447-4f85-9bfd-06c0bc87b929",
    "debugTag": "CMD_KB_DELETE_FILE-c562ea",
    "nested": {
      "ts": 1765653647596
    }
  }
}
[21:20:47] 🔄 Worker processing (ai-results-queue): CMD_KB_DELETE_FILE | JobID: 1926
[21:20:47] 🔍 RECEIVED JOB (ai-results-queue): CMD_KB_DELETE_FILE | TraceID: 89696bd3
[21:20:47] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_KB_DELETE_FILE",
  "data": {
    "success": true,
    "data": {
      "deleted": true,
      "documentId": "f8eea823-bf08-4f08-b24f-0f16c3528524"
    }
  },
  "meta": {
    "traceId": "89696bd3-1447-4f85-9bfd-06c0bc87b929",
    "timestamp": 1765653647741,
    "jobId": "791",
    "processingTimeMs": 133,
    "debugTag": "CMD_KB_DELETE_FILE-c562ea",
    "nested": {
      "ts": 1765653647596
    }
  }
}
   ✅ META OK
   > Deleted: true
   > Document ID: f8eea823-bf08-4f08-b24f-0f16c3528524
✅ TEST PASSED (0.15s)

--- [TEST 9/13: Sync Cache] ---
[21:20:49] 📤 SENT (ai-entry-queue): CMD_SYS_RESYNC_CACHE | TraceID: 4b2f9dcd
   Payload (full): {
  "meta": {
    "traceId": "4b2f9dcd-d6c6-450b-99f9-3f6bd703fdcd",
    "debugTag": "CMD_SYS_RESYNC_CACHE-7748f8",
    "nested": {
      "ts": 1765653649747
    }
  }
}
[21:20:49] 🔄 Worker processing (ai-results-queue): CMD_SYS_RESYNC_CACHE | JobID: 1927
[21:20:49] 🔍 RECEIVED JOB (ai-results-queue): CMD_SYS_RESYNC_CACHE | TraceID: 4b2f9dcd
[21:20:49] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_SYS_RESYNC_CACHE",
  "data": {
    "success": true,
    "data": {
      "processed": 2,
      "updated": 1
    }
  },
  "meta": {
    "traceId": "4b2f9dcd-d6c6-450b-99f9-3f6bd703fdcd",
    "timestamp": 1765653649928,
    "jobId": "908",
    "processingTimeMs": 160,
    "debugTag": "CMD_SYS_RESYNC_CACHE-7748f8",
    "nested": {
      "ts": 1765653649747
    }
  }
}
   ✅ META OK
   > Stats: {"processed":2,"updated":1}
✅ TEST PASSED (0.20s)

--- [TEST 10/13: Unknown Command (Error Handling)] ---
[21:20:51] 📤 SENT (ai-entry-queue): CMD_UNKNOWN_COMMAND | TraceID: 86c9606e
   Payload (full): {
  "orgId": "test-org-smoke",
  "someData": "test data",
  "meta": {
    "traceId": "86c9606e-c8c7-43a2-81ba-79ba7de41cfc",
    "debugTag": "CMD_UNKNOWN_COMMAND-c33ae8",
    "nested": {
      "ts": 1765653651945
    }
  }
}
[21:20:51] 🔄 Worker processing (ai-results-queue): CMD_UNKNOWN_COMMAND | JobID: 1928
[21:20:51] 🔍 RECEIVED JOB (ai-results-queue): CMD_UNKNOWN_COMMAND | TraceID: 86c9606e
[21:20:51] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_UNKNOWN_COMMAND",
  "data": {
    "success": false,
    "error": {
      "code": "UNKNOWN_COMMAND",
      "message": "Unknown command: CMD_UNKNOWN_COMMAND",
      "details": "Unknown command: CMD_UNKNOWN_COMMAND",
      "retryable": false
    }
  },
  "meta": {
    "traceId": "86c9606e-c8c7-43a2-81ba-79ba7de41cfc",
    "timestamp": 1765653651955,
    "jobId": "1929",
    "processingTimeMs": 0,
    "jobName": "CMD_UNKNOWN_COMMAND",
    "debugTag": "CMD_UNKNOWN_COMMAND-c33ae8",
    "nested": {
      "ts": 1765653651945
    }
  }
}
   ✅ META OK
   ⚠️  WORKER ERROR: Unknown command: CMD_UNKNOWN_COMMAND
   > Error Code: UNKNOWN_COMMAND
   > Error Message: Unknown command: CMD_UNKNOWN_COMMAND
   > Contains "unknown" in message ✓
   > Error code is UNKNOWN_COMMAND ✓
✅ TEST PASSED (0.02s)

--- [TEST 10.5/13: Unknown Command with Cyrillic (CMD_РРРРРРР)] ---
[21:20:53] 📤 SENT (ai-entry-queue): CMD_РРРРРРР | TraceID: 16121dfd
   Payload (full): {
  "orgId": "test-org-smoke",
  "someData": "test data",
  "meta": {
    "traceId": "16121dfd-4b60-444f-ab81-add10780e411",
    "debugTag": "CMD_РРРРРРР-04e943",
    "nested": {
      "ts": 1765653653965
    }
  }
}
[21:20:53] 🔄 Worker processing (ai-results-queue): CMD_РРРРРРР | JobID: 1929
[21:20:53] 🔍 RECEIVED JOB (ai-results-queue): CMD_РРРРРРР | TraceID: 16121dfd
[21:20:53] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_РРРРРРР",
  "data": {
    "success": false,
    "error": {
      "code": "UNKNOWN_COMMAND",
      "message": "Unknown command: CMD_РРРРРРР",
      "details": "Unknown command: CMD_РРРРРРР",
      "retryable": false
    }
  },
  "meta": {
    "traceId": "16121dfd-4b60-444f-ab81-add10780e411",
    "timestamp": 1765653653971,
    "jobId": "1930",
    "processingTimeMs": 0,
    "jobName": "CMD_РРРРРРР",
    "debugTag": "CMD_РРРРРРР-04e943",
    "nested": {
      "ts": 1765653653965
    }
  }
}
   ✅ META OK
   ⚠️  WORKER ERROR: Unknown command: CMD_РРРРРРР
   > Error Code: UNKNOWN_COMMAND
   > Error Message: Unknown command: CMD_РРРРРРР
   > Contains "unknown" in message ✓
   > Error code is UNKNOWN_COMMAND ✓
✅ TEST PASSED (0.01s)

--- [TEST 11/13: Cleanup Org] ---
[21:20:56] 📤 SENT (ai-entry-queue): CMD_CLEANUP_ORG | TraceID: 5da962f9
   Payload (full): {
  "orgId": "test-org-smoke",
  "meta": {
    "traceId": "5da962f9-2ad8-48d9-a856-30c54ecb5676",
    "debugTag": "CMD_CLEANUP_ORG-ba8c90",
    "nested": {
      "ts": 1765653656144
    }
  }
}
[21:20:56] 🔄 Worker processing (ai-results-queue): CMD_CLEANUP_ORG | JobID: 1930
[21:20:56] 🔍 RECEIVED JOB (ai-results-queue): CMD_CLEANUP_ORG | TraceID: 5da962f9
[21:20:56] 📥 RECEIVED (ai-results-queue): Success
   Result (full job): {
  "jobName": "CMD_CLEANUP_ORG",
  "data": {
    "success": true,
    "data": {
      "orgId": "test-org-smoke",
      "deleted": {
        "adminKbId": "42daabe8-48aa-4458-9e22-bbf03e0555ac",
        "historyKbId": "3b1842cf-78c7-466b-97f1-9a6f1efdadf0"
      }
    }
  },
  "meta": {
    "traceId": "5da962f9-2ad8-48d9-a856-30c54ecb5676",
    "timestamp": 1765653656543,
    "jobId": "909",
    "processingTimeMs": 0,
    "orgId": "test-org-smoke",
    "debugTag": "CMD_CLEANUP_ORG-ba8c90",
    "nested": {
      "ts": 1765653656144
    }
  }
}
   ✅ META OK
   > Org ID: test-org-smoke
   > Deleted adminKbId: 42daabe8-48aa-4458-9e22-bbf03e0555ac
   > Deleted historyKbId: 3b1842cf-78c7-466b-97f1-9a6f1efdadf0
✅ TEST PASSED (0.41s)

📊 SUMMARY
Total Tests: 12
Passed: 12
Duration: 62.3s

user@Valerias-MacBook-Pro Tickets %
``` 