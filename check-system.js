#!/usr/bin/env node

const axios = require('axios');
require('dotenv').config();

async function checkSystem() {
  console.log('🔍 Проверка системы Ticket AI Worker + Dify...\n');

  const checks = [
    {
      name: 'Ticket AI Worker Healthcheck',
      url: 'http://localhost:4000/health',
      check: (data) => data.status === 'healthy' || (data.checks?.redis?.status === 'ok' && data.checks?.workers?.fastLane?.status === 'ok')
    },
    {
      name: 'Dify API Access',
      url: 'http://localhost:5001/v1/datasets',
      headers: { 'Authorization': `Bearer ${process.env.DIFY_KEY_ADMIN}` },
      check: (data, status) => status === 200 || (data.code !== 'unauthorized')
    },
    {
      name: 'Redis Connection',
      check: async () => {
        const Redis = require('ioredis');
        const redis = new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD
        });
        await redis.ping();
        await redis.disconnect();
        return true;
      }
    }
  ];

  for (const check of checks) {
    try {
      console.log(`📋 ${check.name}...`);
      
      let result;
      if (check.url) {
        const response = await axios.get(check.url, { 
          headers: check.headers,
          validateStatus: () => true 
        });
        result = check.check(response.data, response.status);
      } else {
        result = await check.check();
      }

      if (result) {
        console.log(`✅ ${check.name}: OK\n`);
      } else {
        console.log(`❌ ${check.name}: FAILED\n`);
      }
    } catch (error) {
      console.log(`❌ ${check.name}: ERROR - ${error.message}\n`);
    }
  }

  console.log('🎯 Проверка завершена!');
  console.log('💡 Если есть ошибки, проверьте API ключи в .env файле');
}

checkSystem().catch(console.error);
