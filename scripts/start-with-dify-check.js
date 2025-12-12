#!/usr/bin/env node

/**
 * Скрипт для запуска проекта с проверкой и автоматическим запуском Dify
 * 
 * Использование:
 *   node scripts/start-with-dify-check.js [--check-dify] [--skip-dify-check]
 *   npm run start:with-dify-check
 *   npm run dev:with-dify-check
 * 
 * Параметры:
 *   --check-dify, --auto-start-dify  - Проверить доступность Dify и запустить если недоступен
 *   --skip-dify-check                - Пропустить проверку Dify (запустить воркер без проверки)
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const Redis = require('ioredis');
require('dotenv').config({ override: true });
const config = require('../src/config');

const execAsync = promisify(exec);

// Цвета для консоли
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Проверка доступности Redis
 * @returns {Promise<{available: boolean, message: string}>}
 */
async function checkRedis() {
  return new Promise((resolve) => {
    const redisConfig = {
      host: config.redis.host,
      port: config.redis.port,
      connectTimeout: 3000,
      maxRetriesPerRequest: null,
    };

    if (config.redis.password) {
      redisConfig.password = config.redis.password;
    }

    const testClient = new Redis(redisConfig);

    const timeout = setTimeout(() => {
      testClient.disconnect();
      resolve({
        available: false,
        message: 'Redis connection timeout',
      });
    }, 5000);

    testClient.once('ready', () => {
      clearTimeout(timeout);
      testClient.ping()
        .then(() => {
          testClient.disconnect();
          resolve({
            available: true,
            message: `Redis is accessible at ${config.redis.host}:${config.redis.port}`,
          });
        })
        .catch((error) => {
          testClient.disconnect();
          resolve({
            available: false,
            message: `Redis ping failed: ${error.message}`,
          });
        });
    });

    testClient.once('error', (error) => {
      clearTimeout(timeout);
      testClient.disconnect();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        resolve({
          available: false,
          message: `Redis is not accessible at ${config.redis.host}:${config.redis.port} (connection refused)`,
        });
      } else {
        resolve({
          available: false,
          message: `Redis connection error: ${error.message}`,
        });
      }
    });
  });
}

/**
 * Проверка доступности Dify API
 * @returns {Promise<{available: boolean, message: string}>}
 */
async function checkDifyApi() {
  try {
    const adminKey = config.dify.keys.admin;
    if (!adminKey) {
      return {
        available: false,
        message: 'Dify Admin key not configured (DIFY_KEY_ADMIN is not set)',
      };
    }

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Dify API timeout')), 5000);
    });

    // Простой запрос к Dify API для проверки доступности
    // Используем /datasets эндпоинт, который доступен через Admin API
    const apiUrl = config.dify.url.endsWith('/') 
      ? `${config.dify.url}datasets` 
      : `${config.dify.url}/datasets`;
    
    const apiPromise = axios.get(apiUrl, {
      headers: {
        Authorization: `Bearer ${adminKey}`,
      },
      timeout: 5000,
      validateStatus: (status) => status < 500, // Принимаем любые статусы кроме 5xx
    });

    const response = await Promise.race([apiPromise, timeoutPromise]);

    // Если получили ответ (даже 401/403), значит API доступен
    if (response.status === 200 || response.status === 401 || response.status === 403) {
      return {
        available: true,
        message: 'Dify API is accessible',
      };
    }

    return {
      available: false,
      message: `Dify API returned status ${response.status}`,
    };
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return {
        available: false,
        message: 'Dify API is not accessible (connection refused)',
      };
    }
    if (error.code === 'ECONNRESET' || (error.message && error.message.includes('socket hang up'))) {
      return {
        available: false,
        message: 'Dify API is not ready yet (connection reset)',
      };
    }
    if (error.message && error.message.includes('timeout')) {
      return {
        available: false,
        message: 'Dify API timeout (no response)',
      };
    }
    return {
      available: false,
      message: `Dify API check failed: ${error.message}`,
    };
  }
}

/**
 * Определение команды docker-compose
 * @returns {Promise<string>}
 */
async function getDockerComposeCmd() {
  // Пробуем сначала docker compose (новый формат), затем docker-compose (старый)
  try {
    await execAsync('docker compose version', { timeout: 3000 });
    return 'docker compose';
  } catch {
    try {
      await execAsync('docker-compose --version', { timeout: 3000 });
      return 'docker-compose';
    } catch {
      throw new Error('docker-compose or docker compose not found. Please install Docker Compose.');
    }
  }
}

/**
 * Проверка статуса Docker контейнеров Dify
 * @returns {Promise<{running: boolean, containers: string[], dockerComposeCmd: string}>}
 */
