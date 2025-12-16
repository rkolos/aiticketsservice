const Redis = require('ioredis');
const { Queue } = require('bullmq');
require('dotenv').config();

async function testIntegration() {
  console.log('🧪 Testing Redis and BullMQ integration...');
  
  const redisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
  };
  
  try {
    // Test Redis connection
    const redis = new Redis(redisConfig);
    await redis.ping();
    console.log('✅ Redis connection: OK');
    await redis.disconnect();
    
    // Test BullMQ queue creation
    const queue = new Queue('test-queue', { connection: redisConfig });
    console.log('✅ BullMQ queue creation: OK');
    await queue.close();
    
    console.log('🎉 All basic integrations working!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Integration test failed:', error.message);
    process.exit(1);
  }
}

testIntegration();
