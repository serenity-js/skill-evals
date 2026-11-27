import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJson } from '../results.ts';
import { type JudgeDirectory, type JudgePrompt, JudgeSession } from './judge.ts';

/** The judge a session ran: its agent, its model and the agent's version. */
export class JudgeIdentity {

    static of(agent: string, model: string, version: string): JudgeIdentity {
        return new JudgeIdentity(agent, model, version);
    }

    readonly agent: string;
    readonly model: string;
    readonly version: string;

    private constructor(agent: string, model: string, version: string) {
        this.agent = agent;
        this.model = model;
        this.version = version;
    }

    toJSON(): { agent: string, model: string, version: string } {
        return { agent: this.agent, model: this.model, version: this.version };
    }
}

/** What a session is reused by: the hash of the judge, the prompt, and everything in the judge's directory. */
export class Fingerprint {

    static of(identity: JudgeIdentity, prompt: JudgePrompt, directory: JudgeDirectory): Fingerprint {
        return new Fingerprint(createHash('sha256')
            .update(JSON.stringify(identity)).update('\0')
            .update(prompt.text).update('\0')
            .update(directory.hash())
            .digest('hex'));
    }

    readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    equals(other: Fingerprint | string | undefined): boolean {
        return (other instanceof Fingerprint ? other.value : other) === this.value;
    }

    toJSON(): string {
        return this.value;
    }
}

/** Which session it is: of which round, which run, and which of the sessions planned for it. */
export interface SessionKey {
    round: string;
    run: string;
    repeat: number;
}

/**
 * The sessions a calibration has judged, in `<directory>/sessions/<round>/<run>/<n>/`: each one's streams and logs,
 * its session.json and its verdicts.json. A session is reused when its fingerprint matches, so changing the judge,
 * the prompt or the inputs judges it again.
 */
export class SessionStore {

    private readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
    }

    /** Where a session's streams, logs and files go */
    output({ round, run, repeat }: SessionKey): string {
        return join(this.directory, 'sessions', round, run, String(repeat));
    }

    /** The saved session, when there is one with this fingerprint */
    find(key: SessionKey, fingerprint: Fingerprint): JudgeSession | undefined {
        const file = join(this.output(key), 'session.json');
        if (! existsSync(file)) {
            return undefined;
        }
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { fingerprint?: string } & Parameters<typeof JudgeSession.fromJSON>[0];
        return fingerprint.equals(saved.fingerprint) ? JudgeSession.fromJSON(saved) : undefined;
    }

    /** Removes a session that's to be judged again, with its streams and logs */
    clear(key: SessionKey): void {
        rmSync(this.output(key), { recursive: true, force: true });
    }

    save(key: SessionKey, fingerprint: Fingerprint, identity: JudgeIdentity, session: JudgeSession): void {
        writeJson(join(this.output(key), 'session.json'), { fingerprint, judge: identity, ...session.toJSON() });
        if (session.verdicts) {
            writeJson(join(this.output(key), 'verdicts.json'), { verdicts: session.verdicts });
        }
    }
}