async function checkDifyContainers() {
  try {
    const dockerComposeCmd = await getDockerComposeCmd();

    const { stdout } = await execAsync(`${dockerComposeCmd} ps --format json`, {
      cwd: process.cwd(),
    });
    
    const containers = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((c) => c !== null);

    const difyServices = ['api', 'worker', 'worker_beat', 'db_postgres', 'redis', 'ssrf_proxy', 'plugin_daemon'];
    const runningContainers = containers
      .filter((c) => difyServices.includes(c.Service) && c.State === 'running')
      .map((c) => c.Service);

    return {
      running: runningContainers.length > 0,
      containers: runningContainers,
      dockerComposeCmd,
    };
  } catch (error) {
    // Если docker-compose не доступен или нет контейнеров
    if (error.message && error.message.includes('not found')) {
      throw error; // Пробрасываем ошибку, если docker-compose не установлен
    }
    return {
      running: false,
      containers: [],
      dockerComposeCmd: 'docker-compose',
    };
  }
}

/**
 * Запуск Dify сервисов через docker-compose
 * @param {string} dockerComposeCmd - Команда docker-compose (docker compose или docker-compose)
 * @returns {Promise<void>}
 */
async function startDifyServices(dockerComposeCmd = 'docker-compose') {
  console.log(colorize('\n🚀 Starting Dify services...', 'cyan'));
  
  try {
    // Запускаем необходимые сервисы Dify
    // Используем --profile postgresql для PostgreSQL, если он в профиле
    const services = [
      'redis',
      'db_postgres',
      'api',
      'worker',
      'worker_beat',
      'ssrf_proxy',
      'plugin_daemon',
    ];

    console.log(colorize(`Starting services: ${services.join(', ')}`, 'yellow'));

    // Запускаем сервисы
    const { stdout, stderr } = await execAsync(
      `${dockerComposeCmd} up -d ${services.join(' ')}`,
      { cwd: process.cwd() }
    );

    if (stdout) {
      console.log(stdout);
    }
    if (stderr && !stderr.includes('Creating') && !stderr.includes('Starting')) {
      console.error(colorize(stderr, 'yellow'));
    }

    console.log(colorize('✓ Dify services started', 'green'));
  } catch (error) {
    console.error(colorize(`❌ Failed to start Dify services: ${error.message}`, 'red'));
    throw error;
  }
}

/**
 * Проверка статуса контейнеров Dify
 * @param {string} dockerComposeCmd - Команда docker-compose
 * @returns {Promise<{healthy: boolean, statuses: Object}>}
 */
async function checkContainersHealth(dockerComposeCmd) {
  try {
    const { stdout } = await execAsync(`${dockerComposeCmd} ps --format json`, {
      cwd: process.cwd(),
    });
    
    const containers = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((c) => c !== null);

    const criticalServices = ['api', 'db_postgres', 'redis'];
    const statuses = {};
    let allHealthy = true;

    for (const service of criticalServices) {
      const container = containers.find((c) => c.Service === service);
      if (container) {
        const isRunning = container.State === 'running';
        // Redis не имеет healthcheck, поэтому считаем его здоровым если он запущен
        // db_postgres должен быть healthy
        // api может быть running без healthcheck
        const isHealthy = 
          (service === 'redis' && isRunning) || 
          (service === 'api' && isRunning) ||
          (service === 'db_postgres' && container.Health === 'healthy');
        
        statuses[service] = {
          state: container.State,
          health: container.Health || (service === 'redis' ? 'no healthcheck' : 'N/A'),
          isRunning,
          isHealthy,
        };
        if (!isRunning || (!isHealthy && service === 'db_postgres')) {
          allHealthy = false;
        }
      } else {
        statuses[service] = { state: 'not found', isRunning: false, isHealthy: false };
        allHealthy = false;
      }
    }

    return { healthy: allHealthy, statuses };
  } catch (error) {
    return { healthy: false, statuses: {}, error: error.message };
  }
}

/**
 * Ожидание доступности Dify API с повторными попытками
 * @param {number} maxAttempts - Максимальное количество попыток
 * @param {number} delayMs - Задержка между попытками в миллисекундах
 * @param {string} dockerComposeCmd - Команда docker-compose
 * @returns {Promise<boolean>}
 */
