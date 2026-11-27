import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CHECKLIST, type ChangedFile, checkConventions, conventionsScore, type ProjectFiles } from '../src/conventions.ts';
import { checksOf } from '../src/runs.ts';
import { loadRequests } from '../src/requests.ts';
import { CALCULATION_JOB_RESULTS_RUNS, diffOf, workingCopyOf } from './fixture-runs.ts';

/** A file the run added, so every line of it is new. */
function added(content: string, path = 'spec/example.spec.ts'): ChangedFile {
    const lines = content.split('\n').length;
    return { path, content, addedLines: new Set(Array.from({ length: lines }, (_, index) => index + 1)) };
}

/** A file the run changed: the lines at `addedLines`, 1-based, are new, and the rest were there before. */
function changed(lines: string[], addedLines: number[], path = 'spec/example.spec.ts'): ChangedFile {
    return { path, content: lines.join('\n'), addedLines: new Set(addedLines) };
}

const verdictOf = (item: string, ...files: ChangedFile[]) => checkConventions(files).find(check => check.item === item)?.verdict;

/** The verdict on an item for a change to a project, whose files before and after the change are given. */
const verdictIn = (project: ProjectFiles, item: string, ...files: ChangedFile[]) =>
    checkConventions(files, project).find(check => check.item === item)?.verdict;

/** What the template's spec does: name its actor with a string. */
const templateSpec = { path: 'spec/math-js_api.spec.ts', content: "it('adds', () =>\n    actorCalled('Apisitt').attemptsTo(Send.a(GetRequest.to('/v4?expr=2+2'))))" };

