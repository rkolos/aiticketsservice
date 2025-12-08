# Ticket AI Worker

AI worker service for processing tickets via Dify (BullMQ/Redis)

## Installation

```bash
npm install
```

## Development

### Запуск локального окружения

1. **Запустите все сервисы (Redis, Dify, Worker):**

```bash
docker-compose up -d
```

Это запустит:
- **Redis** на порту `6379`
- **PostgreSQL** для Dify (внутренний порт) - база данных `dify_plugin` создается автоматически
- **Dify API** на порту `5001`
- **Dify Web** на порту `3000` (веб-интерфейс)
- **Dify Plugin Daemon** (сервис для управления плагинами)
- **Worker** (ваш микросервис)

2. **Настройте переменные окружения:**

Скопируйте `.env.example` в `.env` и настройте:

```bash
cp .env.example .env
```

Убедитесь, что `DIFY_API_URL=http://localhost:5001/v1` (или `http://dify-api:5001/v1` для Docker сети).

**Ключи для локального запуска Dify/worker (Joi-валидация обязательных полей):**
- `DIFY_KEY_ADMIN=app-UjUAGkbyJ0xwYGz13ztP7brp` (управление базами знаний)
- `DIFY_KEY_CLASSIFIER=app-eZTtiihrlV2D0QqfnhtjxZEO` (классификация тикетов)
- `DIFY_KEY_SUMMARIZER=<укажите ваш app key Summarizer>`
- `DIFY_KEY_RESPONSE_WORKFLOW=<укажите ваш app key Response Workflow>`

> **Важно:** Для успешного `docker-compose up` и старта worker все четыре ключа должны быть непустыми. Заполните Summarizer и Response Workflow своими ключами.

**Локальные API ключи Dify:**
- `DIFY_KEY_ADMIN=app-UjUAGkbyJ0xwYGz13ztP7brp` (для управления базами знаний)
- `DIFY_KEY_CLASSIFIER=app-eZTtiihrlV2D0QqfnhtjxZEO` (для классификации тикетов)

> **Примечание:** Это локальный проект, поэтому ключи указаны открыто в документации. Для продакшена используйте защищенные переменные окружения.

3. **Инициализируйте Dify:**

Откройте браузер и перейдите на `http://localhost:3000/install` для первоначальной настройки Dify.

4. **Запустите worker в режиме разработки:**

```bash
npm run dev
```

### Остановка сервисов

```bash
docker-compose down
```

Для полной очистки данных:

```bash
docker-compose down -v
```

## Production

```bash
npm start
```

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

- **Unit tests**: `tests/utils/`, `tests/services/`
- **Integration tests**: `tests/integration/`

Все тесты должны проходить перед коммитом изменений.

