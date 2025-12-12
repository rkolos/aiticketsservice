# Ticket AI Worker

Асинхронный микросервис для обработки тикетов через Dify (External RAG, Classification)

## Архитектура

Микросервис реализует паттерн **External RAG**, где воркер сам выполняет поиск контекста через Dify API, используя Admin Key, а затем вызывает Workflow для генерации финального ответа.

### Схема потоков данных

```
Main App -> Redis (BullMQ) -> AI Worker <-> Dify API
```

**Очереди:**

- **`ai-entry-queue` (Entry Point)** — Единая точка входа для всех задач. Внешние сервисы должны отправлять задачи только в эту очередь. Router Worker автоматически распределяет задачи по внутренним очередям.
- **`ai-interactive-queue` (Fast Lane)** — Внутренняя очередь для интерактивных задач: чат, перевод, анализ, RAG-генерация (высокий concurrency)
- **`ai-background-queue` (Slow Lane)** — Внутренняя очередь для фоновых задач: загрузка файлов, архивация, системная синхронизация (низкий concurrency, Rate Limiter)
- **`ai-results-queue` (Output)** — Единый канал для возврата результатов

Подробное описание архитектуры и спецификации см. в `about/about_project.md`.

## Быстрый старт (Local Development)

1. **Скопируйте `.env.example` в `.env` и заполните ключи:**

```bash
cp .env.example .env
```

2. **Запустите все сервисы:**

```bash
docker-compose up -d
```

Это запустит:
- **Redis** на порту `6379`
- **PostgreSQL** для Dify (внутренний порт)
- **Dify API** на порту `5001`
- **Dify Web** на порту `3000` (веб-интерфейс)
- **Dify Plugin Daemon** (сервис для управления плагинами)

3. **Инициализируйте Dify:**

Откройте браузер и перейдите на `http://localhost:3000/install` для первоначальной настройки Dify.

4. **Установите зависимости и запустите worker:**

```bash
npm install
npm run dev
```

5. **Запустите тесты:**

```bash
npm test
```

## Переменные окружения

| Переменная | Обязательно | Описание |
|-----------|-------------|----------|
| `NODE_ENV` | Да | `production` / `development` |
| `LOG_LEVEL` | Нет | Уровень логирования: `error`, `warn`, `info`, `debug` (по умолчанию: `info`) |
| `REDIS_HOST` | Да | Хост Redis |
| `REDIS_PORT` | Нет | Порт Redis (по умолчанию: `6379`) |
| `REDIS_PASSWORD` | **Да** (в prod) | Пароль от Redis |
| `DIFY_API_URL` | Да | URL API Dify (v1), например: `http://localhost:5001/v1` |
| **`DIFY_KEY_ADMIN`** | **Да** | Ключ с правами Dataset Operator или Admin (для управления базами знаний и поиска) |
| `DIFY_KEY_CLASSIFIER` | Да | Ключ Workflow классификации тикетов |
| `DIFY_KEY_SUMMARIZER` | Да | Ключ Workflow суммаризации |
| `DIFY_KEY_RESPONSE_WORKFLOW` | Да | Ключ Workflow генерации ответов |
| `WORKER_FAST_LANE_CONCURRENCY` | Нет | Количество одновременных задач для Fast Lane (по умолчанию: `15`) |
| `WORKER_SLOW_LANE_CONCURRENCY` | Нет | Количество одновременных задач для Slow Lane (по умолчанию: `2`) |
| `HEALTHCHECK_PORT` | Нет | Порт для HTTP-сервера healthcheck (по умолчанию: `3000`) |
| `FILE_SERVICE_CONNECTION_TIMEOUT` | Нет | Таймаут подключения для FileService в мс (по умолчанию: `30000`) |
| `FILE_SERVICE_IDLE_TIMEOUT` | Нет | Таймаут простоя для FileService в мс (по умолчанию: `60000`) |
| `DIFY_WORKFLOW_MAX_INPUT_VARIABLE_SIZE` | Нет | Максимальный размер входной переменной в байтах (по умолчанию: `49152`) |
| `DIFY_WORKFLOW_MAX_REQUEST_BODY_SIZE` | Нет | Максимальный размер тела запроса в байтах (по умолчанию: `10485760`) |
| `MODEL_NAME` | Нет | Название модели по умолчанию (по умолчанию: `gpt-4`) |
| `MODEL_CONTEXT_WINDOW` | Нет | Размер контекстного окна модели в токенах (по умолчанию: `8192`) |