async function waitForDify(maxAttempts = 60, delayMs = 2000, dockerComposeCmd = 'docker-compose') {
  console.log(colorize(`\n⏳ Waiting for Dify API to become available...`, 'yellow'));
  console.log(colorize(`   (max ${maxAttempts} attempts, ${delayMs / 1000}s delay = ${(maxAttempts * delayMs / 1000).toFixed(0)}s total)`, 'yellow'));

  // Даем контейнерам время на запуск перед первой проверкой
  console.log(colorize('   Giving containers time to start...', 'yellow'));
  await new Promise((resolve) => setTimeout(resolve, 5000));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Каждые 10 попыток проверяем статус контейнеров
    if (attempt % 10 === 0) {
      const health = await checkContainersHealth(dockerComposeCmd);
      if (!health.healthy) {
        console.log(colorize(`\n   ⚠ Container status check (attempt ${attempt}):`, 'yellow'));
        Object.entries(health.statuses).forEach(([service, status]) => {
          const statusColor = status.isHealthy ? 'green' : 'red';
          console.log(colorize(`      ${service}: ${status.state} (health: ${status.health})`, statusColor));
        });
      }
    }

    const check = await checkDifyApi();
    
    if (check.available) {
      console.log(colorize(`\n✓ Dify API is now available (attempt ${attempt}/${maxAttempts})`, 'green'));
      return true;
    }

    if (attempt < maxAttempts) {
      // Очищаем предыдущую строку и выводим новую
      process.stdout.write(`\r${colorize(`   Attempt ${attempt}/${maxAttempts}... ${check.message}`, 'yellow')}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.error(colorize(`\n❌ Dify API did not become available after ${maxAttempts} attempts`, 'red'));
  
  // Показываем финальный статус контейнеров
  console.log(colorize('\n📊 Final container status:', 'cyan'));
  const health = await checkContainersHealth(dockerComposeCmd);
  Object.entries(health.statuses).forEach(([service, status]) => {
    const statusColor = status.isHealthy ? 'green' : 'red';
    console.log(colorize(`   ${service}: ${status.state} (health: ${status.health})`, statusColor));
  });

  // Показываем последние логи API контейнера
  console.log(colorize('\n📋 Last API container logs:', 'cyan'));
  try {
    const { stdout } = await execAsync(`${dockerComposeCmd} logs api --tail 20`, {
      cwd: process.cwd(),
    });
    console.log(stdout.split('\n').slice(-10).join('\n'));
  } catch (error) {
    console.log(colorize(`   Could not fetch logs: ${error.message}`, 'yellow'));
  }

  return false;
}

/**
 * Запуск воркера
 * @param {string} mode - Режим запуска: 'dev' или 'start'
 * @returns {Promise<void>}
 */
function startWorker(mode = 'start') {
  return new Promise((resolve, reject) => {
    const command = mode === 'dev' ? 'npm' : 'node';
    const args = mode === 'dev' ? ['run', 'dev'] : ['src/index.js'];

    console.log(colorize(`\n🚀 Starting worker in ${mode} mode...`, 'cyan'));
    console.log(colorize(`   Command: ${command} ${args.join(' ')}`, 'yellow'));

    const workerProcess = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      cwd: process.cwd(),
    });

    let isShuttingDown = false;

    workerProcess.on('error', (error) => {
      console.error(colorize(`❌ Failed to start worker: ${error.message}`, 'red'));
      reject(error);
    });

    workerProcess.on('exit', (code, signal) => {
      if (isShuttingDown) {
        // Если мы сами инициировали завершение, это не ошибка
        console.log(colorize('✓ Worker stopped gracefully', 'green'));
        resolve();
      } else if (code === 0) {
        resolve();
      } else {
        // Коды 143 (SIGTERM) и 130 (SIGINT) - это нормальное завершение по сигналу
        if (code === 143 || code === 130 || signal === 'SIGTERM' || signal === 'SIGINT') {
          console.log(colorize('✓ Worker stopped', 'green'));
          resolve();
        } else {
          reject(new Error(`Worker exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`));
        }
      }
    });

    // Обработка сигналов для graceful shutdown
    const shutdownHandler = (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(colorize(`\n📛 Received ${signal}, stopping worker...`, 'yellow'));
      workerProcess.kill(signal);
      // Даем время воркеру на graceful shutdown
      setTimeout(() => {
        if (workerProcess.killed === false) {
          console.log(colorize('Force killing worker...', 'yellow'));
          workerProcess.kill('SIGKILL');
        }
      }, 5000);
    };

    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
    process.on('SIGINT', () => shutdownHandler('SIGINT'));
  });
}

/**
 * Главная функция
 */
async function main() {
  const args = process.argv.slice(2);
  const checkDify = args.includes('--check-dify') || args.includes('--auto-start-dify');
  const skipDifyCheck = args.includes('--skip-dify-check');
  // Определяем dev режим: либо через --dev флаг, либо через npm_lifecycle_event
  const devMode = args.includes('--dev') || process.env.npm_lifecycle_event?.includes('dev') || false;

  console.log(colorize('\n═══════════════════════════════════════════════════════', 'cyan'));
  console.log(colorize('  Ticket AI Worker - Startup Script', 'cyan'));
  console.log(colorize('═══════════════════════════════════════════════════════\n', 'cyan'));

  // Если указан --skip-dify-check, пропускаем проверку и сразу запускаем воркер
  if (skipDifyCheck) {
    console.log(colorize('⚠ Skipping Dify check (--skip-dify-check)', 'yellow'));
    await startWorker(devMode ? 'dev' : 'start');
    return;
  }

  // Проверяем доступность Dify API
  console.log(colorize('🔍 Checking Dify API availability...', 'cyan'));
  const difyCheck = await checkDifyApi();

  if (difyCheck.available) {
    console.log(colorize(`✓ ${difyCheck.message}`, 'green'));
    console.log(colorize('  Dify is ready, starting worker...\n', 'green'));
    await startWorker(devMode ? 'dev' : 'start');
    return;
  }

  // Dify недоступен
  console.log(colorize(`⚠ ${difyCheck.message}`, 'yellow'));

  // Если не указан флаг --check-dify, просто предупреждаем и запускаем воркер
  if (!checkDify) {
    console.log(colorize('\n⚠ Dify is not available, but continuing without it...', 'yellow'));
    console.log(colorize('  Worker will start but Dify-dependent features will not work.', 'yellow'));
    console.log(colorize('  Use --check-dify to automatically start Dify if unavailable.\n', 'yellow'));
    await startWorker(devMode ? 'dev' : 'start');
    return;
  }

  // Проверяем, запущены ли контейнеры Dify
  console.log(colorize('\n🔍 Checking Docker containers...', 'cyan'));
  
  let containers;
  try {
    containers = await checkDifyContainers();
  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      console.error(colorize(`\n❌ ${error.message}`, 'red'));
      console.error(colorize('  Please install Docker Compose to use automatic Dify startup', 'yellow'));
      console.error(colorize('  Or start Dify manually: docker-compose up -d', 'yellow'));
      process.exit(1);
    }
    throw error;
  }

  if (containers.running) {
    console.log(colorize(`✓ Found running Dify containers: ${containers.containers.join(', ')}`, 'green'));
    console.log(colorize('  Waiting for Dify API to become available...', 'yellow'));
  } else {
    console.log(colorize('⚠ No Dify containers are running', 'yellow'));
    console.log(colorize('  Starting Dify services...', 'yellow'));
    
    try {
      await startDifyServices(containers.dockerComposeCmd);
    } catch (error) {
      console.error(colorize(`\n❌ Failed to start Dify services: ${error.message}`, 'red'));
      console.error(colorize('  Please start Dify manually or check docker-compose configuration', 'yellow'));
      console.error(colorize(`  Try running: ${containers.dockerComposeCmd} up -d`, 'yellow'));
      process.exit(1);
    }
  }

  // Ждем пока Dify станет доступен (60 попыток по 2 секунды = 120 секунд максимум)
  const isAvailable = await waitForDify(60, 2000, containers.dockerComposeCmd);

  if (!isAvailable) {
    console.error(colorize('\n❌ Dify API did not become available', 'red'));
    console.error(colorize('  Worker will start but Dify-dependent features will not work.', 'yellow'));
    console.error(colorize('  Check Dify logs: docker-compose logs api', 'yellow'));
  }

  // Проверяем доступность Redis перед запуском воркера
  console.log(colorize('\n🔍 Checking Redis availability...', 'cyan'));
  const redisCheck = await checkRedis();
  
  if (!redisCheck.available) {
    console.error(colorize(`\n❌ ${redisCheck.message}`, 'red'));
    console.error(colorize('  Worker requires Redis to be running', 'yellow'));
    console.error(colorize('  Please ensure Redis is started and accessible', 'yellow'));
    
    // Если мы запускали Dify сервисы, Redis должен быть запущен
    if (checkDify) {
      console.error(colorize('  Redis should have been started with Dify services', 'yellow'));
      console.error(colorize('  Check Redis container: docker-compose ps redis', 'yellow'));
      console.error(colorize('  Check Redis logs: docker-compose logs redis', 'yellow'));
    }
    
    process.exit(1);
  }
  
  console.log(colorize(`✓ ${redisCheck.message}`, 'green'));

  // Запускаем воркер
  console.log(colorize('\n', 'reset'));
  await startWorker(devMode ? 'dev' : 'start');
}

// Запуск главной функции
main().catch((error) => {
  console.error(colorize(`\n❌ Startup failed: ${error.message}`, 'red'));
  if (error.stack) {
    console.error(colorize(error.stack, 'red'));
  }
  process.exit(1);
});

