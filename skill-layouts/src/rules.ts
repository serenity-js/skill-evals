// The rules of a specs directory, and the verdicts their patterns give. A rule is rules/<rule>/: a README.md, whose
// frontmatter says what the rule asks for and which practice it comes from, and whose text is the rule and why. A
// pattern rule also has rule.yml, an ast-grep rule that finds violations, and applies.yml, one that finds the code the
// rule applies to, without which it could never pass. A rule with the README alone is the judge's to score. Every rule has examples of each verdict it gives,
// in pass/, fail/ and n-a/, which the same code that scores runs checks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import { Lang, type NapiConfig, parse, type SgNode } from '@ast-grep/napi';
import { parse as parseYaml } from 'yaml';

import type { run as runCommand } from './child-processes.ts';
import type { ChangedFile, SourceFile } from './conventions.ts';
import { Verdict } from './judging/verdict.ts';
import { addedLinesOf } from './project.ts';
import { aString, type Check, expecting, Invalid, oneOf, onlyFields, problemsIn } from './records.ts';

/** Where a violation doesn't count, because the project already did the same before the change */
export type FollowsTheProject = 'file' | 'project';

const FOLLOWS_THE_PROJECT: readonly FollowsTheProject[] = [ 'file', 'project' ];

const isTypeScript = (file: SourceFile) => file.path.endsWith('.ts');

/** What a run, or an example, changed: the files it added lines to, as it left them, and the project's files before it. */
export class Change {

    static of(files: readonly ChangedFile[], before: readonly SourceFile[] = []): Change {
        return new Change(files, before);
    }

    /** A file that's new, every line of it, in a project that had nothing before: a single-file example */
    static ofNewFile(path: string, content: string): Change {
        const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
        return new Change([ { path, content, addedLines: new Set(Array.from({ length: lines }, (_, index) => index + 1)) } ], []);
    }

    readonly files: readonly ChangedFile[];
    readonly before: readonly SourceFile[];

    private constructor(files: readonly ChangedFile[], before: readonly SourceFile[]) {
        this.files = files;
        this.before = before;
    }
}

/** Something a pattern found, in a file of a change */
class Finding {

    readonly file: SourceFile;
    readonly node: SgNode;
    /** Whether the change added any of the finding's lines */
    readonly isAdded: boolean;

    constructor(file: SourceFile, node: SgNode, addedLines: ReadonlySet<number>) {
        this.file = file;
        this.node = node;
        const { start, end } = node.range();
        this.isAdded = Array.from({ length: end.line - start.line + 1 }, (_, index) => start.line + 1 + index).some(line => addedLines.has(line));
    }

    /** As conventions.ts gives its evidence: `<file>:<line>: <the code's first line>` */
    toString(): string {
        return `${ this.file.path }:${ this.node.range().start.line + 1 }: ${ this.node.text().split('\n')[0].trim() }`;
    }
}

/** What the patterns decided about a change, and the code they decided it from. */
export class PatternVerdict {

    static of(verdict: Verdict, evidence: readonly string[]): PatternVerdict {
        return new PatternVerdict(verdict, evidence);
    }

    readonly verdict: Verdict;
    /** The violations, for a fail, or the code the rule applies to, for a pass, as `<file>:<line>: <code>` */
    readonly evidence: readonly string[];

    private constructor(verdict: Verdict, evidence: readonly string[]) {
        this.verdict = verdict;
        this.evidence = evidence;
    }

    /** As validate reports it: `fail, from src/a.ts:3: a == b` */
    toString(): string {
        return this.evidence.length > 0 ? `${ this.verdict }, from ${ this.evidence.join(', ') }` : `${ this.verdict }`;
    }

    toJSON(): { verdict: string, evidence: readonly string[] } {
        return { verdict: this.verdict.name, evidence: this.evidence };
    }
}

/**
 * Which violations don't count, by followsTheProject. With `file`, those in a file that had one on a line the change
 * didn't add. With `project`, all of them, when any file had one before the change, or a changed file has one on a
 * line the change didn't add. That's what conventions.ts's alreadyIn and actorNamesBefore do for two of its items.
 */
