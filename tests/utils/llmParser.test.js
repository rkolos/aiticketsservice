const { cleanLlmJson } = require('../../src/utils/llmParser');

describe('llmParser', () => {
  describe('cleanLlmJson', () => {
    test('должен удалять обертку ```json ... ```', () => {
      const input = '```json\n{"key": "value"}\n```';
      const result = cleanLlmJson(input);

      expect(result).toBe('{"key": "value"}');
      expect(() => JSON.parse(result)).not.toThrow();
    });

    test('должен удалять обертку ``` ... ``` (без указания языка)', () => {
      const input = '```\n{"key": "value"}\n```';
      const result = cleanLlmJson(input);

      expect(result).toBe('{"key": "value"}');
      expect(() => JSON.parse(result)).not.toThrow();
    });

    test('должен обрабатывать JSON без оберток', () => {
      const input = '{"key": "value", "number": 123}';
      const result = cleanLlmJson(input);

      expect(result).toBe(input);
      expect(() => JSON.parse(result)).not.toThrow();
    });

    test('должен удалять лишние пробелы и переносы строк', () => {
      const input = '```json\n  {\n    "key": "value"\n  }\n  ```';
      const result = cleanLlmJson(input);

      const parsed = JSON.parse(result);
      expect(parsed.key).toBe('value');
    });

    test('должен обрабатывать сложный JSON объект', () => {
      const input = '```json\n{"title": "Проблема", "sentiment": "negative", "data": [1, 2, 3]}\n```';
      const result = cleanLlmJson(input);

      const parsed = JSON.parse(result);
      expect(parsed.title).toBe('Проблема');
      expect(parsed.sentiment).toBe('negative');
      expect(Array.isArray(parsed.data)).toBe(true);
    });

    test('должен обрабатывать JSON с кириллицей', () => {
      const input = '```json\n{"message": "Привет, мир! 🌍"}\n```';
      const result = cleanLlmJson(input);

      const parsed = JSON.parse(result);
      expect(parsed.message).toBe('Привет, мир! 🌍');
    });

    test('должен выбрасывать ошибку для некорректного JSON', () => {
      const input = '```json\n{invalid json}\n```';

      expect(() => cleanLlmJson(input)).toThrow();
    });

    test('должен выбрасывать ошибку для нестрокового ввода', () => {
      expect(() => cleanLlmJson(null)).toThrow();
      expect(() => cleanLlmJson(undefined)).toThrow();
      expect(() => cleanLlmJson(123)).toThrow();
      expect(() => cleanLlmJson({})).toThrow();
    });

    test('должен обрабатывать JSON с вложенными объектами', () => {
      const input = '```json\n{"user": {"name": "John", "age": 30}, "meta": {"timestamp": "2024-01-01"}}\n```';
      const result = cleanLlmJson(input);

      const parsed = JSON.parse(result);
      expect(parsed.user.name).toBe('John');
      expect(parsed.user.age).toBe(30);
      expect(parsed.meta.timestamp).toBe('2024-01-01');
    });

    test('должен обрабатывать регистронезависимую обертку JSON', () => {
      const input = '```JSON\n{"key": "value"}\n```';
      const result = cleanLlmJson(input);

      expect(result).toBe('{"key": "value"}');
      expect(() => JSON.parse(result)).not.toThrow();
    });

    test('должен обрабатывать обертку с пробелами', () => {
      const input = '``` json \n{"key": "value"}\n ``` ';
      const result = cleanLlmJson(input);

      expect(result).toBe('{"key": "value"}');
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });
});

