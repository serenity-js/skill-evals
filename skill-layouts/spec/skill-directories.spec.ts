import { describe, expect, it } from 'vitest';

import { harnessBlinding, harnessSkillDirectories } from '../src/harness-skills.ts';
import { Blinding } from '../src/review.ts';
import { SkillDirectories } from '../src/skill-directories.ts';

describe('SkillDirectories', () => {

    const agents = [ { skills: { reads: [ '.kiro/skills' ] } }, { skills: { reads: [ '.github/skills', '.agents/skills' ] } } ];
    const directories = SkillDirectories.readBy(agents, [ '@serenity-js/core' ]);

    it("are the directories the agents read skills from, and each packed package's own skills/, in node_modules", () => {
        expect(directories.roots).toEqual([ '.kiro/skills', '.github/skills', '.agents/skills', 'node_modules/@serenity-js/core/skills' ]);
    });

    it("are, for the harness, the ones its agents' adapters declare, and the skills/ of every package it packs", () => {
        expect(harnessSkillDirectories().roots).toEqual([
            '.kiro/skills', '.github/skills', '.agents/skills', '.claude/skills',
            ...[ 'assertions', 'console-reporter', 'core', 'html-reporter', 'mocha', 'rest' ].map(name => `node_modules/@serenity-js/${ name }/skills`),
        ]);
    });

    it.each([
        [ '/runs/x/.kiro/skills/serenity-js-screenplay/references/tasks.md', 'serenity-js-screenplay/references/tasks.md' ],
        [ '.github/skills/serenity-js-writing-tasks/SKILL.md', 'serenity-js-writing-tasks/SKILL.md' ],
        [ 'C:\\runs\\x\\.agents\\skills\\serenity-js-writing-tasks\\SKILL.md', 'serenity-js-writing-tasks/SKILL.md' ],
        [ '/runs/x/node_modules/@serenity-js/core/skills/serenity-js-screenplay/SKILL.md', 'serenity-js-screenplay/SKILL.md' ],
    ])('finds the skill file %s leads to', (path, expected) => {
        expect(directories.fileIn(path)).toBe(expected);
    });

    it.each([
        [ "a directory no agent reads skills from", '/runs/x/.cursor/skills/serenity-js-writing-tasks/SKILL.md' ],
        [ "a package that isn't packed", '/runs/x/node_modules/@serenity-js/web/skills/serenity-js-web/SKILL.md' ],
        [ 'a skill directory itself', '/runs/x/.kiro/skills/serenity-js-screenplay' ],
        [ "a skill's file that isn't Markdown", '/runs/x/.kiro/skills/serenity-js-screenplay/examples/task.ts' ],
    ])('finds none in %s', (_, path) => {
        expect(directories.fileIn(path)).toBeUndefined();
    });

    it('finds every skill file a text names, in its order', () => {
        expect(directories.filesIn('cat .kiro/skills/a/SKILL.md .agents/skills/b/references/c.md'))
            .toEqual([ 'a/SKILL.md', 'b/references/c.md' ]);
    });

    it('replaces every path into a skill directory, with what follows it', () => {
        expect(directories.withPathsReplaced('see .kiro/skills/a/SKILL.md, and .github/workflows/check.yml', '[skill file]'))
            .toBe('see [skill file], and .github/workflows/check.yml');
    });
});

describe('Blinding', () => {

    const directories = SkillDirectories.of([ '.kiro/skills' ]);

    it("hides the paths into the skill directories, and every word that starts with a skill's name", () => {
        const blinding = Blinding.of(directories, [ 'serenity-js-screenplay', 'serenity-js-writing-tests' ]);

        expect(blinding.blind('As .kiro/skills/serenity-js-screenplay/SKILL.md and the serenity-js-writing-tests skill say, and serenity-js-screenplay-draft too'))
            .toBe('As [skill file] and the [skill] skill say, and [skill] too');
    });

    it("leaves the names of things that aren't skills, such as a template's", () => {
        expect(Blinding.of(directories, [ 'serenity-js-screenplay' ]).blind('serenity-js-mocha-template')).toBe('serenity-js-mocha-template');
    });

    it('hides only the paths, without any skills to name', () => {
        expect(Blinding.of(directories, []).blind('.kiro/skills/a/SKILL.md, serenity-js-screenplay')).toBe('[skill file], serenity-js-screenplay');
    });

    it("hides, for the harness, the names of every layout's skills", () => {
        expect(harnessBlinding().blind('serenity-js-screenplay serenity-js-screenplay-pattern serenity-js-writing-interactions-and-abilities serenity-js-writing-tests'))
            .toBe('[skill] [skill] [skill] [skill]');
    });
});