const EXEMPTIONS: Record<FollowsTheProject, (violations: readonly Finding[], hadBefore: () => boolean) => (violation: Finding) => boolean> = {
    file: violations => {
        const following = new Set(violations.filter(violation => ! violation.isAdded).map(violation => violation.file.path));
        return violation => following.has(violation.file.path);
    },
    project: (violations, hadBefore) => {
        const following = violations.some(violation => ! violation.isAdded) || hadBefore();
        return () => following;
    },
};

/**
 * A rule's ast-grep patterns: rule.yml's, which find violations, and applies.yml's, which find the code the rule
 * applies to. Only the lines a change added count: it fails when a violation is on one, passes otherwise when code the
 * rule applies to is, and is n/a otherwise, as conventions.ts decides.
 */
export class RulePatterns {

    static of({ violations, applies, followsTheProject }: { violations: NapiConfig, applies: NapiConfig, followsTheProject?: FollowsTheProject }): RulePatterns {
        return new RulePatterns(violations, applies, followsTheProject);
    }

    readonly violations: NapiConfig;
    readonly applies: NapiConfig;
    readonly followsTheProject: FollowsTheProject | undefined;

    private constructor(violations: NapiConfig, applies: NapiConfig, followsTheProject: FollowsTheProject | undefined) {
        this.violations = violations;
        this.applies = applies;
        this.followsTheProject = followsTheProject;
    }

    verdictOn(change: Change): PatternVerdict {
        const roots = change.files.filter(isTypeScript).map(file => ({ file, root: parse(Lang.TypeScript, file.content).root() }));
        const found = (config: NapiConfig) => roots.flatMap(({ file, root }) => root.findAll(config).map(node => new Finding(file, node, file.addedLines)));

        const violations = found(this.violations);
        const hadBefore = () => change.before.filter(isTypeScript).some(file => parse(Lang.TypeScript, file.content).root().find(this.violations) !== null);
        const isExempt = this.followsTheProject ? EXEMPTIONS[this.followsTheProject](violations, hadBefore) : () => false;
        const bad = violations.filter(violation => violation.isAdded && ! isExempt(violation));
        if (bad.length > 0) {
            return PatternVerdict.of(Verdict.fail, bad.map(String));
        }
        const good = found(this.applies).filter(finding => finding.isAdded);
        return good.length > 0 ? PatternVerdict.of(Verdict.pass, good.map(String)) : PatternVerdict.of(Verdict.notApplicable, []);
    }
}

/** `git diff --no-index` between the before/ and after/ of the directory given, as `git diff` would show a run's change. */
export type DirectoryDiff = (directory: string) => string;

/** A DirectoryDiff that runs git, with the given runner. git exits with 1 when the directories differ, which is no failure. */
export function gitDirectoryDiff(run: typeof runCommand): DirectoryDiff {
    return directory => {
        try {
            return run('git', [ '-c', 'core.quotePath=false', 'diff', '--no-index', '--no-renames', '--no-ext-diff', '--no-color', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', '--', 'before', 'after' ], { cwd: directory });
        }
        catch (error) {
            const { status, stdout } = error as { status?: number, stdout?: string };
            if (status === 1 && stdout !== undefined) {
                return stdout;
            }
            throw error;
        }
    };
}

/** The files in a directory, by their paths relative to it, with `/` between directories, in order. */
export function filesIn(directory: string): SourceFile[] {
    if (! isDirectory(directory)) {
        return [];
    }
    return readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name))
        .sort()
        .map(file => ({ path: relative(directory, file).split(sep).join('/'), content: readFileSync(file, 'utf8') }));
}

/**
 * An example of a rule, and the verdict it must get. It's a .ts file, which is all added lines, with nothing before it;
 * or a directory with after/, and optionally before/, whose added lines are the difference, with request.md and
 * reply.md for a rule about the request or what the agent said.
 */
export class Example {

    static at(location: string, path: string, expected: Verdict): Example {
        return new Example(location, path, expected);
    }

    /** Where it is */
    readonly location: string;
    /** As problems name it, relative to the specs directory */
    readonly path: string;
    readonly expected: Verdict;

    private constructor(location: string, path: string, expected: Verdict) {
        this.location = location;
        this.path = path;
        this.expected = expected;
    }