describe('the checklist', () => {

    const { requests, heldBack } = loadRequests();
    const ids = [ ...requests, ...heldBack ].map(request => request.id);

    it("is built from the skills' practices, 1 to 9 in @serenity-js/core's and M1 to M7 in the Mocha draft, each item scored by the AST patterns or the reviewer", () => {
        expect(CHECKLIST.map(({ id, practice, scoredBy }) => `${ practice } ${ id } (${ scoredBy })`)).toEqual([
            '1 actor-names (patterns)',
            '2 one-action (reviewer)',
            '2 integrations-first (reviewer)',
            '2 clients-through-abilities (patterns)',
            '3 answerable-parameters (patterns)',
            '3 answering (patterns)',
            '4 names-without-the (patterns)',
            '4 question-names (reviewer)',
            '4 grouping (reviewer)',
            '5 repeating (patterns)',
            '5 awaiting (patterns)',
            '6 no-console-log (reviewer)',
            '6 no-debugging-left (reviewer)',
            '7 waiting (patterns)',
            '7 waits-in-tasks (reviewer)',
            '8 consistent-actor-names (patterns)',
            '8 structure (reviewer)',
            '8 no-copied-abstractions (reviewer)',
            '8 suggested-the-rest (reviewer)',
            '9 checks (patterns)',
            'M1 scenario-names (reviewer)',
            'M2 tasks-for-steps (reviewer)',
            'M3 cast (reviewer)',
            'M4 timeout (reviewer)',
            'M5 expectations (patterns)',
            'M6 no-clients-or-other-assertions (patterns)',
        ]);
    });

    it('says what each item asks for', () => {
        expect(Object.fromEntries(CHECKLIST.map(({ id, text }) => [ id, text ]))).toEqual({
            'actor-names': "the actors a change introduces are named after the role they play, from an enum or constants, not with a string in each scenario; a scenario added to a project that names its actors with strings, and follows it, is n/a",
            'one-action': "an interaction is one action from the actor's point of view; steps that make sense apart are separate interactions, composed in a task",
            'integrations-first': "uses the integration a Serenity/JS module the project already depended on provides, such as @serenity-js/rest for HTTP calls or @serenity-js/web for browser interactions, rather than writing its own interaction, question or ability for what it covers; core's building blocks, such as Wait, Ensure or Task, aren't integrations, and a change with nothing such a module covers, such as file access, is n/a",
            'clients-through-abilities': 'interactions and questions reach the system through an ability retrieved with Ability.as(actor), never through fs, fetch, axios, http or https directly',
            'answerable-parameters': "every parameter of a task, an interaction or a question, and of the constructor of an interaction object, is Answerable<T>, so that a caller can pass a question as easily as a static value; an Answerable placed in an array or an object literal passed on as data fails it, unless it's wrapped in Question.fromObject or Question.fromArray, or answered inside a Question.about",
            'answering': 'interactions and questions answer each Answerable into a constant, with await actor.answer(), rather than inline or in a chain of then calls',
            'names-without-the': 'the names of activities and questions leave out "the"; a name added to a file whose names have "the", and that follows them, is n/a',
            'question-names': 'questions are named with nouns, and those with a yes-or-no answer as isX()',
            'grouping': "tasks and questions about the same concept are grouped under one object named with the concept's noun: a domain thing, as in Calculation.result(), a UI widget, as in Basket.totalPrice(), or an API resource, as in Actions.status(jobId); a concept with only one task or question may stand alone, a change that adds two or more standalone ones about one concept fails, unless it follows the project's standalone ones about it, and a change that adds no tasks or questions is n/a",
            'repeating': 'activities repeated for each item of a list use List.of(…).forEach, not Array.forEach with an async callback',
            'awaiting': 'every attemptsTo is awaited or returned',
            'no-console-log': 'no console.log, or call of another console method, added; it applies to every change that adds or changes code, and is n/a only for a change that adds none',
            'no-debugging-left': "nothing left behind that the change doesn't need: debugging code, such as Log.the(…) or a StreamReporter, or files its own test runs produced; console calls are no-console-log's to score; it applies to every change that adds or changes code, and is n/a only for a change that adds none",
            'waiting': 'waits use Wait.until, never setTimeout or a fixed pause such as Wait.for',
            'waits-in-tasks': 'a task waits for the outcome it causes, with Wait.until or Ensure.eventually inside the task; a Wait.until or Ensure.eventually in a scenario for an outcome a task caused fails it',
            'consistent-actor-names': "the actors a change adds are named the way the project's specs already name theirs, or one new way across every spec, such as a shared Role enum every spec imports; never two ways side by side, such as a Role enum in one spec next to 'Apisitt' in the others",
            'structure': "follows the structure the project already uses, or with nothing to follow, the simplest that fits, and restructures only the code the change touches; it fails a change that introduces a second way of doing what the project already does, and passes one that follows the project and suggests the new way, or one that applies the new way consistently across the project and says so",
            'no-copied-abstractions': "didn't copy poor abstractions into new code",
            'suggested-the-rest': "restructured only what the change touches, and proposed what to do about the rest: where the code the change works in has problems related to the request that the change leaves alone, such as duplication, an unused or overlapping helper, or ungrouped activities about one concept, the reply names each and proposes what to do, leaving the decision to the user; restructuring them unasked fails it, and a change into code without such problems is n/a",
            'checks': 'outcomes that are already there are checked with Ensure.that, and those that arrive later with Ensure.eventually, not a Wait.until followed by an Ensure.that',
            'scenario-names': 'the describe is named after the feature, and the it after the behaviour, so the report reads as a specification',
            'tasks-for-steps': "steps are tasks in the business domain's language, and the steps scenarios repeat are extracted into a task",
            'cast': 'actors get their abilities in the Cast, and the configuration a test environment needs comes from environment variables',
            'timeout': "Mocha's timeout leaves time for every activity in a scenario, including its waits",
            'expectations': 'checks compare answers with expectations from @serenity-js/assertions, rather than answering the question in the scenario',
            'no-clients-or-other-assertions': 'it() and describe() bodies reach clients only through abilities, outside the interactions and questions that clients-through-abilities checks, and no code uses an assertion library other than @serenity-js/assertions',
        });
    });

    it('says which requests exercise each item, all of them requests of the evaluation', () => {
        expect(Object.fromEntries(CHECKLIST.map(({ id, requests: exercisedBy }) => [ id, exercisedBy.map(request => request.split('-')[0]).join(' ') ]))).toEqual({
            'actor-names': '1 4 9 10 12 13',
            'one-action': '9',
            'clients-through-abilities': '9',
            'integrations-first': '1 2 4 6 10 11 13',
            'answerable-parameters': '2 3 6 7 9 11',
            'answering': '3 9',
            'names-without-the': '2 3 6 7 9 11 12',
            'question-names': '3 9 12',
            'grouping': '9',
            'repeating': '10',
            'awaiting': '1 4 9 10 11 12 13',
            'no-console-log': '5 9',
            'no-debugging-left': '5 9',
            'waiting': '5 9',
            'waits-in-tasks': '5 9',
            'consistent-actor-names': '1 4 9 10 11 12 13',
            'structure': '1 2 3 4 5 6 7 9 10 11 12 13',
            'no-copied-abstractions': '6 11',
            'suggested-the-rest': '6 11',
            'checks': '1 2 3 4 5 6 9 10 11 12 13',
            'scenario-names': '1 4 7 9 10 11 12 13',
            'tasks-for-steps': '2 6 11',
            'cast': '4 9',
            'timeout': '5',
            'expectations': '1 3 10 11 12 13',
            'no-clients-or-other-assertions': '1 4 9 10 11 13',
        });
        expect(CHECKLIST.flatMap(item => item.requests).filter(request => ! ids.includes(request))).toEqual([]);
    });

    it('has no item that no request exercises', () => {
        expect(CHECKLIST.filter(item => item.requests.length === 0)).toEqual([]);
    });

    it("leaves the reviewer's items to the reviewer: the AST patterns say n/a, even for code they'd be about", () => {
        const code = added([
            "export class ReadFiles extends Ability { static from(directory: string) { return new ReadFiles(directory) } }",
            "console.log('here')",
            "Log.the(Result())",
        ].join('\n'));
        const reviewers = CHECKLIST.filter(item => item.scoredBy === 'reviewer').map(item => item.id);

        expect(checkConventions([ code ]).filter(check => reviewers.includes(check.item))).toEqual(reviewers.map(item => ({ item, verdict: 'n/a', evidence: [] })));
    });
});

