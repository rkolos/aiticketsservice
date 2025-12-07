const { formatTicketHistory } = require('../../src/utils/historyFormatter');

describe('historyFormatter', () => {
  describe('formatTicketHistory', () => {
    test('должен преобразовывать массив сообщений в Markdown', () => {
      const messages = [
        { role: 'user', content: 'Здравствуйте, у меня проблема...' },
        { role: 'assistant', content: 'Здравствуйте! Расскажите подробнее...' },
        { role: 'user', content: 'Не могу войти в систему...' },
      ];

      const result = formatTicketHistory(messages);

      expect(result).toContain('User: Здравствуйте, у меня проблема...');
      expect(result).toContain('Assistant: Здравствуйте! Расскажите подробнее...');
      expect(result).toContain('User: Не могу войти в систему...');
    });

    test('должен обрабатывать уже отформатированный Markdown', () => {
      const markdown = `User: Здравствуйте

Assistant: Привет

User: Спасибо`;

      const result = formatTicketHistory(markdown);

      expect(result).toContain('User:');
      expect(result).toContain('Assistant:');
    });

    test('должен возвращать пустую строку для null', () => {
      expect(formatTicketHistory(null)).toBe('');
    });

    test('должен возвращать пустую строку для undefined', () => {
      expect(formatTicketHistory(undefined)).toBe('');
    });

    test('должен возвращать пустую строку для пустого массива', () => {
      expect(formatTicketHistory([])).toBe('');
    });

    test('должен игнорировать сообщения без role', () => {
      const messages = [
        { role: 'user', content: 'Вопрос' },
        { content: 'Без роли' },
        { role: 'assistant', content: 'Ответ' },
      ];

      const result = formatTicketHistory(messages);

      expect(result).toContain('User: Вопрос');
      expect(result).toContain('Assistant: Ответ');
      expect(result).not.toContain('Без роли');
    });

    test('должен игнорировать сообщения без content', () => {
      const messages = [
        { role: 'user', content: 'Вопрос' },
        { role: 'assistant' },
        { role: 'user', content: 'Вопрос 2' },
      ];

      const result = formatTicketHistory(messages);

      expect(result).toContain('User: Вопрос');
      expect(result).toContain('User: Вопрос 2');
    });

    test('должен нормализовать регистр ролей', () => {
      const messages = [
        { role: 'USER', content: 'Вопрос' },
        { role: 'ASSISTANT', content: 'Ответ' },
        { role: 'User', content: 'Вопрос 2' },
        { role: 'Assistant', content: 'Ответ 2' },
      ];

      const result = formatTicketHistory(messages);

      expect(result).toContain('User:');
      expect(result).toContain('Assistant:');
    });

    test('должен обрабатывать некорректный формат (не массив и не строка)', () => {
      const result = formatTicketHistory({ invalid: 'format' });
      expect(result).toBe('');
    });

    test('должен обрабатывать сообщения с пустым content', () => {
      const messages = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Ответ' },
      ];

      const result = formatTicketHistory(messages);

      // Сообщение с пустым content должно быть обработано, но может быть проигнорировано
      expect(result).toContain('Assistant: Ответ');
    });

    test('должен добавлять пустые строки между сообщениями', () => {
      const messages = [
        { role: 'user', content: 'Вопрос 1' },
        { role: 'assistant', content: 'Ответ 1' },
        { role: 'user', content: 'Вопрос 2' },
      ];

      const result = formatTicketHistory(messages);
      const lines = result.split('\n');

      // Должны быть пустые строки между сообщениями
      expect(lines.length).toBeGreaterThan(3);
    });
  });
});

