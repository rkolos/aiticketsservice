/* eslint-disable no-console */
/**
 * Скрипт для очистки Redis от данных воркеров
 * Удаляет:
 * - Все очереди BullMQ (ai-entry-queue, ai-interactive-queue, ai-background-queue, ai-results-queue)
 * - Кэш организаций (ticket-ai:org:*)
 * - Старые задачи и метаданные BullMQ
 */

require('dotenv').config({ override: true });

// Для локального запуска скрипта используем localhost, если не указано иное
if (!process.env.REDIS_HOST || process.env.REDIS_HOST === 'redis') {
  process.env.REDIS_HOST = 'localhost';
}

const Redis = require('ioredis');
const config = require('../src/config');
const { QUEUES } = require('../src/core/constants');

// Цвета для консоли
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Очистка очереди BullMQ
 */
async function cleanQueue(redis, queueName) {
  const patterns = [
    `bull:${queueName}:*`, // Все ключи очереди
  ];

  let totalDeleted = 0;

  for (const pattern of patterns) {
    const stream = redis.scanStream({
      match: pattern,
      count: 100,
    });

    const keysToDelete = [];
    
    await new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        keysToDelete.push(...keys);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    if (keysToDelete.length > 0) {
      // Удаляем батчами по 100 ключей
      for (let i = 0; i < keysToDelete.length; i += 100) {
        const batch = keysToDelete.slice(i, i + 100);
        await redis.del(...batch);
        totalDeleted += batch.length;
      }
    }
  }

  return totalDeleted;
}

/**
 * Очистка кэша организаций
 */
async function cleanOrgCache(redis) {
  const pattern = 'ticket-ai:org:*';
  const stream = redis.scanStream({
    match: pattern,
    count: 100,
  });

  const keysToDelete = [];
  
  await new Promise((resolve, reject) => {
    stream.on('data', (keys) => {
      keysToDelete.push(...keys);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (keysToDelete.length > 0) {
    // Удаляем батчами по 100 ключей
    for (let i = 0; i < keysToDelete.length; i += 100) {
      const batch = keysToDelete.slice(i, i + 100);
      await redis.del(...batch);
    }
    return keysToDelete.length;
  }

  return 0;
}

/**
 * Получить статистику по ключам
 */
async function getStats(redis) {
  const stats = {};

  // Статистика по очередям
  for (const [key, queueName] of Object.entries(QUEUES)) {
    const pattern = `bull:${queueName}:*`;
    const stream = redis.scanStream({
      match: pattern,
      count: 100,
    });

    const keys = [];
    await new Promise((resolve, reject) => {
      stream.on('data', (batch) => {
        keys.push(...batch);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    stats[queueName] = keys.length;
  }

  // Статистика по кэшу организаций
  const orgCachePattern = 'ticket-ai:org:*';
  const orgStream = redis.scanStream({
    match: orgCachePattern,
    count: 100,
  });

  const orgKeys = [];
  await new Promise((resolve, reject) => {
    orgStream.on('data', (batch) => {
      orgKeys.push(...batch);
    });
    orgStream.on('end', resolve);
    orgStream.on('error', reject);
  });

  stats['org-cache'] = orgKeys.length;

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const showStats = args.includes('--stats') || args.includes('-s');

  console.log(colorize('\n🧹 Redis Cleanup Script\n', 'cyan'));

  // Создаем соединение Redis
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    retryStrategy: (times) => {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

  redis.on('error', (error) => {
    console.error(colorize(`\n❌ Redis connection error: ${error.message}`, 'red'));
    process.exit(1);
  });

  try {
    // Проверяем подключение
    await redis.ping();
    console.log(colorize(`✓ Connected to Redis at ${config.redis.host}:${config.redis.port}`, 'green'));

    // Показываем статистику
    console.log(colorize('\n📊 Current Redis Statistics:', 'cyan'));
    const stats = await getStats(redis);
    
    let totalKeys = 0;
    for (const [queueName, count] of Object.entries(stats)) {
      console.log(`   ${queueName}: ${count} keys`);
      totalKeys += count;
    }
    console.log(`   ${colorize('Total:', 'yellow')} ${totalKeys} keys\n`);

    if (showStats) {
      console.log(colorize('\n✓ Statistics retrieved\n', 'green'));
      try {
        await redis.quit();
      } catch (err) {
        // Игнорируем ошибки при закрытии в режиме статистики
      }
      return;
    }

    if (dryRun) {
      console.log(colorize('🔍 DRY RUN MODE - No changes will be made\n', 'yellow'));
    } else {
      // Подтверждение
      console.log(colorize('⚠️  WARNING: This will delete all worker data from Redis!', 'red'));
      console.log(colorize('   - All BullMQ queues and jobs', 'yellow'));
      console.log(colorize('   - Organization cache', 'yellow'));
      console.log(colorize('   - This action cannot be undone!\n', 'yellow'));
      
      // В интерактивном режиме можно добавить подтверждение
      // Для автоматизации пропускаем
    }

    if (!dryRun) {
      console.log(colorize('🗑️  Starting cleanup...\n', 'cyan'));

      // Очищаем очереди
      const queueStats = {};
      for (const [key, queueName] of Object.entries(QUEUES)) {
        console.log(`   Cleaning queue: ${colorize(queueName, 'yellow')}...`);
        const deleted = await cleanQueue(redis, queueName);
        queueStats[queueName] = deleted;
        console.log(`   ${colorize('✓', 'green')} Deleted ${deleted} keys`);
      }

      // Очищаем кэш организаций
      console.log(`\n   Cleaning org cache...`);
      const orgCacheDeleted = await cleanOrgCache(redis);
      console.log(`   ${colorize('✓', 'green')} Deleted ${orgCacheDeleted} keys`);

      // Итоговая статистика
      console.log(colorize('\n✅ Cleanup completed!\n', 'green'));
      console.log('Summary:');
      for (const [queueName, count] of Object.entries(queueStats)) {
        console.log(`   ${queueName}: ${count} keys deleted`);
      }
      console.log(`   org-cache: ${orgCacheDeleted} keys deleted`);
      
      const totalDeleted = Object.values(queueStats).reduce((a, b) => a + b, 0) + orgCacheDeleted;
      console.log(`\n   ${colorize(`Total: ${totalDeleted} keys deleted`, 'green')}`);
    } else {
      console.log(colorize('\n🔍 DRY RUN: Would delete the keys shown above', 'yellow'));
    }

  } catch (error) {
    console.error(colorize(`\n❌ Error: ${error.message}`, 'red'));
    if (error.stack) {
      console.error(colorize(`   Stack: ${error.stack}`, 'red'));
    }
    process.exit(1);
  } finally {
    await redis.quit();
    console.log(colorize('\n✓ Redis connection closed\n', 'green'));
  }
}

// Запускаем скрипт
main().catch((error) => {
  console.error(colorize(`\n❌ Unhandled error: ${error.message}`, 'red'));
  console.error(error.stack);
  process.exit(1);
});

