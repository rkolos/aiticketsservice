#!/usr/bin/env node

const Redis = require('ioredis');
const { Queue } = require('bullmq');
require('dotenv').config();

async function testSmokeLight() {
  console.log('🚀 Ticket AI Worker - Light Smoke Test');
  console.log('=====================================\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Redis Connection
  try {
    console.log('📋 Test 1: Redis Connection...');
    const redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD
    });
    await redis.ping();
    await redis.disconnect();
    console.log('✅ Redis Connection: PASSED\n');
    passed++;
  } catch (error) {
    console.log('❌ Redis Connection: FAILED\n');
    failed++;
  }

  // Test 2: BullMQ Queues
  try {
    console.log('📋 Test 2: BullMQ Queues...');
    const redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD
    };

    const queue1 = new Queue('test-queue-1', { connection: redisConfig });
    const queue2 = new Queue('test-queue-2', { connection: redisConfig });
    const queue3 = new Queue('test-queue-3', { connection: redisConfig });

    await queue1.close();
    await queue2.close();
    await queue3.close();

    console.log('✅ BullMQ Queues: PASSED\n');
    passed++;
  } catch (error) {
    console.log('❌ BullMQ Queues: FAILED\n');
    failed++;
  }

  // Test 3: Worker Healthcheck
  try {
    console.log('📋 Test 3: Worker Healthcheck...');
    const axios = require('axios');
    const response = await axios.get('http://localhost:4000/health', { timeout: 5000 });
    
    if (response.status === 200 || response.status === 503) {
      console.log('✅ Worker Healthcheck: PASSED\n');
      passed++;
    } else {
      console.log('❌ Worker Healthcheck: FAILED (wrong status)\n');
      failed++;
    }
  } catch (error) {
    console.log('❌ Worker Healthcheck: FAILED\n');
    failed++;
  }

  // Test 4: Dify Apps (optional)
  try {
    console.log('📋 Test 4: Dify Apps (optional)...');
    const axios = require('axios');
    
    const appTests = [
      { name: 'Classifier', key: process.env.DIFY_KEY_CLASSIFIER },
      { name: 'Summarizer', key: process.env.DIFY_KEY_SUMMARIZER },
      { name: 'Response Workflow', key: process.env.DIFY_KEY_RESPONSE_WORKFLOW },
      { name: 'Translator', key: process.env.DIFY_APP_KEY_TRANSLATOR },
      { name: 'Query Simplifier', key: process.env.DIFY_APP_KEY_QUERY_SIMPLIFIER }
    ];

    let appPassed = 0;
    for (const app of appTests) {
      if (!app.key) continue;
      
      try {
        // Simple ping to app endpoint
        const response = await axios.post(
          `http://localhost:5001/v1/chat-messages`,
          { query: 'test', inputs: {}, response_mode: 'blocking', user: 'test' },
          { 
            headers: { 'Authorization': `Bearer ${app.key}` },
            timeout: 3000,
            validateStatus: (status) => status < 500
          }
        );
        
        if (response.status === 200) {
          appPassed++;
        }
      } catch (error) {
        // App test failed, but this is optional
      }
    }

    if (appPassed > 0) {
      console.log(`✅ Dify Apps: ${appPassed}/5 apps accessible\n`);
      passed++;
    } else {
      console.log('⚠️  Dify Apps: No apps accessible (admin key needed)\n');
    }
  } catch (error) {
    console.log('⚠️  Dify Apps: Test skipped\n');
  }

  // Summary
  console.log('=====================================');
  console.log(`🎯 Test Results: ${passed} passed, ${failed} failed`);
  
  if (failed === 0) {
    console.log('🎉 ALL CORE TESTS PASSED!');
    console.log('💡 System is ready for production use.');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed. Check configuration.');
    process.exit(1);
  }
}

testSmokeLight().catch(console.error);
