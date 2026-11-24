import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CHECKLIST, type Check } from '../src/conventions.ts';
import { evalRoot } from '../src/layouts.ts';
import { combineVerdicts, disagreements, planRuns, reviewPacket, scoresTemplate } from '../src/review.ts';

describe('planRuns', () => {

    const keys = [
        { agent: 'kiro' as const, layout: 'none' as const, request: '1-new-feature', repeat: 1 },
        { agent: 'kiro' as const, layout: 'b' as const,    request: '1-new-feature', repeat: 1 },
        { agent: 'kiro' as const, layout: 'none' as const, request: '4-new-http-api', repeat: 1 },
        { agent: 'kiro' as const, layout: 'b' as const,    request: '4-new-http-api', repeat: 1 },
    ];

    it('gives every run a random ID, which says nothing about the run', () => {
        const ids = planRuns(keys).map(run => run.id);

        expect(new Set(ids).size).toBe(4);
        for (const id of ids) {
            expect(id).toMatch(/^[\da-f]{8}$/);
        }
    });

    it('draws a new ID when one is taken', () => {
        const ids = [ 'aaaaaaaa', 'aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd' ];

        expect(planRuns(keys, { randomId: () => ids.shift()!, shuffle: runs => runs }).map(run => run.id))
            .toEqual([ 'aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd' ]);
    });

    it('runs them in random order, so that a layout gets no particular time of day', () => {
        const reversed = planRuns(keys, { shuffle: runs => [ ...runs ].reverse() });

        expect(reversed.map(run => `${ run.layout } ${ run.request }`)).toEqual([
            'b 4-new-http-api', 'none 4-new-http-api', 'b 1-new-feature', 'none 1-new-feature',
        ]);
    });
});

