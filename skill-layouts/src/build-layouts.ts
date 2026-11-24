// pnpm run eval:build-layouts -- --serenity-js <clone>
//
// Rebuilds the layouts' core skills from a serenity-js clone's packages/core/skills/serenity-js-screenplay, the skill
// @serenity-js/core ships, with SKILL.md and its detail files under references/: layout B as it is, and layouts A and C from it, by moving its sections between skills.
// Layout A is the three skills it was made from, one per building block, which refer to each other by name; layout C
// is a skill for the pattern and one per building block, with interactions and abilities apart. What A and C write
// their own way, their frontmatter, C's overviews, the sentences of C's overview's index and their cross-references,
// is kept here, so a layout is never edited by hand: build-layouts.spec.ts rebuilds A and C from layout B and compares
// them with what's committed. C's overview's index lists every ## section of the skills it points to, so a section
// added to the skill is indexed too.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';

import { evalRoot } from './layouts.ts';

/** The files of skills, by their paths relative to the skills' directory, e.g. `serenity-js-writing-tasks/SKILL.md`, or to the skill's, e.g. `references/tasks.md`. */
export type CoreSkills = Map<string, string>;

const TASKS = 'serenity-js-writing-tasks/SKILL.md';
const INTERACTIONS_AND_ABILITIES = 'serenity-js-writing-interactions-and-abilities/SKILL.md';
const QUESTIONS = 'serenity-js-writing-questions/SKILL.md';

/** The files of the serenity-js-screenplay skill, which is layout B */
const SCREENPLAY_FILES = [ 'SKILL.md', 'references/tasks.md', 'references/interactions-and-abilities.md', 'references/questions.md' ];