describe('checkConventions', () => {

    it('checks every item of the checklist, in order', () => {
        expect(checkConventions([]).map(check => check.item)).toEqual(CHECKLIST.map(item => item.id));
    });

    describe('actor-names', () => {
        it.each([
            [ 'an enum',     'actorCalled(Role.Cardholder).attemptsTo(ReportALostCard())' ],
            [ 'a constant',  'actorCalled(cardholder).attemptsTo(ReportALostCard())' ],
        ])('passes an actor named with %s', (_, code) => {
            expect(verdictOf('actor-names', added(code))).toBe('pass');
        });

        it.each([
            [ 'a string',          "actorCalled('Alice').attemptsTo(ReportALostCard())" ],
            [ 'a template string', 'actorCalled(`Alice`).attemptsTo(ReportALostCard())' ],
        ])('fails an actor named with %s in the scenario', (_, code) => {
            expect(verdictOf('actor-names', added(code))).toBe('fail');
        });

        it("doesn't apply to a change that calls no actor", () => {
            expect(verdictOf('actor-names', added('const timeout = 10_000'))).toBe('n/a');
        });

        it('leaves n/a a scenario added to a file that names its actors with strings, and follows that way', () => {
            expect(verdictOf('actor-names', changed([
                "it('rounds a third', () => actorCalled('Apisitt').attemptsTo(CalculateToSignificantDigits('1 / 3', 3)))",
                "it('rounds two thirds', () => actorCalled('Apisitt').attemptsTo(CalculateToSignificantDigits('2 / 3', 3)))",
            ], [ 2 ]))).toBe('n/a');
        });

        it("doesn't apply to a new spec that names its actor with a string, in a project whose specs name theirs with strings", () => {
            const newSpec = added("it('subtracts', () =>\n    actorCalled('Apisitt').attemptsTo(Subtract(5, 3)))", 'spec/subtraction.spec.ts');

            expect(verdictIn({ before: [ templateSpec ], after: [ templateSpec, newSpec ] }, 'actor-names', newSpec)).toBe('n/a');
        });

        it('fails a scenario that names its actor with a string, in a file that names its actors from an enum', () => {
            expect(verdictOf('actor-names', changed([
                "it('rounds a third', () => actorCalled(Role.Analyst).attemptsTo(CalculateToSignificantDigits('1 / 3', 3)))",
                "it('rounds two thirds', () => actorCalled('Apisitt').attemptsTo(CalculateToSignificantDigits('2 / 3', 3)))",
            ], [ 2 ]))).toBe('fail');
        });
    });

    describe('answerable-parameters', () => {
        it.each([
            [ 'a task',          'const CallBank = (phoneNumber: Answerable<string>) =>\n    Task.where(the`#actor calls the bank on ${ phoneNumber }`, Dial(phoneNumber))' ],
            [ 'an interaction',  'const Press = (key: Answerable<string>) => Interaction.where(the`#actor presses ${ key }`, async actor => {\n    const pressed = await actor.answer(key)\n})' ],
            [ 'a meta-question', "const Voicemails = () => Question.about('voicemails', actor => Phone.as(actor).voicemails(),\n    (line: Answerable<string>) => Question.about('voicemails', actor => Phone.as(actor).voicemails()))" ],
            [ 'a function',      'function EnterCardNumber(cardNumber: Answerable<string>): Task {\n    return Task.where(the`#actor enters ${ cardNumber }`, Press(cardNumber))\n}' ],
        ])('passes %s whose parameters are all Answerable', (_, code) => {
            expect(verdictOf('answerable-parameters', added(code))).toBe('pass');
        });

        it.each([
            [ 'a task',                'const CallBank = (phoneNumber: string) =>\n    Task.where(the`#actor calls the bank on ${ phoneNumber }`, Dial(phoneNumber))' ],
            [ 'an interaction',        'const Press = (key: string) => Interaction.where(the`#actor presses ${ key }`, async actor => {\n    await Phone.as(actor).press(key)\n})' ],
            [ 'a question',            "const Voicemails = (line: string) => Question.about('voicemails', actor => Phone.as(actor).voicemails(line))" ],
            [ 'a transformed question', "const AreaCode = (phoneNumber: QuestionAdapter<string>) =>\n    phoneNumber.slice(1, 4).as(Number).describedAs('the area code')" ],
            [ 'a task with a type',    'const CallBank = (phoneNumber: Answerable<string>, extension: number): Task =>\n    Sequence(phoneNumber, extension)' ],
        ])('fails %s with a parameter that isn\'t Answerable', (_, code) => {
            expect(verdictOf('answerable-parameters', added(code))).toBe('fail');
        });

        it.each([
            [ 'an array of Answerables',  'Answerable<string>[]',               'fail' ],
            [ 'a record of Answerables',  'Record<string, Answerable<number>>', 'fail' ],
            [ 'an optional Answerable',   'Answerable<string> | undefined',     'pass' ],
            [ 'a namespaced Answerable',  'core.Answerable<string>',            'pass' ],
        ])('checks the parameter\'s own type: %s, %s, gives %s', (_, type, expected) => {
            expect(verdictOf('answerable-parameters', added(`const Calculate = (expressions: ${ type }) =>\n    Task.where(the\`#actor calculates\`, Send.a(Request(expressions)))`))).toBe(expected);
        });

        it.each([
            [ 'fails',  'string',             'fail' ],
            [ 'passes', 'Answerable<string>', 'pass' ],
        ])('%s an interaction object whose constructor takes a %s', (_, type, expected) => {
            expect(verdictOf('answerable-parameters', added([
                'export class Helpline {',
                `    constructor(private readonly phoneNumber: ${ type }) {`,
                '    }',
                '',
                '    call = () =>',
                '        Task.where(the`#actor calls the helpline on ${ this.phoneNumber }`, Dial(this.phoneNumber))',
                '}',
            ].join('\n')))).toBe(expected);
        });

        it.each([
            [ 'a function that returns no activity', 'const format = (value: number) => value.toFixed(2)' ],
            [ "a class that's no interaction object", 'class Cache {\n    constructor(private readonly size: number) {\n    }\n}' ],
            [ 'the callback of an activity',         "const Status = () => Question.about('the status', (actor: AnswersQuestions & UsesAbilities) => RunJobs.as(actor).status())" ],
        ])("doesn't apply to %s", (_, code) => {
            expect(verdictOf('answerable-parameters', added(code))).toBe('n/a');
        });

        it.each([
            [ 'an object literal', 'fail', 'Send.a(PostRequest.to(\'/v4\').with({ expr: [ expression ], precision }))' ],
            [ 'an array literal', 'fail', 'StartConferenceCall([ expression, \'0800\' ])' ],
            [ 'Question.fromObject', 'pass', 'Send.a(PostRequest.to(\'/v4\').with(Question.fromObject({ expr: Question.fromArray([ expression ]), precision })))' ],
            [ 'Question.fromArray', 'pass', 'StartConferenceCall(Question.fromArray([ expression, \'0800\' ]))' ],
            [ 'a Question.about that answers them', 'pass', "Send.a(PostRequest.to('/v4').with(Question.about('the calculation', async actor => ({\n    expr: [ await actor.answer(expression) ],\n    precision: await actor.answer(precision),\n}))))" ],
        ])('passes Answerable parameters on as data in %s, which gives %s', (_, expected, data) => {
            expect(verdictOf('answerable-parameters', added([
                'const Calculate = (expression: Answerable<string>, precision: Answerable<number>) =>',
                '    Task.where(the`#actor calculates ${ expression } to ${ precision } significant digits`,',
                `        ${ data },`,
                '    )',
            ].join('\n')))).toBe(expected);
        });

        it.each([
            [ 'fails', 'with(data)',                      'fail' ],
            [ 'passes', 'with(Question.fromObject(data))', 'pass' ],
        ])("follows a literal assigned to a constant first to where it's passed on, so it %s .%s", (_, use, expected) => {
            expect(verdictOf('answerable-parameters', added([
                'const Calculate = (expression: Answerable<string>, precision: Answerable<number>) => {',
                '    const data = { expr: [ expression ], precision }',
                '    return Task.where(the`#actor calculates ${ expression } to ${ precision } significant digits`,',
                `        Send.a(PostRequest.to('/v4').${ use }),`,
                '    )',
                '}',
            ].join('\n')))).toBe(expected);
        });

        it("doesn't mistake a callback's own parameter, which reuses the constant's name, for the constant", () => {
            expect(verdictOf('answerable-parameters', added([
                'const Calculate = (expression: Answerable<string>) => {',
                '    const data = { expr: [ expression ] }',
                '    return Task.where(the`#actor calculates ${ expression }`,',
                '        Send.a(PostRequest.to(\'/v4\').with(Question.fromObject(data).as(data => JSON.stringify(data)))),',
                '    )',
                '}',
            ].join('\n')))).toBe('pass');
        });

        it("doesn't mind an Answerable in a literal that isn't passed on as data", () => {
            expect(verdictOf('answerable-parameters', added([
                'const CallBoth = (one: Answerable<string>, other: Answerable<string>) =>',
                '    Task.where(the`#actor calls ${ one } and ${ other }`, ...[ one, other ].map(phoneNumber => Dial(phoneNumber)))',
            ].join('\n')))).toBe('pass');
        });

        it.each([
            [ '5a6adab8', 'fail', 'src/precision.ts:24: { expr: [ expression ], precision }' ],
            [ 'be977ebc', 'pass', 'src/precision.ts:19: expression: Answerable<string>' ],
            [ 'a185af41', 'pass', 'src/precision.ts:22: expression: Answerable<string>' ],
        ] as const)("in run %s of the focused round, request 11, it gives %s for the Answerables it passes on as data", (run, verdict, evidence) => {
            const directory = workingCopyOf(run);
            try {
                const check = checksOf(directory, diffOf(run)).find(({ item }) => item === 'answerable-parameters')!;

                expect(check.verdict).toBe(verdict);
                expect(check.evidence).toContain(evidence);
            }
            finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });

        it("doesn't apply to the parameters of a task the run didn't add", () => {
            expect(verdictOf('answerable-parameters', changed([
                'export const PostAndCheck = (expression: string, precision: number) =>',
                '    Task.where(the`#actor posts ${ expression }`,',
                '        Send.a(PostRequest.to(\'/v4\')),',
                '    )',
            ], [ 3 ]))).toBe('n/a');
        });

        it.each([
            [ '89a97301', 'fail', 'src/precision.ts:22: expression: string' ],
            // its parameters are Answerable, but it passes them on in an object literal
            [ 'fb87227b', 'fail', 'src/precision.ts:19: { expr: [ expression ], precision: significantDigits }' ],
        ] as const)('in run %s of the eighth pilot, request 11, it gives %s', (run, verdict, evidence) => {
            const directory = workingCopyOf(run);
            try {
                const check = checksOf(directory, diffOf(run)).find(({ item }) => item === 'answerable-parameters')!;

                expect(check.verdict).toBe(verdict);
                expect(check.evidence).toContain(evidence);
            }
            finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });
    });

    describe('clients-through-abilities', () => {
        it('passes an interaction that reaches the system through an ability', () => {
            expect(verdictOf('clients-through-abilities', added([
                'const Press = (key: Answerable<string>) => Interaction.where(the`#actor presses ${ key }`, async actor => {',
                '    const pressed = await actor.answer(key)',
                '    await MakePhoneCalls.as(actor).press(pressed)',
                '})',
            ].join('\n')))).toBe('pass');
        });

        it.each([
            [ 'the file system, in an interaction', "import { writeFileSync } from 'fs'\nconst Submit = (job: Answerable<string>) => Interaction.where(the`#actor submits ${ job }`, async actor => {\n    writeFileSync('/jobs/1', await actor.answer(job))\n})" ],
            [ 'fetch, in a question',               "const Rate = () => Question.about('the rate', async actor => {\n    const response = await fetch('https://api.frankfurter.app/latest')\n    return response.json()\n})" ],
            [ 'axios, in a question',               "import axios from 'axios'\nconst Rate = () => Question.about('the rate', async actor => (await axios.get('/latest')).data)" ],
            [ 'https, in an interaction',           "import * as https from 'https'\nconst Ping = () => Interaction.where(the`#actor pings`, async actor => {\n    https.get('https://example.org')\n})" ],
        ])('fails %s', (_, code) => {
            expect(verdictOf('clients-through-abilities', added(code))).toBe('fail');
        });

        it('fails an HTTP client that a question uses, though an ability imports it too, and says where', () => {
            const verdict = checkConventions([ added([
                "import axios from 'axios'",
                'export class CheckExchangeRates extends Ability { latest() { return axios.get(\'/latest\') } }',
                "export const Rate = () => Question.about('the rate', async actor => (await axios.get('/latest')).data)",
            ].join('\n')) ]).find(check => check.item === 'clients-through-abilities')!;

            expect(verdict).toMatchObject({ verdict: 'fail', evidence: [ "spec/example.spec.ts:3: axios.get('/latest')" ] });
        });

        it('leaves the clients an ability wraps alone, which is where they belong', () => {
            expect(verdictOf('clients-through-abilities', added([
                "import { readFileSync } from 'fs'",
                'export class UseJobFiles extends Ability {',
                '    resultOf(name: string): string { return readFileSync(name, \'utf8\') }',
                '}',
            ].join('\n')))).toBe('n/a');
        });

        it.each(CALCULATION_JOB_RESULTS_RUNS.map(run => [ run, run === 'b002da42' ? 'fail' : 'pass' ] as const))(
            'in run %s of the focused round, request 9, it gives %s',
            (run, verdict) => {
                const directory = workingCopyOf(run);
                try {
                    expect(checksOf(directory, diffOf(run)).find(({ item }) => item === 'clients-through-abilities')!.verdict).toBe(verdict);
                }
                finally {
                    rmSync(directory, { recursive: true, force: true });
                }
            },
        );
    });

    describe('consistent-actor-names', () => {
        it("passes actors named with strings, in a project whose specs name theirs with strings", () => {
            const added_ = added("it('subtracts', () =>\n    actorCalled('Apisitt').attemptsTo(Subtract(5, 3)))", 'spec/subtraction.spec.ts');

            expect(verdictIn({ before: [ templateSpec ], after: [ templateSpec, added_ ] }, 'consistent-actor-names', added_)).toBe('pass');
        });

        it('passes a shared Role enum that every spec imports, the project\'s specs included', () => {
            const withRole = "import { Role } from '../src/Role'\nit('calculates', () =>\n    actorCalled(Role.Analyst).attemptsTo(Calculate('2 + 2')))";
            const changedSpec = added(withRole, 'spec/math-js_api.spec.ts');
            const newSpec = added(withRole, 'spec/units.spec.ts');

            expect(verdictIn({ before: [ templateSpec ], after: [ changedSpec, newSpec ] }, 'consistent-actor-names', changedSpec, newSpec)).toBe('pass');
        });

        it("fails a shared Role enum in a new spec, while the project's specs still name their actors with strings", () => {
            const newSpec = added("import { Role } from '../src/Role'\nit('converts', () =>\n    actorCalled(Role.Analyst).attemptsTo(Convert('5 inch to cm')))", 'spec/units.spec.ts');

            expect(verdictIn({ before: [ templateSpec ], after: [ templateSpec, newSpec ] }, 'consistent-actor-names', newSpec)).toBe('fail');
        });

        it('fails a Role enum each spec declares for itself, which is a way of its own in each', () => {
            const specIn = (path: string) => added("enum Role { Analyst = 'Apisitt, the analyst' }\nit('calculates', () =>\n    actorCalled(Role.Analyst).attemptsTo(Calculate('2 + 2')))", path);
            const one = specIn('spec/one.spec.ts');
            const other = specIn('spec/other.spec.ts');

            expect(verdictIn({ before: [], after: [ one, other ] }, 'consistent-actor-names', one, other)).toBe('fail');
        });

        it("doesn't apply to a change that adds no actors", () => {
            const code = added('const timeout = 10_000');

            expect(verdictIn({ before: [ templateSpec ], after: [ templateSpec, code ] }, 'consistent-actor-names', code)).toBe('n/a');
        });

        it.each([
            [ '89a97301', 'pass', "spec/precision.spec.ts:42: actorCalled('Apisitt')" ],
            [ 'fb87227b', 'fail', 'spec/precision.spec.ts:46: actorCalled(Role.Mathematician)' ],
        ] as const)('in run %s of the eighth pilot, request 11, it gives %s', (run, verdict, evidence) => {
            const directory = workingCopyOf(run);
            try {
                const check = checksOf(directory, diffOf(run)).find(({ item }) => item === 'consistent-actor-names')!;

                expect(check.verdict).toBe(verdict);
                expect(check.evidence).toEqual([ evidence ]);
            }
            finally {
                rmSync(directory, { recursive: true, force: true });
            }
        });
    });

    describe('answering', () => {
        it('passes an interaction that answers each Answerable into a constant', () => {
            expect(verdictOf('answering', added([
                'const Dial = (phoneNumber: Answerable<string>) =>',
                '    Interaction.where(the`#actor dials ${ phoneNumber }`, async actor => {',
                '        const number = await actor.answer(phoneNumber)',
                '        await MakePhoneCalls.as(actor).dial(number)',
                '    })',
            ].join('\n')))).toBe('pass');
        });

        it.each([
            [ 'an answer passed straight on', 'const Dial = (n: Answerable<string>) => Interaction.where(the`#actor dials ${ n }`, async actor => {\n    await MakePhoneCalls.as(actor).dial(await actor.answer(n))\n})' ],
            [ 'a chain of then calls',        "const Voicemails = (line: Answerable<string>) => Question.about('voicemails', actor =>\n    actor.answer(line).then(answered => MakePhoneCalls.as(actor).voicemails(answered))\n)" ],
        ])('fails %s, in an interaction or a question', (_, code) => {
            expect(verdictOf('answering', added(code))).toBe('fail');
        });

        it("doesn't apply to an interaction or a question that answers nothing", () => {
            expect(verdictOf('answering', added("const Status = () => Question.about('the status', actor => RunJobs.as(actor).status())"))).toBe('n/a');
        });
    });

    describe('names-without-the', () => {
        it('passes activities and questions named without "the"', () => {
            expect(verdictOf('names-without-the', added([
                'const CallBank = () => Task.where(the`#actor calls the bank`, Dial(number))',
                "const LastJob = { status: () => Question.about('the status of the last job', actor => 1) }",
            ].join('\n')))).toBe('pass');
        });

        it.each([
            [ 'a task',                     'const CallTheBank = () => Task.where(the`#actor calls the bank`, Dial(number))' ],
            [ 'a question',                 "const ResultOfTheLastJob = () => Question.about('the result of the last job', actor => 1)" ],
            [ 'an interaction',             'const PressTheKey = () => Interaction.where(the`#actor presses the key`, async actor => {})' ],
            [ 'a question in a group',      "const Job = { theResult: () => Question.about('the result', actor => 1) }" ],
            [ 'a name that starts with it', "const TheResult = () => Question.about('the result', actor => 1)" ],
        ])('fails %s named with "the"', (_, code) => {
            expect(verdictOf('names-without-the', added(code))).toBe('fail');
        });

        it('leaves n/a a name with "the" added to a file whose names have "the", and that follows them', () => {
            expect(verdictOf('names-without-the', changed([
                "const ResultOfTheLastJob = () => Question.about('the result of the last job', actor => 1)",
                "const StatusOfTheLastJob = () => Question.about('the status of the last job', actor => 1)",
            ], [ 2 ]))).toBe('n/a');
        });

        it('fails a name with "the" added to a file whose names leave it out', () => {
            expect(verdictOf('names-without-the', changed([
                "const ResultOfLastJob = () => Question.about('the result of the last job', actor => 1)",
                "const StatusOfTheLastJob = () => Question.about('the status of the last job', actor => 1)",
            ], [ 2 ]))).toBe('fail');
        });

        it('passes names that only contain the letters, like Theme or OtherJob', () => {
            expect(verdictOf('names-without-the', added("const Theme = () => Question.about('the theme', actor => 1)\nconst OtherJob = () => Question.about('the other job', actor => 1)"))).toBe('pass');
        });
    });

    it('fails a question made by transforming another, named with "the", as request 11\'s answer could name it', () => {
        expect(verdictOf('names-without-the', added([
            'const SumOfTheResults = () =>',
            '    LastResponse.body<{ result: string[] }>().result',
            '        .as(results => results.reduce((total, result) => total + Number(result), 0))',
            "        .describedAs('the sum of the results');",
        ].join('\n')))).toBe('fail');
    });

    it('passes a question made by transforming another, named without "the"', () => {
        expect(verdictOf('names-without-the', added([
            'const SumOfResults = () =>',
            '    LastResponse.body<{ result: string[] }>().result',
            '        .as(results => results.reduce((total, result) => total + Number(result), 0))',
            "        .describedAs('the sum of the results');",
        ].join('\n')))).toBe('pass');
    });

    describe('repeating', () => {
        it('passes activities repeated with List.of().forEach', () => {
            expect(verdictOf('repeating', added('List.of(examples).forEach(({ actor, item }) =>\n    actor.attemptsTo(Check(item)),\n)'))).toBe('pass');
        });

        it('fails Array.forEach with an async callback', () => {
            expect(verdictOf('repeating', added('examples.forEach(async example => {\n    await actor.attemptsTo(Check(example))\n})'))).toBe('fail');
        });

        it("doesn't apply to forEach with a callback that isn't async", () => {
            expect(verdictOf('repeating', added('names.forEach(name => console.log(name))'))).toBe('n/a');
        });
    });

    describe('awaiting', () => {
        it.each([
            [ 'awaited',                              'await actorCalled(Role.Cardholder).attemptsTo(ReportALostCard())' ],
            [ 'returned',                             "it('works', () => { return actorCalled(Role.Cardholder).attemptsTo(ReportALostCard()) })" ],
            [ "an arrow function's body",             "it('works', () => actorCalled(Role.Cardholder).attemptsTo(ReportALostCard()))" ],
        ])('passes attemptsTo %s', (_, code) => {
            expect(verdictOf('awaiting', added(code))).toBe('pass');
        });

        it('fails attemptsTo whose promise nobody waits for', () => {
            expect(verdictOf('awaiting', added("it('works', async () => {\n    actorCalled(Role.Cardholder).attemptsTo(ReportALostCard())\n})"))).toBe('fail');
        });
    });

    describe('waiting', () => {
        it.each([
            [ 'Wait.until',                             "Wait.until(LastJob.status(), equals('done'))" ],
            [ 'Wait.upTo().until() with its polling',   "Wait.upTo(Duration.ofSeconds(30)).until(LastJob.status(), equals('done')).pollingEvery(Duration.ofSeconds(1))" ],
        ])('passes %s', (_, code) => {
            expect(verdictOf('waiting', added(code))).toBe('pass');
        });

        it.each([
            [ 'a fixed wait',              'Wait.for(Duration.ofSeconds(1))' ],
            [ 'a sleep in a scenario',     "it('waits', async () => { await new Promise(resolve => setTimeout(resolve, 1000)) })" ],
            [ 'a sleep in an interaction', 'const Sleep = () => Interaction.where(the`#actor sleeps`, () => new Promise(resolve => setTimeout(resolve, 1000)))' ],
        ])('fails %s', (_, code) => {
            expect(verdictOf('waiting', added(code))).toBe('fail');
        });

        it('passes setTimeout in an ability, or in the system under test, which are not the test waiting', () => {
            expect(verdictOf('waiting', added([
                'export class CalculationJobs {',
                '    submit(expression: string) { setTimeout(() => this.results.set(expression, 4), 500) }',
                '}',
                "it('calculates in the background', () => actorCalled(Role.Analyst).attemptsTo(Wait.until(LastJob.status(), equals('done'))))",
            ].join('\n')))).toBe('pass');
        });
    });

    describe('checks', () => {
        it.each([
            [ 'Ensure.that',       "Ensure.that(LastJob.result(), equals('4'))" ],
            [ 'Ensure.eventually', "Ensure.eventually(LastJob.result(), equals('4'))" ],
        ])('passes a check with %s', (_, code) => {
            expect(verdictOf('checks', added(code))).toBe('pass');
        });

        it.each([
            [ 'Wait.until',                  "actor.attemptsTo(\n    Wait.until(LastJob.status(), equals('done')),\n    Ensure.that(LastJob.result(), equals('4')),\n)" ],
            [ 'Wait.upTo().until()',         "actor.attemptsTo(\n    Wait.upTo(Duration.ofSeconds(5)).until(ResultFile(name), isPresent()),\n    Ensure.that(ResultFile(name), equals('7')),\n)" ],
        ])('fails a %s followed by an Ensure.that, which Ensure.eventually does in one', (_, code) => {
            expect(verdictOf('checks', added(code))).toBe('fail');
        });

        it('passes a wait in a task, and a check in the scenario that performs it', () => {
            expect(verdictOf('checks', added([
                "const CalculateInBackground = (expression: Answerable<string>) => Task.where(the`#actor calculates ${ expression }`, SubmitAJob(expression), Wait.until(LastJob.status(), equals('done')))",
                "actor.attemptsTo(CalculateInBackground('2 + 2'), Ensure.that(LastJob.result(), equals('4')))",
            ].join('\n')))).toBe('pass');
        });
    });

    describe('expectations', () => {
        it('passes checks that compare answers with expectations', () => {
            expect(verdictOf('expectations', added("Ensure.that(LastResponse.body<number>(), equals(4))"))).toBe('pass');
        });

        it('fails a question answered in the scenario, to compare the answer', () => {
            expect(verdictOf('expectations', added("it('works', async () => {\n    const body = await actorCalled(Role.Analyst).answer(LastResponse.body())\n})"))).toBe('fail');
        });

        it('passes answering a question in an interaction, which is where answers are used', () => {
            expect(verdictOf('expectations', added('const Dial = (n: Answerable<string>) => Interaction.where(the`#actor dials ${ n }`, async actor => {\n    const number = await actor.answer(n)\n})'))).toBe('n/a');
        });
    });

    describe('no-clients-or-other-assertions', () => {
        it('passes clients reached through abilities, and checks with Ensure', () => {
            expect(verdictOf('no-clients-or-other-assertions', added([
                'const Dial = (n: Answerable<string>) => Interaction.where(the`#actor dials ${ n }`, async actor => {',
                '    const number = await actor.answer(n)',
                '    await MakePhoneCalls.as(actor).dial(number)',
                '})',
                "Ensure.that(Rate(), isGreaterThan(0))",
            ].join('\n')))).toBe('pass');
        });

        it.each([
            [ 'abilityTo',                     'const phone = actor.abilityTo(MakePhoneCalls)' ],
            [ 'the file system in a scenario', "import { writeFileSync } from 'fs'\nit('submits a job', () => { writeFileSync('jobs/job-1', '2 + 2') })" ],
            [ 'fetch in a suite',              "describe('rates', () => { before(() => fetch('https://api.frankfurter.dev/v1/latest')) })" ],
            [ 'expect in a scenario',          "it('checks the rate', () => { expect(rate).to.be.greaterThan(0) })" ],
            [ 'assert in a suite',             "describe('rates', () => { assert.ok(rate > 0) })" ],
            [ 'expect in an ability',          "export class CheckRates extends Ability { check(rate: number) { expect(rate).to.be.greaterThan(0) } }" ],
            [ 'assert in a question',          "const Rate = () => Question.about('the rate', async actor => { assert.ok(true); return 1 })" ],
        ])('fails %s', (_, code) => {
            expect(verdictOf('no-clients-or-other-assertions', added(code))).toBe('fail');
        });

        it.each([
            [ 'the file system in an interaction', "import { writeFileSync } from 'fs'\nconst Submit = (job: Answerable<string>) => Interaction.where(the`#actor submits ${ job }`, async actor => {\n    writeFileSync('/jobs/1', await actor.answer(job))\n})" ],
            [ 'fetch in a question',               "const Rate = () => Question.about('the rate', async actor => (await fetch('https://api.frankfurter.dev/v1/latest')).json())" ],
            [ 'an HTTP client in a question',      "import axios from 'axios'\nconst Rate = () => Question.about('the rate', async actor => (await axios.get('/latest')).data)" ],
        ])('leaves %s to clients-through-abilities, so that one client fails one item', (_, code) => {
            const verdicts = Object.fromEntries(checkConventions([ added(code) ]).map(check => [ check.item, check.verdict ]));

            expect(verdicts['clients-through-abilities']).toBe('fail');
            expect(verdicts['no-clients-or-other-assertions']).not.toBe('fail');
        });

        it('passes an ability that wraps fetch, an HTTP client or the file system, which is what abilities are for', () => {
            expect(verdictOf('no-clients-or-other-assertions', added([
                "import axios from 'axios'",
                "import { readFile } from 'fs/promises'",
                'export class CheckExchangeRates extends Ability {',
                '    async latest(base: string) { return (await fetch(`https://api.frankfurter.dev/v1/latest?base=${ base }`)).json() }',
                '    async history(base: string) { return (await axios.get(`/history?base=${ base }`)).data }',
                "    async saved() { return readFile('rates.json', 'utf8') }",
                '}',
                'const Rate = () => Question.about(\'the rate\', actor => CheckExchangeRates.as(actor).latest(\'EUR\'))',
            ].join('\n')))).toBe('pass');
        });


        it('passes an HTTP client given to an ability in a Cast', () => {
            expect(verdictOf('no-clients-or-other-assertions', added([
                "import axios from 'axios'",
                'export class Actors implements Cast {',
                '    prepare(actor: Actor): Actor {',
                '        return actor.whoCan(CallAnApi.using(axios.create({ baseURL: process.env.BASE_API_URL })))',
                '    }',
                '}',
            ].join('\n')))).toBe('pass');
        });

        it("doesn't count transforming an answer with as(Number) as retrieving an ability", () => {
            expect(verdictOf('no-clients-or-other-assertions', added('const rate = Text.of(x).as(Number)'))).toBe('n/a');
        });
    });

    it('only judges the lines the run added, not the code it found', () => {
        const file: ChangedFile = {
            path: 'spec/example.spec.ts',
            content: "actorCalled('Jobson').attemptsTo(Check())\nactorCalled(Role.Analyst).attemptsTo(Check())",
            addedLines: new Set([ 2 ]),
        };

        expect(verdictOf('actor-names', file)).toBe('pass');
    });

    it('only judges TypeScript files', () => {
        expect(verdictOf('actor-names', added("actorCalled('Alice')", 'README.md'))).toBe('n/a');
    });

    it('says where each verdict comes from', () => {
        const [ actorNames ] = checkConventions([ added("const ok = 1\nactorCalled('Alice').attemptsTo(Check())") ]);

        expect(actorNames.evidence).toEqual([ "spec/example.spec.ts:2: actorCalled('Alice')" ]);
    });
});

describe('conventionsScore', () => {
    it("counts the items that apply, and those that pass", () => {
        expect(conventionsScore([
            { item: 'actor-names', verdict: 'pass' },
            { item: 'checks', verdict: 'fail' },
            { item: 'answering', verdict: 'n/a' },
        ])).toEqual({ passed: 1, applicable: 2 });
    });
});