    changeWith(diff: DirectoryDiff): Change {
        if (! isDirectory(this.location)) {
            return Change.ofNewFile(basename(this.location), readFileSync(this.location, 'utf8'));
        }
        const after = join(this.location, 'after');
        const before = join(this.location, 'before');
        if (! isDirectory(before)) {
            return Change.of(filesIn(after).map(file => Change.ofNewFile(file.path, file.content).files[0]));
        }
        const added = [ ...addedLinesOf(diff(this.location)) ].map(([ path, lines ]) => [ path.replace(/^after\//, ''), lines ] as const);
        const content = new Map(filesIn(after).map(file => [ file.path, file.content ]));
        return Change.of(added.map(([ path, addedLines ]) => ({ path, content: content.get(path)!, addedLines })), filesIn(before));
    }
}

/** The example directories of a rule, and the verdict each one's examples must get, in the order they're checked */
const EXAMPLE_VERDICTS = [
    { directory: 'pass', verdict: Verdict.pass },
    { directory: 'fail', verdict: Verdict.fail },
    { directory: 'n-a', verdict: Verdict.notApplicable },
] as const;

const RULE_ENTRIES: Entries = {
    'README.md': 'file', 'rule.yml': 'file', 'applies.yml': 'file',
    ...Object.fromEntries(EXAMPLE_VERDICTS.map(({ directory }) => [ directory, 'directory' ])),
};
const EXAMPLE_ENTRIES: Entries = { before: 'directory', after: 'directory', 'request.md': 'file', 'reply.md': 'file' };

const PATTERN_OR_JUDGE = 'a pattern rule has both, and a rule the judge scores has README.md only';

/** The frontmatter of a rule's README.md */
export interface RuleFrontmatter {
    /** One line: what the rule asks for */
    title: string;
    /** The practice it comes from, as <package>/<skill>/<path>#<section> */
    source: string;
    followsTheProject?: FollowsTheProject;
}

/** A skill's file, as <package>/<skill>/<path>, such as `@scope/package/a-skill/references/a-file.md` */
export const SKILL_FILE = /^(@[\w.-]+\/)?[\w.-]+\/[\w.-]+\/[^#\s]+$/;
const SKILL_SECTION = /^(@[\w.-]+\/)?[\w.-]+\/[\w.-]+\/[^#\s]+#\S+$/;

const aTitle = expecting('a line of text', value => typeof value === 'string' && value.trim() !== '' && ! value.includes('\n'));
const FRONTMATTER = onlyFields(
    { title: aTitle, source: expecting('a section of a skill file, as <package>/<skill>/<path>#<section>', value => typeof value === 'string' && SKILL_SECTION.test(value)) },
    { followsTheProject: oneOf(FOLLOWS_THE_PROJECT) },
);
// with \r\n too, as a checkout with core.autocrlf has its files
const FRONTMATTER_LINES = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;

const anObject = expecting('an object', value => typeof value === 'object' && value !== null && ! Array.isArray(value));
const refused = (why: string): Check => (_, path, file) => {
    throw new Invalid([ `${ file }: ${ path } isn't allowed: ${ why }` ]);
};
const ruleFile = (id: string, what: string) => onlyFields(
    { id: expecting(`${ id }, ${ what }`, value => value === id), language: expecting('TypeScript', value => value === 'TypeScript'), rule: anObject },
    { constraints: anObject, utils: anObject, message: aString, note: aString, fix: refused('a rule finds code, and changes none'), transform: refused('a rule finds code, and changes none') },
);

export const isFile = (location: string) => existsSync(location) && statSync(location).isFile();
export const isDirectory = (location: string) => existsSync(location) && statSync(location).isDirectory();

/** The names in a directory, in order, leaving out hidden ones, such as .DS_Store; none when it isn't a directory */
const entriesIn = (directory: string): string[] => isDirectory(directory) ? readdirSync(directory).filter(name => ! name.startsWith('.')).sort() : [];

/** The entries a directory may have, each a file or a directory */
export type Entries = Record<string, 'file' | 'directory'>;

/** What's wrong with a directory's entries: those it must have and doesn't, those of the wrong kind, and anything else. */
export function entryProblems(directory: string, shown: string, { entries, required, what }: { entries: Entries, required: readonly string[], what: string }): string[] {
    const found = entriesIn(directory);
    return [
        ...required.filter(name => ! found.includes(name)).map(name => `${ shown }/${ name } is missing`),
        ...found.flatMap(name => {
            if (! Object.hasOwn(entries, name)) {
                return [ `${ shown }/${ name } isn't part of ${ what }` ];
            }
            const kind = isDirectory(join(directory, name)) ? 'directory' : 'file';
            return kind === entries[name] ? [] : [ `${ shown }/${ name } is a ${ kind }, not a ${ entries[name] }` ];
        }),
    ];
}

/** `text` with its lines joined, as one problem: ast-grep's and YAML's errors take several */
const oneLine = (text: string) => text.split('\n').map(line => line.replace(/^\s*\|->/, '').trim()).filter(Boolean).join(' ');

/** A rule of a specs directory, and what's wrong with its files. */
export class Rule {

    /** Reads rules/<name>/, in `directory`, naming its files by `shown`, the rule's path in the specs directory */
    static read(directory: string, name: string, shown: string): Rule {
        const problems: string[] = entryProblems(directory, shown, { entries: RULE_ENTRIES, required: [ 'README.md' ], what: 'a rule, which holds README.md, rule.yml, applies.yml, pass/, fail/ and n-a/' });

        const readme = join(directory, 'README.md');
        const { frontmatter, text, problems: readmeProblems } = isFile(readme) ? Rule.readme(readFileSync(readme, 'utf8'), `${ shown }/README.md`) : { frontmatter: undefined, text: '', problems: [] };
        problems.push(...readmeProblems);

        const hasRule = existsSync(join(directory, 'rule.yml'));
        const violations = isFile(join(directory, 'rule.yml')) ? Rule.ruleFile(join(directory, 'rule.yml'), `${ shown }/rule.yml`, name, "the rule's directory", problems) : undefined;
        const hasApplies = existsSync(join(directory, 'applies.yml'));
        if (hasRule !== hasApplies) {
            problems.push(hasRule
                ? `${ shown } has rule.yml, but no applies.yml: ${ PATTERN_OR_JUDGE }`
                : `${ shown } has applies.yml, but no rule.yml: ${ PATTERN_OR_JUDGE }`);
        }
        const applies = isFile(join(directory, 'applies.yml')) && hasRule
            ? Rule.ruleFile(join(directory, 'applies.yml'), `${ shown }/applies.yml`, `${ name }.applies`, "the rule's directory and .applies", problems)
            : undefined;
        if (frontmatter?.followsTheProject && ! hasRule) {
            problems.push(`${ shown }/README.md: followsTheProject only applies to a rule.yml's violations, and the rule has no rule.yml`);
        }

        const examples = EXAMPLE_VERDICTS.flatMap(({ directory: kind, verdict }) => entriesIn(join(directory, kind))
            .flatMap(entry => Rule.example(join(directory, kind, entry), `${ shown }/${ kind }/${ entry }`, verdict, problems) ?? []));
        // an example that isn't one is reported already, so it counts as one here
        problems.push(...EXAMPLE_VERDICTS.filter(({ verdict }) => verdict !== Verdict.notApplicable)
            .filter(({ directory: kind }) => entriesIn(join(directory, kind)).length === 0)
            .map(({ directory: kind }) => `${ shown } has no ${ kind }/ example: every rule has at least one pass/ and one fail/`));

        // a rule whose files are wrong isn't run on its examples, since the verdicts would only repeat what's wrong with it
        const patterns = violations && applies && frontmatter && problems.length === 0
            ? RulePatterns.of({ violations, applies, followsTheProject: frontmatter.followsTheProject })
            : undefined;
        return new Rule(name, frontmatter, text, patterns, examples, problems);
    }

    /** The example at `location`, or undefined, with why in `problems`, when it isn't one */
    private static example(location: string, path: string, verdict: Verdict, problems: string[]): Example | undefined {
        if (! isDirectory(location)) {
            if (! location.endsWith('.ts')) {
                problems.push(`${ path } isn't an example: one is a .ts file, or a directory with after/`);
                return undefined;
            }
            return Example.at(location, path, verdict);
        }
        if (! entriesIn(location).some(entry => Object.hasOwn(EXAMPLE_ENTRIES, entry))) {
            problems.push(`${ path } isn't an example: one is a .ts file, or a directory with after/`);
            return undefined;
        }
        problems.push(...entryProblems(location, path, { entries: EXAMPLE_ENTRIES, required: [ 'after' ], what: 'an example, which holds before/, after/, request.md and reply.md' }));
        return isDirectory(join(location, 'after')) ? Example.at(location, path, verdict) : undefined;
    }

    private static readme(content: string, file: string): { frontmatter: RuleFrontmatter | undefined, text: string, problems: string[] } {
        const lines = FRONTMATTER_LINES.exec(content);
        if (! lines) {
            return { frontmatter: undefined, text: content, problems: [ `${ file } has no frontmatter: it starts with a line of ---, then the title and the source, then ---` ] };
        }
        const text = content.slice(lines[0].length).trim();
        try {
            const frontmatter: unknown = parseYaml(lines[1]);
            const problems = problemsIn(frontmatter, FRONTMATTER, file);
            return { frontmatter: problems.length === 0 ? frontmatter as RuleFrontmatter : undefined, text, problems };
        }
        catch (error) {
            return { frontmatter: undefined, text, problems: [ `${ file }'s frontmatter isn't YAML: ${ oneLine((error as Error).message) }` ] };
        }
    }

    /** rule.yml or applies.yml, as the configuration @ast-grep/napi takes, when it's what the harness takes and ast-grep can use it */
    private static ruleFile(location: string, file: string, id: string, what: string, problems: string[]): NapiConfig | undefined {
        let parsed: unknown;
        try {
            parsed = parseYaml(readFileSync(location, 'utf8'));
        }
        catch (error) {
            problems.push(`${ file } isn't YAML: ${ oneLine((error as Error).message) }`);
            return undefined;
        }
        const found = problemsIn(parsed, ruleFile(id, what), file);
        if (found.length > 0) {
            problems.push(...found);
            return undefined;
        }
        const { rule, constraints, utils } = parsed as NapiConfig;
        const config: NapiConfig = { rule, ...(constraints ? { constraints } : {}), ...(utils ? { utils } : {}) };
        try {
            parse(Lang.TypeScript, '').root().findAll(config);
            return config;
        }
        catch (error) {
            problems.push(`${ file }: ast-grep can't use its rule: ${ oneLine((error as Error).message) }`);
            return undefined;
        }
    }

    readonly name: string;
    /** Undefined when the README has none, or it's wrong */
    readonly frontmatter: RuleFrontmatter | undefined;
    /** The README after the frontmatter: the rule and why, for the judge and for people */
    readonly text: string;
    /** rule.yml's and applies.yml's patterns; undefined for a rule the judge scores, or one whose files are wrong */
    readonly patterns: RulePatterns | undefined;
    readonly examples: readonly Example[];
    /** What's wrong with the rule's files, each with its path in the specs directory */
    readonly problems: readonly string[];

    private constructor(name: string, frontmatter: RuleFrontmatter | undefined, text: string, patterns: RulePatterns | undefined, examples: readonly Example[], problems: readonly string[]) {
        this.name = name;
        this.frontmatter = frontmatter;
        this.text = text;
        this.patterns = patterns;
        this.examples = examples;
        this.problems = problems;
    }

    /**
     * Each example the patterns give another verdict than its directory says, with the verdict and its evidence. The
     * judge's rules have none: CI doesn't judge their examples, since a judge session costs credits.
     */
    exampleProblems(diff: DirectoryDiff): string[] {
        const patterns = this.patterns;
        if (! patterns) {
            return [];
        }
        return this.examples.flatMap(example => {
            let verdict: PatternVerdict;
            try {
                verdict = patterns.verdictOn(example.changeWith(diff));
            }
            catch (error) {
                return [ `${ example.path }: the rule can't be scored on it: ${ oneLine((error as Error).message) }` ];
            }
            if (verdict.verdict === example.expected) {
                return [];
            }
            return [ `${ example.path }: the rule's verdict is ${ verdict }, not ${ example.expected }` ];
        });
    }
}
