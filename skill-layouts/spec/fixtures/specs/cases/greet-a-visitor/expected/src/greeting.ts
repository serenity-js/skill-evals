import type { Visitor } from './visitors';

export const greetingFor = (visitor: Visitor): string =>
    visitor.name === '' ? 'Hello!' : `Hello, ${ visitor.name }!`;