describe('reviewPacket', () => {

    const diff = [
        'diff --git a/spec/units.spec.ts b/spec/units.spec.ts',
        '+// written with the serenity-js-screenplay skill, see .kiro/skills/serenity-js-screenplay/references/tasks.md',
        "+const ConvertUnits = (expression: Answerable<string>) => Task.where(the`#actor converts ${ expression }`)",
    ].join('\n');

    const packet = reviewPacket({ id: '3f9c2a1e', request: '9-new-interface', prompt: 'Add a scenario that converts 5 inches to centimetres.', diff, reply: '' });

    it('shows the request and the diff under the run ID', () => {
        expect(packet).toContain('# Run 3f9c2a1e');
        expect(packet).toContain('Add a scenario that converts 5 inches to centimetres.');
        expect(packet).toContain('const ConvertUnits = (expression: Answerable<string>)');
    });

    it("hides the names and paths of skills, which would give the layout away", () => {
        expect(packet).not.toMatch(/serenity-js-screenplay|\.kiro\/skills/);
        expect(packet).toContain('written with the [skill] skill, see [skill file]');
    });

    it("links to the reviewer guide, with the decisions that settle each item, and says it's there to follow", () => {
        expect(packet).toContain(`Score them as [the reviewer guide](${ join(evalRoot, 'review-guide.md') }) says: it has a rule for each decision made so far, with the run it was made on.`);
        expect(existsSync(join(evalRoot, 'review-guide.md'))).toBe(true);
    });

    it('lists the checklist to score, and says which items are the reviewer\'s alone', () => {
        expect(packet).toContain('- [ ] actor-names: the actors a change introduces are named after the role they play, from an enum or constants');
        expect(packet).toContain('- [ ] no-console-log: no console.log added (reviewer only: the AST patterns leave it n/a)');
    });

    it("shows the agent's final reply, with the names and paths of skills hidden, where its suggestions are", () => {
        const withReply = reviewPacket({ id: '3f9c2a1e', request: '11-add-to-messy-code', prompt: 'Add a scenario.', diff, reply: 'Added it, as the serenity-js-screenplay skill says. Suggestions: replace PostAndCheck.' });

        expect(withReply).toContain("## The agent's reply\n\nAdded it, as the [skill] skill says. Suggestions: replace PostAndCheck.");
    });

    it("says when the run left no final reply", () => {
        expect(reviewPacket({ id: '3f9c2a1e', request: '11-add-to-messy-code', prompt: 'Add a scenario.', diff, reply: '' }))
            .toContain("## The agent's reply\n\n(none: the agent said nothing after its last tool call)");
    });

    it("lists every item: those the run's request exercises first, then the others, to score where the code the run added is about them", () => {
        const request2 = reviewPacket({ id: '3f9c2a1e', request: '2-step-that-does-several-things', prompt: 'Add a step.', diff, reply: '' });

        expect(request2).toMatch(/### The items the request exercises\n\n[^#]*- \[ \] tasks-for-steps:/);
        expect(request2).toMatch(/### The other items\n\n[^#]*- \[ \] actor-names:/);
        expect(request2).toContain('An item is n/a when the code the run added has nothing it applies to.');
    });
});

describe('scoresTemplate', () => {
    it('has a blank verdict for every item of the checklist, for every run, whatever its request, sorted by ID', () => {
        const template = scoresTemplate([ { id: 'bbbbbbbb' }, { id: 'aaaaaaaa' } ]);

        expect(Object.keys(template)).toEqual([ 'aaaaaaaa', 'bbbbbbbb' ]);
        expect(template.aaaaaaaa).toEqual(Object.fromEntries(CHECKLIST.map(item => [ item.id, '' ])));
    });
});

describe('combineVerdicts', () => {

    const ast = (verdicts: Partial<Record<Check['item'], Check['verdict']>>): Check[] =>
        Object.entries(verdicts).map(([ item, verdict ]) => ({ item: item as Check['item'], verdict: verdict!, evidence: [] }));

    it("takes the reviewer's verdict over the patterns', for every item the reviewer scored", () => {
        expect(combineVerdicts(ast({ 'actor-names': 'pass', 'answering': 'fail', 'checks': 'n/a' }), { 'actor-names': 'fail', 'answering': 'pass', 'checks': 'pass' }))
            .toEqual([ { item: 'actor-names', verdict: 'fail' }, { item: 'answering', verdict: 'pass' }, { item: 'checks', verdict: 'pass' } ]);
    });

    it("uses the patterns' verdicts until the run is reviewed", () => {
        expect(combineVerdicts(ast({ 'actor-names': 'pass', 'checks': 'n/a' }), undefined))
            .toEqual([ { item: 'actor-names', verdict: 'pass' }, { item: 'checks', verdict: 'n/a' } ]);
        expect(combineVerdicts(ast({ 'actor-names': 'pass' }), { 'actor-names': '' }))
            .toEqual([ { item: 'actor-names', verdict: 'pass' } ]);
    });

    it("keeps the verdicts on the items a run's request doesn't exercise, the reviewer's and the patterns'", () => {
        expect(combineVerdicts(ast({ 'actor-names': 'n/a', 'checks': 'pass', 'names-without-the': 'fail' }), { 'actor-names': 'fail', 'checks': 'fail' }))
            .toEqual([ { item: 'actor-names', verdict: 'fail' }, { item: 'checks', verdict: 'fail' }, { item: 'names-without-the', verdict: 'fail' } ]);
    });

    it("gives verdicts on the questions and tasks run 89a97301 added, though its request, 11, doesn't list question-names", () => {
        const combined = combineVerdicts(ast({ 'question-names': 'n/a', 'tasks-for-steps': 'n/a' }), { 'question-names': 'pass', 'tasks-for-steps': 'fail' });

        expect(combined).toEqual([ { item: 'question-names', verdict: 'pass' }, { item: 'tasks-for-steps', verdict: 'fail' } ]);
    });

    it('refuses a verdict that is not pass, fail or n/a', () => {
        expect(() => combineVerdicts(ast({ 'actor-names': 'pass' }), { 'actor-names': 'yes' })).toThrow(/pass, fail or n\/a/);
    });
});

describe('disagreements', () => {

    const ast = (verdicts: Partial<Record<Check['item'], Check['verdict']>>): Check[] =>
        Object.entries(verdicts).map(([ item, verdict ]) => ({ item: item as Check['item'], verdict: verdict!, evidence: [] }));

    it('counts the items the reviewer scored, and those where they and the patterns disagree', () => {
        expect(disagreements(ast({ 'actor-names': 'pass', 'answering': 'fail', 'checks': 'n/a', 'waiting': 'n/a' }), { 'actor-names': 'pass', 'answering': 'pass', 'checks': 'pass', 'waiting': '' }))
            .toEqual({ scored: 3, disagreed: 2 });
    });

    it("doesn't count the reviewer's own items, which the patterns always leave n/a, as disagreements", () => {
        expect(disagreements(ast({ 'actor-names': 'pass', 'no-console-log': 'n/a', 'structure': 'n/a' }), { 'actor-names': 'pass', 'no-console-log': 'pass', 'structure': 'fail' }))
            .toEqual({ scored: 1, disagreed: 0 });
    });

    it("counts the items the run's request doesn't exercise too", () => {
        expect(disagreements(ast({ 'actor-names': 'n/a', 'checks': 'pass' }), { 'actor-names': 'fail', 'checks': 'pass' }))
            .toEqual({ scored: 2, disagreed: 1 });
    });

    it('counts nothing for a run that has not been reviewed', () => {
        expect(disagreements(ast({ 'actor-names': 'pass' }), undefined)).toEqual({ scored: 0, disagreed: 0 });
    });
});
