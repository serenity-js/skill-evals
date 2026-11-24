import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildLayouts, parseBuildArguments, readScreenplaySkill } from '../src/build-layouts.ts';
import { evalRoot } from '../src/layouts.ts';

const layouts = join(evalRoot, 'layouts');

/** Every Markdown file of the layouts' core skills, relative to layouts/, e.g. `b/core/serenity-js-screenplay/references/tasks.md`. */
const committed = () => [ 'a', 'b', 'c' ].flatMap(layout => readdirSync(join(layouts, layout, 'core'), { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.md'))
    .map(file => `${ layout }/core/${ file.split(sep).join('/') }`))
    .sort();

describe('buildLayouts', () => {

    // layout B is serenity-js's serenity-js-screenplay skill as it is, so it's the fixture the layouts are rebuilt from
    const screenplay = readScreenplaySkill(join(layouts, 'b', 'core', 'serenity-js-screenplay'));
    const withFile = (file: string, content: string) => new Map([ ...screenplay, [ file, content ] ]);

    it("rebuilds layouts A and C from layout B, byte for byte as they're committed, so the inversion loses nothing and a layout edited by hand is caught", () => {
        const built = buildLayouts(screenplay);

        expect([ ...built.keys() ].sort()).toEqual(committed());
        for (const [ path, content ] of built) {
            expect(content, path).toBe(readFileSync(join(layouts, path), 'utf8'));
        }
    });

    it('writes layout B as the skill is', () => {
        const built = buildLayouts(screenplay);

        for (const [ file, content ] of screenplay) {
            expect(built.get(`b/core/serenity-js-screenplay/${ file }`), file).toBe(content);
        }
    });

    it("puts a section added to B's tasks.md in A's and C's tasks skills, and in C's overview's index", () => {
        const tasks = screenplay.get('references/tasks.md')!.replace('## Avoid\n', '## Plan a release\n\nWhat the new section says.\n\n## Avoid\n');
        const built = buildLayouts(withFile('references/tasks.md', tasks));

        expect(built.get('b/core/serenity-js-screenplay/references/tasks.md')).toBe(tasks);
        expect(built.get('a/core/serenity-js-writing-tasks/SKILL.md')).toContain('## Plan a release\n\nWhat the new section says.\n\n## Avoid\n');
        expect(built.get('c/core/serenity-js-writing-tasks/SKILL.md')).toContain('## Plan a release\n\nWhat the new section says.\n\n## Avoid\n');
        expect(built.get('c/core/serenity-js-screenplay-pattern/SKILL.md')).toMatch(/### serenity-js-writing-tasks[^#]*- Refactor what's there\n- Plan a release\n- Avoid\n/);
    });

    it("refuses a skill whose cross-references layout A can't rewrite back to the skills' names, and says which", () => {
        const tasks = screenplay.get('references/tasks.md')!.replaceAll('from SKILL.md', 'from the overview');

        expect(() => buildLayouts(withFile('references/tasks.md', tasks)))
            .toThrow(/^layout A's serenity-js-writing-tasks: "from SKILL\.md" isn't there/);
    });

    it.each([
        [ 'a link to a file beside it',            'references/questions.md', 'See [tasks.md](tasks.md).',                     'tasks.md' ],
        [ 'a link with an anchor',                 'references/questions.md', 'See [waiting](tasks.md#avoid).',                'tasks.md#avoid' ],
        [ 'a link back to the overview',           'references/tasks.md',     'See [the overview](../SKILL.md).',              '../SKILL.md' ],
        [ 'a link definition',                     'references/tasks.md',     'See [questions][q].\n\n[q]: questions.md',      'questions.md' ],
        [ "a link from SKILL.md to a reference",   'SKILL.md',                'See [tasks.md](references/tasks.md).',          'references/tasks.md' ],
    ])("refuses %s that layout A has no reference for, since A's and C's skills don't have B's files", (_, file, paragraph, destination) => {
        const where = file === 'SKILL.md' ? '## How the building blocks fit together\n\n' : '## Avoid\n';
        const changed = screenplay.get(file)!.replace(where, file === 'SKILL.md' ? `${ where }${ paragraph }\n\n` : `${ paragraph }\n\n${ where }`);

        expect(() => buildLayouts(withFile(file, changed)))
            .toThrow(`layout A: ${ file } links to ${ destination }, a file of the serenity-js-screenplay skill that layouts A and C don't have; add the link to REFERENCES in build-layouts.ts`);
    });

    it("refuses a section added to interactions-and-abilities.md until it's given one of layout C's skills, so that C doesn't drop it", () => {
        const interactionsAndAbilities = screenplay.get('references/interactions-and-abilities.md')!
            .replace('## Avoid\n', '## Test an interaction\n\nWhat the new section says.\n\n## Avoid\n');

        expect(() => buildLayouts(withFile('references/interactions-and-abilities.md', interactionsAndAbilities)))
            .toThrow(/^layout C: the section "Test an interaction" of serenity-js-writing-interactions-and-abilities\/SKILL\.md isn't in C's interactions or abilities skill/);
    });

    it('refuses a skill whose paragraph on the integrations has changed, rather than overwrite the change', () => {
        const overview = screenplay.get('SKILL.md')!.replace('The other files of this skill use the\ninteractions', 'The other files of this skill use the\nabilities, interactions');

        expect(() => buildLayouts(withFile('SKILL.md', overview)))
            .toThrow(/^layout A's serenity-js-writing-tasks: the paragraph "Most projects get their abilities.*" has changed/);
    });

    it("refuses a SKILL.md without the section on how the building blocks fit together, which A's tasks skill and C's overview are made from", () => {
        const overview = screenplay.get('SKILL.md')!.replace('## How the building blocks fit together\n', '## How it fits\n');

        expect(() => buildLayouts(withFile('SKILL.md', overview)))
            .toThrow('SKILL.md: no section "How the building blocks fit together"');
    });

    it('refuses a skill without one of its files', () => {
        expect(() => buildLayouts(new Map([ ...screenplay ].filter(([ file ]) => file !== 'references/questions.md'))))
            .toThrow('the serenity-js-screenplay skill has no references/questions.md');
    });

    it("refuses a skill with a file layouts A and C don't have, rather than drop it from them", () => {
        expect(() => buildLayouts(withFile('references/more.md', 'More.\n')))
            .toThrow("the serenity-js-screenplay skill has references/more.md, which layouts A and C don't have a place for; add it to build-layouts.ts");
    });
});

describe('eval:build-layouts', () => {

    it("reads the serenity-js-screenplay skill of the serenity-js clone it's given", () => {
        expect(parseBuildArguments([ '--', '--serenity-js', '../serenity-js' ], '/work/kiro')).toEqual({ screenplaySkill: '/work/serenity-js/packages/core/skills/serenity-js-screenplay' });
    });

    it('needs the serenity-js clone', () => {
        expect(() => parseBuildArguments([], '/work/kiro')).toThrow('usage: eval:build-layouts -- --serenity-js <clone>');
    });
});
