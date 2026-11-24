import 'mocha';

import { Ensure, isGreaterThan } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { GetRequest, LastResponse, Send } from '@serenity-js/rest';

import { Role } from '../src/Role';

interface ExchangeRates {
    rates: { USD: number };
}

describe('Exchange rates', () => {

    it('give the latest rate from euros to US dollars as a positive number', () =>
        actorCalled(Role.Analyst).attemptsTo(
            Send.a(GetRequest.to('{{frankfurter}}/latest?base=EUR&symbols=USD')),
            Ensure.that(LastResponse.body<ExchangeRates>().rates.USD, isGreaterThan(0)),    // wrong: isGreaterThan(0) => isGreaterThan(1000)
        ));
});
