// A specs directory: what the harness evaluates, kept apart from the harness, such as serenity-js/skill-specs.
// cases/<case>/ is a request, with its prompt.md, its case.json and its reference solution in expected/;
// projects/<project>/ is a starting project, with its project.json, and the fixture/ copied over its template; and
// rules/<rule>/ is a rule, as rules.ts reads it. Specs.read loads one, and validate says everything that's wrong with
// it, each problem with its file, without a template, a checkout or the network.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Api, APIS } from './outcome.ts';
import { aString, type Check, entriesOf, expecting, listOf, oneOf, onlyFields, parseJson, problemsIn } from './records.ts';
import { madeWrong, markersIn, referenceFilesOf } from './references.ts';
import { type DirectoryDiff, type Entries, entryProblems, isDirectory, isFile, Rule, SKILL_FILE } from './rules.ts';

/** cases/<case>/case.json. The prompt is cases/<case>/prompt.md, and the reference solution is cases/<case>/expected/ */
export interface CaseDefinition {
    /** What kind of request it is, for people reading the results */
    kind: string;
    /** The starting project: projects/<project> */
    project: string;
    /** The rules whose right answer the case exercises. Every rule is scored on every run, whether the case lists it or not */
    rules: string[];
    /**
     * The skill files an agent has to read, as <package>/<skill>/<path>. An empty list makes the case a control: its
     * loading passes only when the run reads no skill file
     */
    skills: string[];
    /** The local API server's APIs its scenarios call, which the harness probes when npm test fails */
    apis: Api[];
}

/** projects/<project>/project.json. projects/<project>/fixture/, when there is one, is copied over the template */
export interface ProjectDefinition {
    template: {
        /** Such as `https://github.com/serenity-js/serenity-js-mocha-template` */
        repository: string;
        commit: string;
    };
    /**
     * Text to replace before the run's first commit, so that the agent's diff doesn't contain the change. {{mathjs}}
     * and {{frankfurter}} are the local API server's URLs
     */
    replacements?: Array<{ file: string, text: string, with: string }>;
    /** Directories the project's code reads and writes, by environment variable, such as { JOBS_DIR: 'jobs' } */
    directories?: Record<string, string>;
    /** Paths the project's tests write, such as `reports/`, left out of the diff */
    ignored?: string[];
}

const CASE = onlyFields({
    kind: aString,
    project: aString,
    rules: listOf(aString),
    skills: listOf(expecting('a skill file, as <package>/<skill>/<path>', value => typeof value === 'string' && SKILL_FILE.test(value))),
    apis: listOf(oneOf(APIS)),
});

const PROJECT = onlyFields(
    { template: onlyFields({ repository: aString, commit: aString }) },
    {
        replacements: listOf(onlyFields({ file: aString, text: aString, with: aString })),
        directories: entriesOf(aString),
        ignored: listOf(aString),
    },
);

/** `location`'s JSON, as `file` names it, when it passes the check; otherwise undefined, with what's wrong with it in `problems` */
function readJson<T>(location: string, file: string, check: Check, problems: string[]): T | undefined {
    try {
        const json = parseJson(readFileSync(location, 'utf8'), file);
        const found = problemsIn(json, check, file);
        problems.push(...found);
        return found.length === 0 ? json as T : undefined;
    }
    catch (error) {
        problems.push((error as Error).message);
        return undefined;
    }
}

/** A case: the request an agent gets, the project it starts from, and its reference solution. */
export class Case {

    static read(directory: string, name: string, shown: string, problems: string[]): Case | undefined {
        problems.push(...entryProblems(directory, shown, { entries: CASE_ENTRIES, required: Object.keys(CASE_ENTRIES), what: 'a case, which holds prompt.md, case.json and expected/' }));
        const definition = isFile(join(directory, 'case.json')) ? readJson<CaseDefinition>(join(directory, 'case.json'), `${ shown }/case.json`, CASE, problems) : undefined;
        const expected = join(directory, 'expected');
        if (isDirectory(expected)) {
            problems.push(...Case.markerProblems(expected, `${ shown }/expected`));
        }
        const prompt = join(directory, 'prompt.md');
        return definition && isFile(prompt) ? new Case(name, shown, definition, readFileSync(prompt, 'utf8'), expected) : undefined;
    }

    /** At most one `// wrong:` marker, with the value it makes wrong on its line; a reference without one is only checked to pass */
    private static markerProblems(expected: string, shown: string): string[] {
        const files = referenceFilesOf('.', expected);
        const markers = markersIn(files);
        if (markers.length > 1) {
            return [ `${ shown } has ${ markers.length } markers of its expected value, and may have one at most` ];
        }
        try {
            if (markers.length === 1) {
                madeWrong(files);
            }
            return [];
        }
        catch (error) {
            return [ `${ shown }/${ (error as Error).message }` ];
        }
    }

    readonly name: string;
    /** Its path in the specs directory, as problems name it */
    readonly shown: string;
    readonly definition: CaseDefinition;
    readonly prompt: string;
    /** Its reference solution's directory */
    readonly expected: string;

