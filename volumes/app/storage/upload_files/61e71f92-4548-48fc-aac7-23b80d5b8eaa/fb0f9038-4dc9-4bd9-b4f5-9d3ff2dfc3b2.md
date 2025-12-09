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