### Получение DIFY_KEY_ADMIN в Dify

`DIFY_KEY_ADMIN` — это API ключ с правами **Dataset Operator** или **Admin** для управления базами знаний (knowledge bases/datasets). Он используется для:
- Создания и удаления датасетов (`/datasets`)
- Загрузки файлов в датасеты (`/datasets/{id}/document/create_by_file`)
- Создания документов из текста (`/datasets/{id}/document/create_by_text`)
- Поиска в базах знаний (`/datasets/{id}/retrieve`)

**Пошаговая инструкция:**

1. **Откройте веб-интерфейс Dify:**
   - Перейдите на `http://localhost:3000` (после запуска `docker-compose up -d`)
   - Войдите в систему

2. **Найдите раздел для создания API ключа:**
   
   В зависимости от версии Dify, раздел может находиться в разных местах:
   
   **Вариант A: В настройках приложения (Application API Key)**
   - Перейдите в раздел **"Studio"** или **"Apps"**
   - Выберите или создайте любое приложение
   - В настройках приложения найдите раздел **"API Keys"** или **"API Access"**
   - Создайте новый API ключ с правами **"Dataset Operator"** или **"Admin"**
   
   **Вариант B: В настройках Workspace**
   - В правом верхнем углу нажмите на иконку профиля/настройки
   - Выберите **"Settings"** или **"Workspace Settings"**
   - Найдите раздел **"API Keys"** или **"API Access"**
   - Создайте новый ключ с правами **"Dataset Operator"** или **"Admin"**
   
   **Вариант C: В разделе Knowledge Base**
   - Перейдите в раздел **"Knowledge Base"** или **"Datasets"**
   - Найдите настройки или раздел **"API Keys"**
   - Создайте ключ для управления датасетами

3. **Создайте API ключ:**
   - Нажмите **"Create API Key"**, **"Add API Key"** или **"Create New Secret Key"**
   - Укажите имя ключа (например, "Worker Admin Key")
   - Выберите права доступа: **"Dataset Operator"** или **"Admin"**
   - Подтвердите создание

4. **Скопируйте ключ:**
   - После создания ключ будет показан **один раз**
   - Скопируйте его полностью (формат обычно: `app-...` или `dataset-...`)
   - **Важно:** Сохраните ключ сразу, так как его нельзя будет посмотреть позже

5. **Добавьте ключ в `.env`:**
   ```bash
   DIFY_KEY_ADMIN=ваш-скопированный-ключ
   ```

**Проверка ключа:**

После добавления ключа в `.env`, проверьте его работоспособность:

```bash
curl -H "Authorization: Bearer ваш-ключ" http://localhost:5001/v1/datasets
```

Если ключ валидный, вы получите список датасетов (может быть пустым). Если получите `401 Unauthorized`, ключ неверный или не имеет нужных прав.

**Важно:**
- `DIFY_KEY_ADMIN` должен иметь права **Dataset Operator** или **Admin**
- Ключ должен работать с эндпоинтами `/datasets/*` (не только с `/workflows/run`)
- Если не можете найти раздел API Keys, проверьте документацию вашей версии Dify: https://docs.dify.ai

## Очереди и Задачи (API Reference)

### Очередь быстрых задач (Fast Lane: `ai-interactive-queue`)

#### `CMD_GEN_RESPONSE` — Генерация ответа (External RAG)

**Вход:**
```json
{
  "orgId": "123",
  "query": "Как сбросить пароль?",
  "history": [
    { "role": "user", "content": "Здравствуйте" },
    { "role": "assistant", "content": "Здравствуйте! Чем могу помочь?" }
  ],
  "meta": {
    "ticketId": "555",
    "user": "user-123"
  }
}
```

**Логика:**
1. Получение ID баз знаний (`adminKbId`, `historyKbId`) из Redis по `orgId`
2. Параллельный поиск чанков из обеих баз через Dify API (`retrieveChunks`)
3. Сборка контекста из найденных чанков
4. Обрезка истории, если она превышает лимит модели
5. Генерация ответа через Dify Workflow с собранным контекстом
6. Извлечение usage (токенов) из ответа

**Выход:**
```json
{
  "status": "success",
  "data": {
    "text": "Для сброса пароля...",
    "sources": [...],
    "usage": {
      "promptTokens": 1000,
      "completionTokens": 500,
      "totalTokens": 1500,
      "model": "gpt-4"
    }
  },
  "meta": { "ticketId": "555", "user": "user-123" }
}
```

