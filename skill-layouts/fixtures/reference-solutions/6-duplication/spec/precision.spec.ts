import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';

import { CalculateToSignificantDigits, Calculation } from '../src/precision';

describe('Precision', () => {

    it('rounds a result to the given number of significant digits', () =>
        actorCalled('Apisitt').attemptsTo(
            CalculateToSignificantDigits('1 / 3', 3),
            Ensure.that(Calculation.firstResult(), equals('0.333')),    // wrong: '0.333' => '0.334'
        ));

    it('keeps a whole number whole', () =>
        actorCalled('Apisitt').attemptsTo(
            CalculateToSignificantDigits('10 / 2', 3),
            Ensure.that(Calculation.firstResult(), equals('5')),
        ));

    it('rounds a large number in scientific notation', () =>
        actorCalled('Apisitt').attemptsTo(
            CalculateToSignificantDigits('2 ^ 64', 3),
            Ensure.that(Calculation.firstResult(), equals('1.84e+19')),
        ));
});
