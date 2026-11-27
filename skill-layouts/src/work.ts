// The work directory, --work: the tarballs, the layouts' projects, and each run's working copy and homes, outside any
// repository, so the agents find no other project's configuration. The only code that knows its layout.
import { join } from 'node:path';

import type { Layout } from './layouts.ts';

export class Work {

    readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
    }

    /** A run's working copy, which the agent works in */
    run(id: string): string {
        return join(this.directory, 'runs', id);
    }

    /** A run's homes: its HOME, and each agent's home */
    homes(id: string): string {
        return join(this.directory, 'homes', id);
    }

    /** npm's cache, which every agent's run shares */
    get npmCache(): string {
        return join(this.directory, 'npm-cache');
    }

    /** A layout's project, the copy of it its examples are type-checked in, and the template's archive it's made from */
    layout(layout: Layout): { project: string, examples: string, templateArchive: string } {
        const directory = join(this.directory, 'layouts', layout);
        return { project: join(directory, 'project'), examples: join(directory, 'examples'), templateArchive: join(directory, 'template.tar') };
    }

    /** The tarballs packed from the clone, `packed`, or a layout's, under a name that doesn't give the layout away */
    tarballs(name: string): string {
        return join(this.directory, 'tarballs', name);
    }

    /** Where --check-references checks a request's reference solution */
    reference(request: string): string {
        return join(this.directory, 'references', request);
    }

    /** Where --rescore-checks rebuilds a run's working copy that's gone */
    rescoredChecks(id: string): string {
        return join(this.directory, 'rescore-checks', id);
    }
}