#### `CMD_ANALYZE_NEW_TICKET` — Классификация и анализ тикета

**Вход:**
```json
{
  "text": "Текст тикета",
  "targetLanguage": "ru",
  "meta": { "ticketId": "123" }
}
```

**Выход:**
```json
{
  "status": "success",
  "data": {
    "title": "Заголовок тикета",
    "sentiment": "positive" | "neutral" | "negative"
  },
  "meta": { "ticketId": "123" }
}
```

#### `CMD_TRANSLATE` — Перевод текста

**Вход:**
```json
{
  "text": "Текст для перевода",
  "targetLang": "en",
  "meta": { "ticketId": "123" }
}
```

**Выход:**
```json
{
  "status": "success",
  "data": {
    "text": "Translated text"
  },
  "meta": { "ticketId": "123" }
}
```

#### `CMD_KB_LIST_FILES` — Получение списка файлов из базы знаний

**Вход:**
```json
{
  "orgId": "123",
  "meta": { "ticketId": "123" }
}
```

**Выход:**
```json
{
  "status": "success",
  "data": [
    {
      "id": "doc-1",
      "name": "file.pdf",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z",
      "word_count": 1000,
      "status": "completed"
    }
  ],
  "meta": { "ticketId": "123" }
}
```

#### `CMD_KB_DELETE_FILE` — Удаление файла из базы знаний

**Вход:**
```json
{
  "orgId": "123",
  "fileId": "doc-1",
  "meta": { "ticketId": "123" }
}
```

**Выход:**
```json
{
  "status": "success",
  "data": {
    "deleted": true,
    "fileId": "doc-1"
  },
  "meta": { "ticketId": "123" }
}
```

### Очередь фоновых задач (Slow Lane: `ai-background-queue`)

#### `CMD_KB_ADD_FILE` — Загрузка файла в базу знаний

**Вход:**
```json
{
  "orgId": "123",
  "fileUrl": "https://example.com/file.pdf",
  "fileName": "file.pdf",
  "meta": { "ticketId": "123" }
}
```

**Логика:**
1. Проверка наличия базы знаний для организации (Lazy Loading)
2. Создание базы, если её нет
3. Скачивание файла через FileService
4. Загрузка файла в Dify через Admin Key
5. Сохранение ID базы в Redis кэш

**Выход:**
```json
{
  "status": "success",
  "data": {
    "documentId": "doc-123",
    "kbId": "kb-456"
  },
  "meta": { "ticketId": "123" }
}
```

#### `CMD_ARCHIVE_TICKET` — Архивация тикета

**Вход:**
```json
{
  "orgId": "123",
  "ticketId": "ticket-456",
  "text": "Текст тикета",
  "meta": { "ticketId": "ticket-456" }
}
```

**Логика:**
1. Суммаризация тикета через Dify Workflow
2. Индексация суммаризированного текста в History KB

#### `CMD_SYS_RESYNC_CACHE` — Синхронизация кэша с Dify

**Вход:**
```json
{
  "meta": {}
}
```

**Логика:**
1. Получение списка всех датасетов из Dify
2. Синхронизация Redis кэша с актуальным состоянием Dify

**Выход:**
```json
{
  "status": "success",
  "data": {
    "synced": 10,
    "created": 2,
    "deleted": 1
  }
}
```

## Production

### Docker Build

```bash
docker build --target production -t ticket-ai-worker:latest .
```

### Запуск

```bash
docker run -d \
  --name ticket-ai-worker \
  --env-file .env \
  ticket-ai-worker:latest
```

### Healthcheck

Микросервис предоставляет HTTP endpoint для healthcheck:

```bash
curl http://localhost:3000/health
```

