import { describe, expect, it } from 'vitest';

import { scoreLoading } from '../src/loading.ts';
import type { SkillRead } from '../src/streams.ts';

const read = (file: string): SkillRead => ({ file, via: 'read' });

describe('scoreLoading', () => {

    it("counts a run as loading the right skills when it read the file that holds each building block the request needs", () => {
        const score = scoreLoading('b', [ 'tasks', 'questions' ], [
            read('serenity-js-screenplay/SKILL.md'),
            read('serenity-js-screenplay/references/tasks.md'),
            read('serenity-js-screenplay/references/questions.md'),
        ]);

        expect(score).toEqual({
            needed: [ 'serenity-js-screenplay/references/questions.md', 'serenity-js-screenplay/references/tasks.md' ],
            read: [ 'serenity-js-screenplay/SKILL.md', 'serenity-js-screenplay/references/questions.md', 'serenity-js-screenplay/references/tasks.md' ],
            missing: [],
            right: true,
        });
    });

    it("doesn't, when a needed file wasn't read, even if the skill's SKILL.md was", () => {
        const score = scoreLoading('b', [ 'tasks' ], [ { file: 'serenity-js-screenplay/SKILL.md', via: 'skill-tool' } ]);

        expect(score?.missing).toEqual([ 'serenity-js-screenplay/references/tasks.md' ]);
        expect(score?.right).toBe(false);
    });

    it('needs one file for building blocks that share one, as interactions and abilities do in layout A', () => {
        const score = scoreLoading('a', [ 'interactions', 'abilities' ], [ read('serenity-js-writing-interactions-and-abilities/SKILL.md') ]);

        expect(score?.needed).toEqual([ 'serenity-js-writing-interactions-and-abilities/SKILL.md' ]);
        expect(score?.right).toBe(true);
    });

    it.each([
        [ 'reading its SKILL.md with a file-reading tool', 'read' ],
        [ "loading it with the agent's skill tool",       'skill-tool' ],
    ] as const)('counts %s as loading a skill', (_, via) => {
        const score = scoreLoading('a', [ 'tasks' ], [ { file: 'serenity-js-writing-tasks/SKILL.md', via } ]);

        expect(score?.right).toBe(true);
    });

    it('counts a run of the control as right only when it read no skills', () => {
        expect(scoreLoading('c', [], [])?.right).toBe(true);
        expect(scoreLoading('c', [], [ read('serenity-js-writing-tests/SKILL.md') ])?.right).toBe(false);
    });

    it("doesn't score the layout without skills", () => {
        expect(scoreLoading('none', [ 'tasks' ], [])).toBeUndefined();
    });
});