    private constructor(name: string, shown: string, definition: CaseDefinition, prompt: string, expected: string) {
        this.name = name;
        this.shown = shown;
        this.definition = definition;
        this.prompt = prompt;
        this.expected = expected;
    }

    /** What the case names that the specs don't have: its project, and its rules, by the names of their directories */
    referenceProblems(projects: ReadonlySet<string>, rules: ReadonlySet<string>): string[] {
        const file = `${ this.shown }/case.json`;
        return [
            ...(projects.has(this.definition.project) ? [] : [ `${ file }: project is "${ this.definition.project }", which isn't in projects/` ]),
            ...this.definition.rules.flatMap((rule, index) => rules.has(rule) ? [] : [ `${ file }: rules[${ index }] is "${ rule }", which isn't in rules/` ]),
        ];
    }
}

/** A starting project: a template at a commit, with a fixture copied over it. */
export class Project {

    static read(directory: string, name: string, shown: string, problems: string[]): Project | undefined {
        const file = join(directory, 'project.json');
        if (! isFile(file)) {
            problems.push(`${ shown }/project.json ${ existsSync(file) ? 'is a directory, not a file' : 'is missing' }`);
            return undefined;
        }
        const definition = readJson<ProjectDefinition>(file, `${ shown }/project.json`, PROJECT, problems);
        const fixture = join(directory, 'fixture');
        return definition ? new Project(name, definition, isDirectory(fixture) ? fixture : undefined) : undefined;
    }

    readonly name: string;
    readonly definition: ProjectDefinition;
    /** The directory copied over the template, when there is one */
    readonly fixture: string | undefined;

    private constructor(name: string, definition: ProjectDefinition, fixture: string | undefined) {
        this.name = name;
        this.definition = definition;
        this.fixture = fixture;
    }
}

const CASE_ENTRIES: Entries = { 'prompt.md': 'file', 'case.json': 'file', expected: 'directory' };

const TOP_LEVEL = [ 'cases', 'rules', 'projects' ] as const;

/** A specs directory, with everything wrong with it. */
export class Specs {

    /** Reads the specs in `directory`; `diff` gives the added lines of the rules' directory examples */
    static read(directory: string, diff: DirectoryDiff): Specs {
        const problems: string[] = TOP_LEVEL
            .filter(name => ! isDirectory(join(directory, name)))
            .map(name => `${ name }/ is missing: a specs directory has cases/, rules/ and projects/`);

        const names = (top: typeof TOP_LEVEL[number]) => {
            const location = join(directory, top);
            return isDirectory(location) ? readdirSync(location).filter(name => ! name.startsWith('.') && isDirectory(join(location, name))) : [];
        };
        const each = <T>(top: typeof TOP_LEVEL[number], what: string, read: (location: string, name: string, shown: string) => T | undefined): Map<string, T> => {
            const location = join(directory, top);
            const entries = isDirectory(location) ? readdirSync(location).filter(name => ! name.startsWith('.')).sort() : [];
            return new Map(entries.flatMap(name => {
                if (! isDirectory(join(location, name))) {
                    problems.push(`${ top }/${ name } isn't ${ what }: ${ top }/ holds a directory for each`);
                    return [];
                }
                const read_ = read(join(location, name), name, `${ top }/${ name }`);
                return read_ === undefined ? [] : [ [ name, read_ ] as const ];
            }));
        };
        const cases = each('cases', 'a case', (location, name, shown) => Case.read(location, name, shown, problems));
        const projects = each('projects', 'a project', (location, name, shown) => Project.read(location, name, shown, problems));
        const rules = each('rules', 'a rule', (location, name, shown) => {
            const rule = Rule.read(location, name, shown);
            problems.push(...rule.problems);
            return rule;
        });
        problems.push(...[ ...cases.values() ].flatMap(each => each.referenceProblems(new Set(names('projects')), new Set(names('rules')))));
        return new Specs(directory, cases, projects, rules, problems, diff);
    }

    readonly directory: string;
    readonly cases: ReadonlyMap<string, Case>;
    readonly projects: ReadonlyMap<string, Project>;
    readonly rules: ReadonlyMap<string, Rule>;
    private readonly problems: readonly string[];
    private readonly diff: DirectoryDiff;

    private constructor(directory: string, cases: ReadonlyMap<string, Case>, projects: ReadonlyMap<string, Project>, rules: ReadonlyMap<string, Rule>, problems: readonly string[], diff: DirectoryDiff) {
        this.directory = directory;
        this.cases = cases;
        this.projects = projects;
        this.rules = rules;
        this.problems = problems;
        this.diff = diff;
    }

    /**
     * Everything that's wrong with the specs, each with its file: their layout and their files' fields; what the cases
     * name that isn't there; the reference solutions' markers; and every example a pattern rule gives another verdict
     * than its directory says. None means the specs can be used.
     */
    validate(): string[] {
        return [
            ...this.problems,
            ...[ ...this.rules.values() ].flatMap(rule => rule.exampleProblems(this.diff)),
        ];
    }
}