Ответ при здоровых компонентах (HTTP 200):
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": {
    "redis": { "status": "ok", "message": "Connection successful" },
    "dify": { "status": "ok", "message": "API accessible" },
    "workers": {
      "fastLane": { "status": "ok", "message": "Worker is running", "activeJobs": 5 },
      "slowLane": { "status": "ok", "message": "Worker is running", "activeJobs": 2 }
    }
  }
}
```

## Troubleshooting

### Ошибка `KB_NOT_FOUND`

**Проблема:** Воркер не может найти базу знаний для организации.

**Решение:**
1. Проверьте, что `DIFY_KEY_ADMIN` настроен и имеет права Dataset Operator или Admin
2. Выполните синхронизацию кэша:
   ```json
   {
     "name": "CMD_SYS_RESYNC_CACHE",
     "data": { "meta": {} }
   }
   ```
3. Убедитесь, что база знаний существует в Dify для данной организации

### Сброс кэша

Для полной синхронизации кэша Redis с состоянием Dify используйте задачу `CMD_SYS_RESYNC_CACHE`:

```json
{
  "name": "CMD_SYS_RESYNC_CACHE",
  "data": { "meta": {} }
}
```

Эта задача:
- Получает список всех датасетов из Dify
- Синхронизирует Redis кэш с актуальным состоянием
- Возвращает статистику синхронизации

### Проблемы с подключением к Redis

**Проблема:** Воркер не может подключиться к Redis.

**Решение:**
1. Проверьте `REDIS_HOST` и `REDIS_PORT` в `.env`
2. Убедитесь, что Redis запущен: `docker-compose ps redis`
3. Проверьте пароль: `REDIS_PASSWORD` должен быть установлен в production

### Проблемы с Dify API

**Проблема:** Ошибки при вызове Dify API.

**Решение:**
1. Проверьте `DIFY_API_URL` (должен заканчиваться на `/v1`)
2. Убедитесь, что все ключи (`DIFY_KEY_ADMIN`, `DIFY_KEY_CLASSIFIER`, и т.д.) настроены
3. Проверьте доступность Dify API: `curl http://localhost:5001/v1/datasets`

## Code Quality

```bash
# Lint
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

## Testing

```bash
# Run all tests
npm test

# Run tests for specific file
npm test -- tests/path/to/test.js

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Smoke Tests (E2E)

Smoke тесты проверяют работу всей цепочки обработки задач в реальном окружении:

```bash
# Запустить все smoke тесты
npm run test:smoke

# Показать список доступных тестов
npm run test:smoke -- --list-tests

# Запустить только указанные тесты по номерам
npm run test:smoke -- --test 1,3,5
npm run test:smoke -- --test 1-5,10

# Запустить тесты по именам команд
npm run test:smoke -- --test-name CMD_ANALYZE_NEW_TICKET,CMD_TRANSLATE

# Запустить отладочный тест RAG
npm run test:smoke -- --debug-rag

# Показать справку
npm run test:smoke -- --help
```

**Доступные тесты:**
1. `CMD_ANALYZE_NEW_TICKET` - Анализ нового тикета
2. `CMD_TRANSLATE` - Перевод текста
3. `CMD_KB_ADD_FILE` (first) - Загрузка первого файла
4. `CMD_KB_ADD_FILE` (second) - Загрузка второго файла
5. `CMD_GEN_RESPONSE` - Генерация ответа с RAG
6. `CMD_ARCHIVE_TICKET` - Архивация тикета
7. `CMD_KB_LIST_FILES` - Список файлов
8. `CMD_KB_DELETE_FILE` - Удаление файла
9. `CMD_SYS_RESYNC_CACHE` - Синхронизация кэша
10. `CMD_UNKNOWN_COMMAND` - Обработка неизвестной команды
10.5. `CMD_РРРРРРР` - Неизвестная команда с кириллицей
11. `CMD_CLEANUP_ORG` - Очистка организации

**Примеры использования для отладки:**
```bash
# Быстрая проверка только анализа и перевода
npm run test:smoke -- --test 1,2

# Проверка только RAG функциональности
npm run test:smoke -- --test 3,4,5

# Проверка только работы с файлами
npm run test:smoke -- --test-name CMD_KB_ADD_FILE,CMD_KB_LIST_FILES,CMD_KB_DELETE_FILE
```

### Development Workflow

**Важно:** После завершения реализации любой задачи обязательно запускайте все тесты проекта:

```bash
npm test
```

Это гарантирует, что новые изменения не нарушили функциональность, реализованную в предыдущих задачах, и предотвращает регрессии.

**Правило тестирования:** Никогда не используйте условные тесты (`test.skip`, условные `test.only`). Все тесты должны выполняться всегда. Если требуется реальное окружение (API ключи, база данных), тесты должны либо использовать моки, либо падать с понятной ошибкой, но не пропускаться.

### Test Coverage

Проект включает следующие тесты:

- **Unit tests**: `tests/unit/`, `tests/services/`, `tests/utils/`
- **Integration tests**: `tests/integration/`

Все тесты должны проходить перед коммитом изменений.

## Остановка сервисов

```bash
docker-compose down
```

Для полной очистки данных:

```bash
docker-compose down -v
```
