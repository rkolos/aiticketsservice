const { countTokens, estimateTotalTokens } = require('../../src/utils/tokenCounter');

describe('tokenCounter', () => {
  describe('countTokens', () => {
    test('должен подсчитывать токены для короткого текста', () => {
      const text = 'Привет, как дела?';
      const tokens = countTokens(text, 'gpt-4');
      expect(tokens).toBeGreaterThan(0);
      expect(typeof tokens).toBe('number');
    });

    test('должен подсчитывать токены для длинного текста', () => {
      const longText = 'Это очень длинный текст. '.repeat(100);
      const tokens = countTokens(longText, 'gpt-4');
      expect(tokens).toBeGreaterThan(10);
    });

    test('должен возвращать 0 для пустой строки', () => {
      expect(countTokens('', 'gpt-4')).toBe(0);
    });

    test('должен возвращать 0 для null', () => {
      expect(countTokens(null, 'gpt-4')).toBe(0);
    });

    test('должен возвращать 0 для undefined', () => {
      expect(countTokens(undefined, 'gpt-4')).toBe(0);
    });

    test('должен обрабатывать текст с кириллицей', () => {
      const text = 'Русский текст с кириллицей';
      const tokens = countTokens(text, 'gpt-4');
      expect(tokens).toBeGreaterThan(0);
    });

    test('должен обрабатывать текст с эмодзи', () => {
      const text = 'Текст с эмодзи 😀 🎉 🚀';
      const tokens = countTokens(text, 'gpt-4');
      expect(tokens).toBeGreaterThan(0);
    });

    test('должен обрабатывать специальные символы', () => {
      const text = 'Текст с символами: !@#$%^&*()_+-=[]{}|;:",.<>?';
      const tokens = countTokens(text, 'gpt-4');
      expect(tokens).toBeGreaterThan(0);
    });

    test('должен работать с разными моделями OpenAI', () => {
      const text = 'Тестовый текст';
      const models = ['gpt-4', 'gpt-3.5-turbo', 'gpt-4o'];

      models.forEach((model) => {
        const tokens = countTokens(text, model);
        expect(tokens).toBeGreaterThan(0);
        expect(typeof tokens).toBe('number');
      });
    });

    test('должен использовать fallback для неподдерживаемых моделей', () => {
      const text = 'Тестовый текст';
      const tokens = countTokens(text, 'unknown-model');
      expect(tokens).toBeGreaterThan(0);
      expect(typeof tokens).toBe('number');
    });

    test('должен обрабатывать нестроковые значения', () => {
      const tokens = countTokens(12345, 'gpt-4');
      expect(tokens).toBeGreaterThanOrEqual(0);
      expect(typeof tokens).toBe('number');
    });
  });

  describe('estimateTotalTokens', () => {
    test('должен подсчитывать токены для всех компонентов', () => {
      const result = estimateTotalTokens(
        'Контекст из базы знаний',
        'История переписки',
        'Вопрос пользователя',
        'gpt-4'
      );

      expect(result).toHaveProperty('context');
      expect(result).toHaveProperty('history');
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('systemPrompt');
      expect(result).toHaveProperty('total');

      expect(result.context).toBeGreaterThan(0);
      expect(result.history).toBeGreaterThan(0);
      expect(result.query).toBeGreaterThan(0);
      expect(result.systemPrompt).toBe(100);
      expect(result.total).toBe(
        result.context + result.history + result.query + result.systemPrompt
      );
    });

    test('должен обрабатывать null значения', () => {
      const result = estimateTotalTokens(null, null, null, 'gpt-4');

      expect(result.context).toBe(0);
      expect(result.history).toBe(0);
      expect(result.query).toBe(0);
      expect(result.total).toBeGreaterThanOrEqual(100); // Минимум системный промпт
    });

    test('должен обрабатывать пустые строки', () => {
      const result = estimateTotalTokens('', '', '', 'gpt-4');

      expect(result.context).toBe(0);
      expect(result.history).toBe(0);
      expect(result.query).toBe(0);
      expect(result.total).toBeGreaterThanOrEqual(100);
    });

    test('должен правильно суммировать токены', () => {
      const context = 'Длинный контекст '.repeat(10);
      const history = 'История '.repeat(20);
      const query = 'Вопрос';

      const result = estimateTotalTokens(context, history, query, 'gpt-4');

      expect(result.total).toBe(
        result.context + result.history + result.query + result.systemPrompt
      );
    });
  });
});

