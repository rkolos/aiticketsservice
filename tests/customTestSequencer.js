/**
 * Простой sequencer, сохраняющий порядок тестов как есть.
 * Это избавляет от зависимости @jest/test-sequencer в средах с ограничениями чтения node_modules.
 */
class CustomTestSequencer {
  sort(tests) {
    return tests;
  }

  cacheResults(tests, results) {
    // Jest ожидает наличие метода cacheResults в sequencer
    return results;
  }

  shard(tests, shardConfig) {
    if (!shardConfig || shardConfig.shardCount <= 1) {
      return tests;
    }
    const shardSize = Math.ceil(tests.length / shardConfig.shardCount);
    const start = shardSize * (shardConfig.shardIndex - 1);
    return tests.slice(start, start + shardSize);
  }
}

module.exports = CustomTestSequencer;

