# Ticket AI Worker

AI worker service for processing tickets via Dify (BullMQ/Redis)

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
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

### Test Coverage

Проект включает следующие тесты:

- **Unit tests**: `tests/utils/`, `tests/services/`
- **Integration tests**: `tests/integration/`

Все тесты должны проходить перед коммитом изменений.

