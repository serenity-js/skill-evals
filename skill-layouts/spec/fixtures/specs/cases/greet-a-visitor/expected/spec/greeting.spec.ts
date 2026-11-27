import { strictEqual } from 'node:assert';

import { greetingFor } from '../src/greeting';

describe('greetingFor', () => {
    it('greets a visitor by name', () => {
        strictEqual(greetingFor({ name: 'Ada' }), 'Hello, Ada!');    // wrong: 'Hello, Ada!' => 'Hello, Grace!'
    });
});