/** Every file of the serenity-js-screenplay skill, by its path relative to the skill's directory, e.g. `references/tasks.md`. */
export function readScreenplaySkill(directory: string): CoreSkills {
    return new Map(readdirSync(directory, { recursive: true, encoding: 'utf8' })
        .filter(file => statSync(join(directory, file)).isFile())
        .sort()
        .map(file => [ file.split(sep).join('/'), readFileSync(join(directory, file), 'utf8') ]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Taking a skill apart

interface Parsed {
    frontmatter: string;
    /** The title and the paragraphs before the first section */
    head: string;
    /** The `##` sections, by heading, each with its heading */
    sections: Map<string, string>;
}

function parse(markdown: string): Parsed {
    let rest = markdown;
    let frontmatter = '';
    if (rest.startsWith('---\n')) {
        const end = rest.indexOf('\n---\n', 4) + '\n---\n'.length;
        frontmatter = rest.slice(0, end);
        rest = rest.slice(end).replace(/^\n/, '');
    }
    const [ head, ...parts ] = rest.split(/^(?=## )/m);
    return { frontmatter, head, sections: new Map(parts.map(part => [ part.split('\n')[0].replace(/^## /, ''), part ])) };
}

function section(parsed: Parsed, heading: string, where: string): string {
    const found = parsed.sections.get(heading);
    if (found === undefined) {
        throw new Error(`${ where }: no section "${ heading }"`);
    }
    return found;
}

/** The text with each `[ from, to ]` replaced, every occurrence; each has to occur at least once. */
function substituted(text: string, substitutions: Array<[ string, string ]>, where: string): string {
    return substitutions.reduce((result, [ from, to ]) => {
        if (! result.includes(from)) {
            throw new Error(`${ where }: ${ JSON.stringify(from) } isn't there`);
        }
        return result.replaceAll(from, to);
    }, text);
}

/** `text` with `paragraph`, which has to be there as it is, replaced with `replacement`, so that a change to it isn't overwritten. */
function replaceParagraph(text: string, paragraph: string, replacement: string, where: string): string {
    if (! text.includes(`${ paragraph }\n\n`)) {
        throw new Error(`${ where }: the paragraph ${ JSON.stringify(paragraph) } has changed; update it and its replacement in build-layouts.ts`);
    }
    return text.replace(`${ paragraph }\n\n`, `${ replacement }\n\n`);
}

const withDescription = (frontmatter: string, description: string) =>
    frontmatter.replace(/^description: ".*"$/m, `description: "${ description }"`);

const descriptionOf = (frontmatter: string) => JSON.parse(/^description: (".*")$/m.exec(frontmatter)![1]) as string;

const sectionsOf = (markdown: string) => markdown.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3));

/** An overview's index entry: the file or skill, a sentence on what it covers, and its `##` sections. */
const indexEntry = (title: string, about: string, markdown: string) =>
    `### ${ title }\n\n${ about }\n\n${ sectionsOf(markdown).map(heading => `- ${ heading }`).join('\n') }\n\n`;

// ---------------------------------------------------------------------------------------------------------------------
// What layouts A and C write their own way

const TABLE_HEAD = 'Serenity/JS tests are written with the Screenplay Pattern. Choose the building block by what the test needs:\n\n| The test needs to | Write | Read |\n|---|---|---|\n';

/** The frontmatter of layout A's skills, which layout B's files don't have */
const A_FRONTMATTER = {
    tasks: `---
name: serenity-js-writing-tasks
description: "Writing Screenplay Pattern tasks with Serenity/JS: composing activities into business-level tasks with Task.where, describing them with the, passing parameters, naming actors, repeating activities with List.of().forEach, pending tasks, tasks that wait for their own outcome with Wait.until, tasks that check their own work with custom expectations, growing the structure of tasks and questions as a project needs it, and refactoring tests that grew without them. Use when adding or changing a task, or a test step that does more than one thing, and when asked to refactor, clean up or restructure tests."
---
`,
    interactionsAndAbilities: `---
name: serenity-js-writing-interactions-and-abilities
description: "Writing Screenplay Pattern interactions and abilities with Serenity/JS: interactions with Interaction.where, abilities that wrap a client of the system under test, retrieving them with Ability.as, abilities that initialise and discard their resources, and interchangeable implementations. Use when adding an interaction, or when the system under test has an interface that no Serenity/JS integration covers."
---
`,
    questions: `---
name: serenity-js-writing-questions
description: "Writing Screenplay Pattern questions with Serenity/JS: retrieving information with Question.about, using the actor's abilities, naming and grouping questions, transforming answers through QuestionAdapter, composing questions, questions about part of something with .of(), custom expectations with Expectation.define, and debugging a scenario with Log.the and StreamReporter. Use when a test or a task needs information about the system under test."
---
`,
};

const C_OVERVIEW_HEAD = `---
name: serenity-js-screenplay-pattern
description: "The Screenplay Pattern in Serenity/JS: actors, abilities, interactions, questions and tasks, how they fit together, naming actors, and which to write. Use when deciding how to structure a test, a step or a piece of test code with Serenity/JS, before writing a task, an interaction, an ability or a question."
---

# The Screenplay Pattern

${ TABLE_HEAD }| Reach a goal of the business domain, or take a step that does several things | a task | the serenity-js-writing-tasks skill |
| Do one thing with the system under test | an interaction | the serenity-js-writing-interactions skill |
| Reach an interface that no Serenity/JS integration covers | an ability | the serenity-js-writing-abilities skill |
| Find out about the system under test, to check it or to wait for it | a question | the serenity-js-writing-questions skill |

`;

/** The paragraph of "Where tasks fit" in layout A, which layouts B and C write with their own cross-references */
const PROJECTS_GET = `Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as
\`BrowseTheWeb\` and \`Click\` from \`@serenity-js/web\`. The serenity-js-writing-interactions-and-abilities skill covers
writing your own, and the serenity-js-writing-questions skill covers questions. The rest of this skill uses the
interactions and the question above.`;

const B_PROJECTS_GET = `Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as
\`BrowseTheWeb\` and \`Click\` from \`@serenity-js/web\`. [interactions-and-abilities.md](references/interactions-and-abilities.md) covers
writing your own, and [questions.md](references/questions.md) covers questions. The other files of this skill use the
interactions and the question above.`;

const C_PROJECTS_GET = `Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as
\`BrowseTheWeb\` and \`Click\` from \`@serenity-js/web\`. The serenity-js-writing-abilities and serenity-js-writing-interactions
skills cover writing your own, and the serenity-js-writing-questions skill covers questions. The other Screenplay skills
use the interactions and the question above.`;

/** What each skill layout C's overview indexes covers, in a sentence, wrapped as the skills are. */
const ABOUT = {
    tasks: `Tasks: composing activities into the goals of the business domain, describing them, waiting for their outcome, and
growing and refactoring the tests they're part of.`,
    interactions: 'Interactions, which do one thing with the system under test.',
    abilities: `Abilities, which wrap the client of an interface no Serenity/JS integration covers, and give interactions and
questions access to it.`,
    questions: 'Questions, which find out about the system under test, and debugging a scenario by what they answer.',
};

const C_INTERACTIONS_HEAD = `---
name: serenity-js-writing-interactions
description: "Writing Screenplay Pattern interactions with Serenity/JS: interactions with Interaction.where, one action each, when two closely related steps are one action, using the integrations' interactions first, with Answerable parameters and descriptions for the report. Use when adding or changing an interaction with the system under test."
---

# Writing Screenplay interactions

An interaction is one thing an actor does with the system under test: dial a number, click a button, send a
request. The serenity-js-writing-abilities skill covers the abilities that enable interactions.

Tests rarely use interactions directly. They use tasks, which compose interactions into goals in the business domain;
the serenity-js-writing-tasks skill covers those.

`;

const C_ABILITIES_HEAD = `---
name: serenity-js-writing-abilities
description: "Writing Screenplay Pattern abilities with Serenity/JS: abilities that wrap a client of the system under test, retrieving them with Ability.as, abilities that initialise and discard their resources, and interchangeable implementations. Use when the system under test has an interface that no Serenity/JS integration covers."
---

# Writing Screenplay abilities

An ability is what enables an actor's interactions. It wraps the client of one of the system's interfaces, such as a browser, an
HTTP client or a phone, and gives the actor's interactions and questions access to it.

Tests rarely use abilities directly. Interactions use them; the serenity-js-writing-interactions skill covers those.

`;

/** Which sections of the interactions-and-abilities skill go to layout C's interactions skill and its abilities skill; its "Avoid" is split between them */
const C_INTERACTIONS_SECTIONS = [ 'Write an interaction with `Interaction.where`' ];
const C_ABILITIES_SECTIONS = [ 'Check whether you need a new ability', 'Wrap the client in an ability', 'Retrieve it with `as`', 'Initialise and discard the resources the ability uses', 'Make implementations interchangeable' ];

/** Where layout A's interactions and questions skills tell the reader the actors' names come from, and layout B's files */
const ACTOR_NAMES = "// your project's actor names, as the serenity-js-writing-tasks skill describes them";
const B_ACTOR_NAMES = "// your project's actor names, as SKILL.md describes them";

/** How layout A's skills refer to each other, and how layout B's reference files, which share references/, link to each other instead: `[ A, B ]` */
const REFERENCES: Record<'tasks' | 'interactionsAndAbilities' | 'questions', Array<[ string, string ]>> = {
    tasks: [
        [ 'from "Where tasks fit"', 'from SKILL.md' ],
        // its references to the grouped questions of serenity-js-writing-questions, Line.connectedNumber() and Line.isConnected()
        [ 'as the serenity-js-writing-questions skill does with', 'as [questions.md](questions.md) does with' ],
    ],
    interactionsAndAbilities: [
        [ 'Tests rarely use either directly. They use tasks, which compose interactions into goals in the business domain;\nthe serenity-js-writing-tasks skill covers those.',
            'Tests rarely use either directly. They use tasks, which compose interactions into goals in the business domain;\n[tasks.md](tasks.md) covers those.' ],
        [ 'Information is what questions are for; the\n  serenity-js-writing-questions skill covers those', 'Information is what questions are for;\n  [questions.md](questions.md) covers those' ],
        [ ACTOR_NAMES, B_ACTOR_NAMES ],
    ],
    questions: [
        [ '// an ability your project already has; the serenity-js-writing-interactions-and-abilities skill covers those', '// an ability your project already has; interactions-and-abilities.md covers those' ],
        [ ACTOR_NAMES, B_ACTOR_NAMES ],
    ],
};

/** Layout B's text with its links rewritten back as layout A's references; each link has to be there */
const asReferences = (text: string, references: Array<[ string, string ]>, where: string) =>
    substituted(text, references.map(([ a, b ]) => [ b, a ]), where);

/** The destinations of a Markdown text's inline links, `[text](destination)`, and link definitions, `[label]: destination`. */
const linkDestinationsIn = (markdown: string) => [
    ...markdown.matchAll(/]\(\s*<?([^\s)>]+)/g),
    ...markdown.matchAll(/^ {0,3}\[[^\]]+]:\s*<?(\S+?)>?(?:\s|$)/gm),
].map(([ , destination ]) => destination);

/**
 * `text`, which goes into layout A from `file` of layout B, once its links have been rewritten as references. A link
 * to one of B's files that's still there would lead nowhere in A's and C's skills, which don't have those files.
 */
function withoutLinksToB(text: string, file: string): string {
    for (const destination of linkDestinationsIn(text)) {
        const target = posix.normalize(posix.join(posix.dirname(file), destination.replace(/[#?].*$/, '')));
        if (! /^[a-z][\d+.a-z-]*:/i.test(destination) && SCREENPLAY_FILES.includes(target)) {
            throw new Error(`layout A: ${ file } links to ${ destination }, a file of the serenity-js-screenplay skill that layouts A and C don't have; add the link to REFERENCES in build-layouts.ts`);
        }
    }
    return text;
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * Layout A, the three skills serenity-js-screenplay was made from, by their paths relative to the skills' directory:
 * each file of serenity-js-screenplay with its frontmatter, its links back as references to the other skills, and
 * the tasks skill with "Where tasks fit", which SKILL.md has as "How the building blocks fit together".
 */
function layoutA(screenplay: CoreSkills): CoreSkills {
    for (const file of SCREENPLAY_FILES) {
        if (! screenplay.has(file)) {
            throw new Error(`the serenity-js-screenplay skill has no ${ file }`);
        }
    }
    for (const file of screenplay.keys()) {
        if (! SCREENPLAY_FILES.includes(file)) {
            throw new Error(`the serenity-js-screenplay skill has ${ file }, which layouts A and C don't have a place for; add it to build-layouts.ts`);
        }
    }
    const howTheyFit = section(parse(screenplay.get('SKILL.md')!), 'How the building blocks fit together', 'SKILL.md')
        .replace(/^## How the building blocks fit together\n\n/, '');
    const tasks = parse(withoutLinksToB(asReferences(screenplay.get('references/tasks.md')!, REFERENCES.tasks, "layout A's serenity-js-writing-tasks"), 'references/tasks.md'));
    const whereTasksFit = '## Where tasks fit\n\n' + withoutLinksToB(replaceParagraph(howTheyFit, B_PROJECTS_GET, PROJECTS_GET, "layout A's serenity-js-writing-tasks"), 'SKILL.md');

    return new Map([
        [ TASKS, A_FRONTMATTER.tasks + '\n' + tasks.head + whereTasksFit + [ ...tasks.sections.values() ].join('') ],
        [ INTERACTIONS_AND_ABILITIES, A_FRONTMATTER.interactionsAndAbilities + '\n'
            + withoutLinksToB(asReferences(screenplay.get('references/interactions-and-abilities.md')!, REFERENCES.interactionsAndAbilities, "layout A's serenity-js-writing-interactions-and-abilities"), 'references/interactions-and-abilities.md') ],
        [ QUESTIONS, A_FRONTMATTER.questions + '\n'
            + withoutLinksToB(asReferences(screenplay.get('references/questions.md')!, REFERENCES.questions, "layout A's serenity-js-writing-questions"), 'references/questions.md') ],
    ]);
}

/**
 * The layouts' core skills, by their paths relative to layouts/, e.g. `b/core/serenity-js-screenplay/references/tasks.md`, built
 * from the serenity-js-screenplay skill: layout B as it is, and layouts A and C with its sections moved between skills.
 */
export function buildLayouts(screenplay: CoreSkills): Map<string, string> {
    const core = layoutA(screenplay);
    const tasks = parse(core.get(TASKS)!);
    const interactionsAndAbilities = parse(core.get(INTERACTIONS_AND_ABILITIES)!);
    const questions = parse(core.get(QUESTIONS)!);

    /** "Where tasks fit", without its heading, which C's overview gives its own */
    const whereTasksFit = section(tasks, 'Where tasks fit', TASKS).replace(/^## Where tasks fit\n\n/, '');
    const tasksAfterWhereTheyFit = [ ...tasks.sections ].filter(([ heading ]) => heading !== 'Where tasks fit').map(([ , text ]) => text).join('');
    const allOf = (parsed: Parsed) => parsed.head + [ ...parsed.sections.values() ].join('');

    const built = new Map<string, string>([
        ...[ ...core ].map(([ file, content ]) => [ `a/core/${ file }`, content ] as [ string, string ]),
        ...[ ...screenplay ].map(([ file, content ]) => [ `b/core/serenity-js-screenplay/${ file }`, content ] as [ string, string ]),
    ]);

    // layout C: a skill for the pattern, and one skill per building block
    const C_ACTOR_NAMES = "// your project's actor names, as the serenity-js-screenplay-pattern skill describes them";
    const cTasks = substituted(withDescription(tasks.frontmatter, descriptionOf(tasks.frontmatter).replace('naming actors, ', '')) + '\n' + tasks.head + tasksAfterWhereTheyFit, [
        [ 'from "Where tasks fit"', 'from the serenity-js-screenplay-pattern skill' ],
    ], "layout C's serenity-js-writing-tasks");
    for (const heading of interactionsAndAbilities.sections.keys()) {
        if (! [ ...C_INTERACTIONS_SECTIONS, ...C_ABILITIES_SECTIONS, 'Avoid' ].includes(heading)) {
            throw new Error(`layout C: the section ${ JSON.stringify(heading) } of ${ INTERACTIONS_AND_ABILITIES } isn't in C's interactions or abilities skill; add it to C_INTERACTIONS_SECTIONS or C_ABILITIES_SECTIONS in build-layouts.ts`);
        }
    }
    const [ usingTheClient, ...interactionBullets ] = section(interactionsAndAbilities, 'Avoid', INTERACTIONS_AND_ABILITIES)
        .replace(/^## Avoid\n\n/, '').trimEnd().split(/\n(?=- \*\*)/);
    const cInteractions = C_INTERACTIONS_HEAD
        + C_INTERACTIONS_SECTIONS.map(heading => section(interactionsAndAbilities, heading, INTERACTIONS_AND_ABILITIES)).join('')
        + `## Avoid\n\n${ interactionBullets.join('\n') }\n`;
    const cAbilities = substituted(C_ABILITIES_HEAD
        + C_ABILITIES_SECTIONS.map(heading => section(interactionsAndAbilities, heading, INTERACTIONS_AND_ABILITIES)).join('')
        + `## Avoid\n\n${ usingTheClient }\n`, [
        [ ACTOR_NAMES, C_ACTOR_NAMES ],
    ], "layout C's serenity-js-writing-abilities");
    const cQuestions = substituted(questions.frontmatter + '\n' + allOf(questions), [
        [ 'the serenity-js-writing-interactions-and-abilities skill covers those', 'the serenity-js-writing-abilities skill covers those' ],
        [ ACTOR_NAMES, C_ACTOR_NAMES ],
    ], "layout C's serenity-js-writing-questions");
    built.set('c/core/serenity-js-screenplay-pattern/SKILL.md', C_OVERVIEW_HEAD
        + '## What each skill covers\n\n'
        + indexEntry('serenity-js-writing-tasks', ABOUT.tasks, cTasks)
        + indexEntry('serenity-js-writing-interactions', ABOUT.interactions, cInteractions)
        + indexEntry('serenity-js-writing-abilities', ABOUT.abilities, cAbilities)
        + indexEntry('serenity-js-writing-questions', ABOUT.questions, cQuestions)
        + '## How the building blocks fit together\n\n'
        + replaceParagraph(whereTasksFit, PROJECTS_GET, C_PROJECTS_GET, "layout C's serenity-js-screenplay-pattern"));
    built.set('c/core/serenity-js-writing-tasks/SKILL.md', cTasks);
    built.set('c/core/serenity-js-writing-interactions/SKILL.md', cInteractions);
    built.set('c/core/serenity-js-writing-abilities/SKILL.md', cAbilities);
    built.set('c/core/serenity-js-writing-questions/SKILL.md', cQuestions);

    return built;
}

/** Replaces the layouts' core skills with the built ones, removing any file the build doesn't have. */
export function writeLayouts(built: Map<string, string>, root: string = join(evalRoot, 'layouts')): void {
    for (const layout of [ 'a', 'b', 'c' ]) {
        rmSync(join(root, layout, 'core'), { recursive: true, force: true });
    }
    for (const [ path, content ] of built) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
}

const USAGE = 'usage: eval:build-layouts -- --serenity-js <clone>';

export function parseBuildArguments(argv: string[], cwd: string): { screenplaySkill: string } {
    const rest = argv.filter(argument => argument !== '--');
    const index = rest.indexOf('--serenity-js');
    const clone = index === -1 ? undefined : rest[index + 1];
    if (! clone || clone.startsWith('--') || rest.length !== 2) {
        throw new Error(USAGE);
    }
    return { screenplaySkill: join(resolve(cwd, clone), 'packages', 'core', 'skills', 'serenity-js-screenplay') };
}

if (import.meta.main) {
    try {
        const { screenplaySkill } = parseBuildArguments(process.argv.slice(2), process.cwd());
        const built = buildLayouts(readScreenplaySkill(screenplaySkill));
        writeLayouts(built);
        console.log(`eval:build-layouts: ${ built.size } files of layouts A, B and C rebuilt from ${ screenplaySkill }`);
    }
    catch (error) {
        console.error(`eval:build-layouts: ${ (error as Error).message }`);
        process.exitCode = 1;
    }
}
