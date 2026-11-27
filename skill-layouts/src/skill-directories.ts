// Where skills are kept: the project directories the agents read skills from, as each agent's adapter declares them,
// and the packed packages' own skills/, in node_modules. A skill file is `<root>/<skill>/<file>.md` in one of them,
// which is how the streams' reads are recognised, and what the review packets and the judge's inputs hide.

/** What an adapter says about where its agent reads skills from. */
export interface ReadsSkills {
    skills: { reads: readonly string[] };
}

/** `text`, to match as it is in a regular expression */
export const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The directories skills are kept in, each holding a directory per skill. */
export class SkillDirectories {

    static of(roots: readonly string[]): SkillDirectories {
        return new SkillDirectories(roots);
    }

    /** The directories `agents` read skills from, and each of `packages`' own skills/, in node_modules */
    static readBy(agents: readonly ReadsSkills[], packages: readonly string[]): SkillDirectories {
        return new SkillDirectories([ ...new Set([ ...agents.flatMap(agent => agent.skills.reads), ...packages.map(name => `node_modules/${ name }/skills`) ]) ]);
    }

    readonly roots: readonly string[];

    private readonly anyRoot: string;

    private constructor(roots: readonly string[]) {
        this.roots = roots;
        this.anyRoot = `(?:${ roots.map(escaped).join('|') })`;
    }

    /** The skill files `text` names, such as a shell command, each as `<skill>/<file>`, in the order it names them */
    filesIn(text: string): string[] {
        return [ ...text.replaceAll('\\', '/').matchAll(new RegExp(`${ this.anyRoot }\\/([\\w.-]+)\\/([\\w./-]+\\.md)`, 'g')) ]
            .map(([ , skill, file ]) => `${ skill }/${ file }`);
    }

    /** The skill file a path leads to, as `<skill>/<file>`, or `undefined` when it isn't a skill's Markdown file */
    fileIn(path: string): string | undefined {
        const [ file ] = this.filesIn(path);
        return file;
    }

    /** `text` with every path into a skill directory, and whatever of it follows, replaced by `replacement` */
    withPathsReplaced(text: string, replacement: string): string {
        return text.replace(new RegExp(`${ this.anyRoot }\\/[\\w./-]*`, 'g'), replacement);
    }
}
