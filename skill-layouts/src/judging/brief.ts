// What the judge is given about one change, as a value: the files of its directory, with their contents, and the
// projects before and after the change, as the directories they're in. JudgeWorkspace writes it; nothing here touches
// the filesystem.
import { createHash } from 'node:crypto';

import type { Blinding } from '../review.ts';
import type { JudgePrompt } from './judge.ts';
import { Fingerprint, type JudgeIdentity } from './session-store.ts';
import type { StartingProject } from './starting-project.ts';

/** A rule, as the judge reads it: its id, and its README, which says what it asks for and how earlier decisions settled it. */
export interface JudgeRule {
    id: string;
    readme: string;
}

/** A file of the judge's directory, by its path in it. */
export interface BriefFile {
    path: string;
    content: string;
}

const NO_REPLY = '(none: the agent said nothing after its last tool call)';

/** What the judge is given about one change. */
export class JudgeBrief {

    /**
     * The brief of a change: the request, with the local API server's URLs filled in, the diff and the reply, blinded,
     * every rule, those the request exercises first, and the reference solution's files, by their paths in the project,
     * without the marker of their expected value. Without its project, as for a recorded run whose project can't be
     * rebuilt any more, the judge scores the change from its diff, as the reviewer's packet had it.
     */
    static of(
        { request, diff, reply, rules, exercised, reference, project }: { request: string, diff: string, reply: string, rules: readonly JudgeRule[], exercised: readonly string[], reference: ReadonlyMap<string, string>, project?: StartingProject },
        blinding: Blinding,
    ): JudgeBrief {
        return new JudgeBrief([
            { path: 'request.md', content: `${ request.trim() }\n` },
            { path: 'change.diff', content: blinding.blind(diff) },
            { path: 'reply.md', content: `${ blinding.blind(reply).trim() || NO_REPLY }\n` },
            ...rules.map(rule => ({ path: `rules/${ rule.id }/README.md`, content: `${ rule.readme.trim() }\n` })),
            { path: 'rules.md', content: JudgeBrief.rulesList(rules, exercised) },
            ...[ ...reference ].map(([ file, content ]) => ({ path: `reference/${ file }`, content })),
        ], project);
    }

    /** rules.md: the rules the request exercises, then the others */
    private static rulesList(rules: readonly JudgeRule[], exercised: readonly string[]): string {
        const listed = (some: readonly JudgeRule[]) => some.map(rule => `- [${ rule.id }](rules/${ rule.id }/README.md)`);
        return [
            '# The rules',
            '',
            '## The rules the request exercises',
            '',
            ...listed(rules.filter(rule => exercised.includes(rule.id))),
            '',
            '## The other rules, which apply wherever the added code is about them',
            '',
            ...listed(rules.filter(rule => ! exercised.includes(rule.id))),
            '',
        ].join('\n');
    }

    private readonly written: readonly BriefFile[];
    private readonly project: StartingProject | undefined;

    private constructor(written: readonly BriefFile[], project: StartingProject | undefined) {
        this.written = written;
        this.project = project;
    }

    /** Each file of the judge's directory but the projects, with its content */
    files(): readonly BriefFile[] {
        return this.written;
    }

    /** The project as the agent found it, if it could be rebuilt */
    get before(): string | undefined {
        return this.project?.before;
    }

    /** The project as the agent left it, if it could be rebuilt */
    get after(): string | undefined {
        return this.project?.after;
    }

    hasProject(): boolean {
        return this.project !== undefined;
    }

    /** What a session of `judge`, given `prompt`, on this brief is reused by: the hash of the three */
    fingerprint(judge: JudgeIdentity, prompt: JudgePrompt): Fingerprint {
        const hash = createHash('sha256').update(JSON.stringify(judge)).update('\0').update(prompt.text).update('\0');
        for (const file of [ ...this.written ].sort((one, other) => one.path.localeCompare(other.path))) {
            hash.update(file.path).update('\0').update(file.content).update('\0');
        }
        hash.update(this.project ? `before ${ this.project.hashes.before }\0after ${ this.project.hashes.after }` : 'no project');
        return Fingerprint.of(hash.digest('hex'));
    }
}
