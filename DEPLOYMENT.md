# Развертывание Ticket AI Worker

## Предварительные требования

- Docker и Docker Compose
- Минимум 4GB RAM
- Минимум 20GB свободного места
- Ubuntu/Debian Linux или аналогичная ОС

## Шаги развертывания

### 1. Клонирование репозитория

```bash
git clone https://github.com/rkolos/aiticketsservice.git
cd aiticketsservice
git checkout dev
```

### 2. Настройка переменных окружения

#### Для Dify (основная система)

```bash
cp .env.dify.example .env
```

Отредактируйте `.env` файл:

```bash
# Замените YOUR_SERVER_IP на IP-адрес вашего сервера
sed -i 's/YOUR_SERVER_IP/165.227.159.10/g' .env

# Или отредактируйте вручную:
# CONSOLE_API_URL=http://165.227.159.10
# CONSOLE_WEB_URL=http://165.227.159.10
# SERVICE_API_URL=http://165.227.159.10
# APP_API_URL=http://165.227.159.10
# APP_WEB_URL=http://165.227.159.10

# Установите SECRET_KEY (сгенерируйте новый для продакшена)
# SECRET_KEY=your-generated-secret-key
```

#### Для Ticket AI Worker

```bash
# Перейдите в директорию worker'а если необходимо
cd src/workers/ticket-ai-worker
cp .env.example .env
```

Отредактируйте `.env` для worker'а:

```bash
# Настройте Dify API
DIFY_API_URL=http://165.227.159.10
DIFY_API_KEY=your-dify-api-key

# Настройте Redis
REDIS_URL=redis://redis:6379

# Остальные настройки по умолчанию
```

### 3. Создание директорий

```bash
mkdir -p volumes/{db,redis,weaviate,app/certbot/{conf,www},certbot/{conf,www}}
```

### 4. Проверка конфигурации

```bash
# Проверьте .env
[ -f ".env" ] && echo "✅ .env файл существует" || echo "❌ .env файл отсутствует"
```

### 5. Запуск системы

```bash
# Запуск всех сервисов
docker compose up -d

# Или поэтапно:
docker compose up -d db_postgres redis
docker compose up -d api web
docker compose up -d ticket-ai-worker
```

### 6. Проверка развертывания

```bash
# Проверьте статус контейнеров
docker compose ps

# Проверьте доступность веб-интерфейса
curl -I http://165.227.159.10/signin
```

### 7. Инициализация Dify

1. Перейдите на `http://165.227.159.10/install`
2. Создайте учетную запись администратора
3. Настройте систему
4. Сгенерируйте API ключи

### 8. Настройка Ticket AI Worker

После настройки Dify:

1. Получите API ключ из Dify
2. Обновите `.env` файл worker'а
3. Перезапустите worker: `docker compose restart ticket-ai-worker`

## Важные замечания

### Переменные окружения

- **APP_API_URL**: Должен указывать на внешний IP сервера, а не localhost
- **SECRET_KEY**: Сгенерируйте новый для продакшена
- **FORCE_TENANT_ISOLATION**: Должен быть `false` для Docker развертывания

### Мониторинг

```bash
# Просмотр логов
docker compose logs -f

# Проверка здоровья
docker compose ps
curl http://165.227.159.10/health
```

### Обновление

```bash
# Остановка
docker compose down

# Обновление кода
git pull origin dev

# Перезапуск
docker compose up -d

# Миграция (если требуется)
docker compose exec api flask db upgrade
```

## Troubleshooting

### Повторное развертывание / очистка сервера

Если предыдущая попытка оставила контейнеры, тома или образы и деплой падает:

```bash
docker compose down --volumes --remove-orphans
docker system prune -af --volumes
rm -rf /root/aiticketsservice
git clone https://github.com/rkolos/aiticketsservice.git /root/aiticketsservice
cd /root/aiticketsservice && git checkout dev
```

Заново создайте `.env` (см. шаг 2), каталоги `volumes/...` и поднимите стек.

### Ошибка PermissionDenied при записи privkeys

Симптом: в логах `api` при установке Dify — `PermissionDenied (persistent) at write ... path: privkeys/<uuid>/private.pem`.

Решение:
```bash
cd /root/aiticketsservice
chmod -R 777 volumes/app/storage
docker compose restart api plugin_daemon
```
После этого повторите установку Dify на `http://<YOUR_SERVER_IP>/install`.

### Проблема: "Invalid email or password"

**Решение:**
```bash
# Проверьте APP_API_URL
docker compose exec web env | grep API_URL

# Пересоздайте веб-контейнер
docker compose up -d --force-recreate web
```

### Проблема: Миграции не выполняются

**Решение:**
```bash
# Проверьте логи API
docker compose logs api | grep migration

# Перезапустите API
docker compose restart api
```

### Проблема: Worker не подключается

**Решение:**
```bash
# Проверьте Redis
docker compose exec redis redis-cli ping

# Проверьте логи worker'а
docker compose logs ticket-ai-worker
```
