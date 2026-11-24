import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { blocksOf, compareLayout, filesOf } from '../src/content.ts';
import { evalRoot } from '../src/layouts.ts';

describe('blocksOf', () => {
    it('splits Markdown into paragraphs, lists and headings, keeping each code block whole', () => {
        expect(blocksOf('# Title\n\nOne\nparagraph.\n\n```typescript\nconst a = 1\n\nconst b = 2\n```\n\n- a\n- b\n')).toEqual([
            '# Title',
            'One\nparagraph.',
            '```typescript\nconst a = 1\n\nconst b = 2\n```',
            '- a\n- b',
        ]);
    });
});

describe('compareLayout', () => {
    it('lists the blocks only one side has, wherever the other keeps the rest', () => {
        const base = [ { file: 'x/SKILL.md', content: 'Kept.\n\nChanged.\n' } ];
        const layout = [ { file: 'y/one.md', content: 'Changed, a little.\n' }, { file: 'y/two.md', content: 'Kept.\n' } ];

        expect(compareLayout(base, layout)).toEqual({
            onlyInBase: [ { file: 'x/SKILL.md', text: 'Changed.' } ],
            onlyInLayout: [ { file: 'y/one.md', text: 'Changed, a little.' } ],
        });
    });
});

describe('the layouts', () => {

    const layout = (id: string) => filesOf(join(evalRoot, 'layouts', id, 'core'));

    /** Each block as `<file>: <first line>`, leaving out the frontmatter, which every layout writes its own way. */
    const firstLines = (blocks: Array<{ file: string, text: string }>) => blocks
        .filter(block => ! block.text.startsWith('---\nname:'))
        .map(block => `${ block.file }: ${ block.text.split('\n').find(line => ! line.startsWith('```') && ! line.startsWith('import ') && line.trim() !== '') }`);

    it("give layout A #3616's skills as they are", () => {
        expect(compareLayout(layout('a'), layout('a'))).toEqual({ onlyInBase: [], onlyInLayout: [] });
    });

    it('give layout B the text of #3616, apart from the frontmatter, the overview and the cross-references', () => {
        const { onlyInBase, onlyInLayout } = compareLayout(layout('a'), layout('b'));

        expect(firstLines(onlyInBase)).toEqual([
            'serenity-js-writing-interactions-and-abilities/SKILL.md: Tests rarely use either directly. They use tasks, which compose interactions into goals in the business domain;',
            ...Array.from({ length: 2 }, () => "serenity-js-writing-interactions-and-abilities/SKILL.md: // your project's actor names, as the serenity-js-writing-tasks skill describes them"),
            'serenity-js-writing-interactions-and-abilities/SKILL.md: - **Using the client in a test**, through a getter on the ability. Tests that use interactions and questions keep',
            'serenity-js-writing-questions/SKILL.md: // an ability your project already has; the serenity-js-writing-interactions-and-abilities skill covers those',
            "serenity-js-writing-questions/SKILL.md: // your project's actor names, as the serenity-js-writing-tasks skill describes them",
            'serenity-js-writing-tasks/SKILL.md: ## Where tasks fit',
            'serenity-js-writing-tasks/SKILL.md: Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as',
            'serenity-js-writing-tasks/SKILL.md: // the interactions from "Where tasks fit"',
            ...Array.from({ length: 3 }, () => `serenity-js-writing-tasks/SKILL.md: // the actors' names, from "Where tasks fit"`),
            'serenity-js-writing-tasks/SKILL.md: // the interaction and the question from "Where tasks fit", and an expectation from @serenity-js/assertions',
            'serenity-js-writing-tasks/SKILL.md: // what the phone line reports about the last call',
            `serenity-js-writing-tasks/SKILL.md: // the actors' names from "Where tasks fit", a task that checks its calls went through, a question about the card,`,
            'serenity-js-writing-tasks/SKILL.md: // the tasks above, and an interaction from "Where tasks fit"',
            `serenity-js-writing-tasks/SKILL.md: // the actors' names and the interactions from "Where tasks fit", and Mocha's it`,
            'serenity-js-writing-tasks/SKILL.md: - **Until anything is reused, standalone questions are fine.** Group questions under one object when different',
            `serenity-js-writing-tasks/SKILL.md: // the actors' names, from "Where tasks fit"`,
            "serenity-js-writing-tasks/SKILL.md: - **A scenario that's a long list of built-in interactions** becomes tasks named for the business steps they",
            'serenity-js-writing-tasks/SKILL.md: // the interactions from "Where tasks fit"',
            'serenity-js-writing-tasks/SKILL.md: // the interactions and the question from "Where tasks fit", and an expectation from @serenity-js/assertions',
        ]);
        expect(firstLines(onlyInLayout)).toEqual([
            // the overview
            'serenity-js-screenplay/SKILL.md: # Writing Screenplay tasks, interactions, abilities and questions',
            'serenity-js-screenplay/SKILL.md: Serenity/JS tests are written with the Screenplay Pattern. Choose the building block by what the test needs:',
            'serenity-js-screenplay/SKILL.md: | The test needs to | Write | Read |',
            // the index of what each file covers, and its sections
            'serenity-js-screenplay/SKILL.md: ## What each file covers',
            'serenity-js-screenplay/SKILL.md: ### [tasks.md](references/tasks.md)',
            'serenity-js-screenplay/SKILL.md: Tasks: composing activities into the goals of the business domain, describing them, waiting for their outcome, and',
            'serenity-js-screenplay/SKILL.md: - Write a task as a function that returns `Task.where`',
            'serenity-js-screenplay/SKILL.md: ### [interactions-and-abilities.md](references/interactions-and-abilities.md)',
            'serenity-js-screenplay/SKILL.md: Interactions, which do one thing with the system under test, and the abilities that give them access to its',
            'serenity-js-screenplay/SKILL.md: - Check whether you need a new ability',
            'serenity-js-screenplay/SKILL.md: ### [questions.md](references/questions.md)',
            'serenity-js-screenplay/SKILL.md: Questions, which find out about the system under test, and debugging a scenario by what they answer.',
            'serenity-js-screenplay/SKILL.md: - Write a question with `Question.about`',
            'serenity-js-screenplay/SKILL.md: ## How the building blocks fit together',
            // the cross-references
            'serenity-js-screenplay/SKILL.md: Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as',
            'serenity-js-screenplay/references/interactions-and-abilities.md: Tests rarely use either directly. They use tasks, which compose interactions into goals in the business domain;',
            ...Array.from({ length: 2 }, () => "serenity-js-screenplay/references/interactions-and-abilities.md: // your project's actor names, as SKILL.md describes them"),
            'serenity-js-screenplay/references/interactions-and-abilities.md: - **Using the client in a test**, through a getter on the ability. Tests that use interactions and questions keep',
            'serenity-js-screenplay/references/questions.md: // an ability your project already has; interactions-and-abilities.md covers those',
            "serenity-js-screenplay/references/questions.md: // your project's actor names, as SKILL.md describes them",
            'serenity-js-screenplay/references/tasks.md: // the interactions from SKILL.md',
            ...Array.from({ length: 3 }, () => "serenity-js-screenplay/references/tasks.md: // the actors' names, from SKILL.md"),
            'serenity-js-screenplay/references/tasks.md: // the interaction and the question from SKILL.md, and an expectation from @serenity-js/assertions',
            'serenity-js-screenplay/references/tasks.md: // what the phone line reports about the last call',
            "serenity-js-screenplay/references/tasks.md: // the actors' names from SKILL.md, a task that checks its calls went through, a question about the card,",
            'serenity-js-screenplay/references/tasks.md: // the tasks above, and an interaction from SKILL.md',
            "serenity-js-screenplay/references/tasks.md: // the actors' names and the interactions from SKILL.md, and Mocha's it",
            // the lists whose bullets about grouping refer to questions.md
            'serenity-js-screenplay/references/tasks.md: - **Until anything is reused, standalone questions are fine.** Group questions under one object when different',
            "serenity-js-screenplay/references/tasks.md: // the actors' names, from SKILL.md",
            "serenity-js-screenplay/references/tasks.md: - **A scenario that's a long list of built-in interactions** becomes tasks named for the business steps they",
            'serenity-js-screenplay/references/tasks.md: // the interactions from SKILL.md',
            'serenity-js-screenplay/references/tasks.md: // the interactions and the question from SKILL.md, and an expectation from @serenity-js/assertions',
        ]);
    });

    it('give layout C the text of #3616, apart from the frontmatter, the overviews and the cross-references', () => {
        const { onlyInBase, onlyInLayout } = compareLayout(layout('a'), layout('c'));

        expect(firstLines(onlyInBase)).toEqual([
            'serenity-js-writing-interactions-and-abilities/SKILL.md: # Writing Screenplay interactions and abilities',
            'serenity-js-writing-interactions-and-abilities/SKILL.md: An interaction is one thing an actor does with the system under test: dial a number, click a button, send a',
            'serenity-js-writing-interactions-and-abilities/SKILL.md: Tests rarely use either directly. They use tasks, which compose interactions into goals in the business domain;',
            ...Array.from({ length: 2 }, () => "serenity-js-writing-interactions-and-abilities/SKILL.md: // your project's actor names, as the serenity-js-writing-tasks skill describes them"),
            'serenity-js-writing-interactions-and-abilities/SKILL.md: - **Using the client in a test**, through a getter on the ability. Tests that use interactions and questions keep',
            'serenity-js-writing-questions/SKILL.md: // an ability your project already has; the serenity-js-writing-interactions-and-abilities skill covers those',
            "serenity-js-writing-questions/SKILL.md: // your project's actor names, as the serenity-js-writing-tasks skill describes them",
            'serenity-js-writing-tasks/SKILL.md: ## Where tasks fit',
            'serenity-js-writing-tasks/SKILL.md: Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as',
            'serenity-js-writing-tasks/SKILL.md: // the interactions from "Where tasks fit"',
            ...Array.from({ length: 3 }, () => `serenity-js-writing-tasks/SKILL.md: // the actors' names, from "Where tasks fit"`),
            'serenity-js-writing-tasks/SKILL.md: // the interaction and the question from "Where tasks fit", and an expectation from @serenity-js/assertions',
            'serenity-js-writing-tasks/SKILL.md: // what the phone line reports about the last call',
            `serenity-js-writing-tasks/SKILL.md: // the actors' names from "Where tasks fit", a task that checks its calls went through, a question about the card,`,
            'serenity-js-writing-tasks/SKILL.md: // the tasks above, and an interaction from "Where tasks fit"',
            `serenity-js-writing-tasks/SKILL.md: // the actors' names and the interactions from "Where tasks fit", and Mocha's it`,
            `serenity-js-writing-tasks/SKILL.md: // the actors' names, from "Where tasks fit"`,
            'serenity-js-writing-tasks/SKILL.md: // the interactions from "Where tasks fit"',
            'serenity-js-writing-tasks/SKILL.md: // the interactions and the question from "Where tasks fit", and an expectation from @serenity-js/assertions',
        ]);
        expect(firstLines(onlyInLayout)).toEqual([
            // the overview
            'serenity-js-screenplay-pattern/SKILL.md: # The Screenplay Pattern',
            'serenity-js-screenplay-pattern/SKILL.md: Serenity/JS tests are written with the Screenplay Pattern. Choose the building block by what the test needs:',
            'serenity-js-screenplay-pattern/SKILL.md: | The test needs to | Write | Read |',
            // the index of what each of the other skills covers, and its sections
            'serenity-js-screenplay-pattern/SKILL.md: ## What each skill covers',
            'serenity-js-screenplay-pattern/SKILL.md: ### serenity-js-writing-tasks',
            'serenity-js-screenplay-pattern/SKILL.md: Tasks: composing activities into the goals of the business domain, describing them, waiting for their outcome, and',
            'serenity-js-screenplay-pattern/SKILL.md: - Write a task as a function that returns `Task.where`',
            'serenity-js-screenplay-pattern/SKILL.md: ### serenity-js-writing-interactions',
            'serenity-js-screenplay-pattern/SKILL.md: Interactions, which do one thing with the system under test.',
            'serenity-js-screenplay-pattern/SKILL.md: - Write an interaction with `Interaction.where`',
            'serenity-js-screenplay-pattern/SKILL.md: ### serenity-js-writing-abilities',
            'serenity-js-screenplay-pattern/SKILL.md: Abilities, which wrap the client of an interface no Serenity/JS integration covers, and give interactions and',
            'serenity-js-screenplay-pattern/SKILL.md: - Check whether you need a new ability',
            'serenity-js-screenplay-pattern/SKILL.md: ### serenity-js-writing-questions',
            'serenity-js-screenplay-pattern/SKILL.md: Questions, which find out about the system under test, and debugging a scenario by what they answer.',
            'serenity-js-screenplay-pattern/SKILL.md: - Write a question with `Question.about`',
            'serenity-js-screenplay-pattern/SKILL.md: ## How the building blocks fit together',
            'serenity-js-screenplay-pattern/SKILL.md: Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as',
            // the overviews of the skills split from serenity-js-writing-interactions-and-abilities, and its Avoid list, split in two
            'serenity-js-writing-abilities/SKILL.md: # Writing Screenplay abilities',
            'serenity-js-writing-abilities/SKILL.md: An ability is what enables an actor\'s interactions. It wraps the client of one of the system\'s interfaces, such as a browser, an',
            'serenity-js-writing-abilities/SKILL.md: Tests rarely use abilities directly. Interactions use them; the serenity-js-writing-interactions skill covers those.',
            ...Array.from({ length: 2 }, () => "serenity-js-writing-abilities/SKILL.md: // your project's actor names, as the serenity-js-screenplay-pattern skill describes them"),
            'serenity-js-writing-abilities/SKILL.md: - **Using the client in a test**, through a getter on the ability. Tests that use interactions and questions keep',
            'serenity-js-writing-interactions/SKILL.md: # Writing Screenplay interactions',
            'serenity-js-writing-interactions/SKILL.md: An interaction is one thing an actor does with the system under test: dial a number, click a button, send a',
            'serenity-js-writing-interactions/SKILL.md: Tests rarely use interactions directly. They use tasks, which compose interactions into goals in the business domain;',
            'serenity-js-writing-interactions/SKILL.md: - **Changing the system under test to suit the test**, by importing its modules, exposing its internals, or adding',
            // the cross-references
            'serenity-js-writing-questions/SKILL.md: // an ability your project already has; the serenity-js-writing-abilities skill covers those',
            "serenity-js-writing-questions/SKILL.md: // your project's actor names, as the serenity-js-screenplay-pattern skill describes them",
            'serenity-js-writing-tasks/SKILL.md: // the interactions from the serenity-js-screenplay-pattern skill',
            ...Array.from({ length: 3 }, () => "serenity-js-writing-tasks/SKILL.md: // the actors' names, from the serenity-js-screenplay-pattern skill"),
            'serenity-js-writing-tasks/SKILL.md: // the interaction and the question from the serenity-js-screenplay-pattern skill, and an expectation from @serenity-js/assertions',
            'serenity-js-writing-tasks/SKILL.md: // what the phone line reports about the last call',
            "serenity-js-writing-tasks/SKILL.md: // the actors' names from the serenity-js-screenplay-pattern skill, a task that checks its calls went through, a question about the card,",
            'serenity-js-writing-tasks/SKILL.md: // the tasks above, and an interaction from the serenity-js-screenplay-pattern skill',
            "serenity-js-writing-tasks/SKILL.md: // the actors' names and the interactions from the serenity-js-screenplay-pattern skill, and Mocha's it",
            "serenity-js-writing-tasks/SKILL.md: // the actors' names, from the serenity-js-screenplay-pattern skill",
            'serenity-js-writing-tasks/SKILL.md: // the interactions from the serenity-js-screenplay-pattern skill',
            'serenity-js-writing-tasks/SKILL.md: // the interactions and the question from the serenity-js-screenplay-pattern skill, and an expectation from @serenity-js/assertions',
            'serenity-js-writing-tasks/SKILL.md: ## Avoid',
        ]);
    });

    it('give every layout the same writing-tests skill, apart from the names of the skills it refers to', () => {
        const writingTests = (id: string) => readFileSync(join(evalRoot, 'layouts', id, 'mocha', 'serenity-js-writing-tests', 'SKILL.md'), 'utf8')
            .replace(/serenity-js-(?!writing-tests)[a-z-]+/g, '<skill>');

        expect(writingTests('b')).toBe(writingTests('a'));
        expect(writingTests('c')).toBe(writingTests('a'));
    });
});

describe("the layouts' overviews", () => {

    const read = (path: string) => readFileSync(join(evalRoot, 'layouts', path), 'utf8');

    /** The titles of a skill file's `##` sections, as they're written. */
    const sectionsOf = (markdown: string) => markdown.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3));

    /** What an overview says under `### <title>`, up to the next heading: the sentence before its list, and the list. */
    function indexUnder(overview: string, title: string): { about: string, items: string[] } {
        const lines = overview.split('\n');
        const start = lines.indexOf(`### ${ title }`);
        if (start === -1) {
            return { about: '', items: [] };
        }
        const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
        const body = lines.slice(start + 1, end === -1 ? undefined : end).filter(line => line.trim() !== '');
        return {
            about: body.filter(line => ! line.startsWith('- ')).join(' '),
            items: body.filter(line => line.startsWith('- ')).map(line => line.slice(2)),
        };
    }

    it("index, in layout B's SKILL.md, every section of each file it points to, under the file to open for it, with what the file covers", () => {
        const overview = read('b/core/serenity-js-screenplay/SKILL.md');

        for (const file of [ 'tasks.md', 'questions.md', 'interactions-and-abilities.md' ]) {
            const index = indexUnder(overview, `[${ file }](references/${ file })`);

            expect(index.items, file).toEqual(sectionsOf(read(`b/core/serenity-js-screenplay/references/${ file }`)));
            expect(index.about, file).not.toBe('');
        }
    });

    it("list, in layout C's serenity-js-screenplay-pattern, every other skill of the layout, with what it covers and its sections", () => {
        const overview = read('c/core/serenity-js-screenplay-pattern/SKILL.md');
        const skills = readdirSync(join(evalRoot, 'layouts', 'c', 'core')).filter(skill => skill !== 'serenity-js-screenplay-pattern').sort();

        expect(skills).toHaveLength(4);
        for (const skill of skills) {
            const index = indexUnder(overview, skill);

            expect(index.items, skill).toEqual(sectionsOf(read(`c/core/${ skill }/SKILL.md`)));
            expect(index.about, skill).not.toBe('');
        }
    });
});
