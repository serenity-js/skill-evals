import type { JudgeRule } from './brief.ts';

/** A section of review-guide.md: its heading, the items its **Items** line names, its text, and the runs it cites. */
export class GuideSection {

    static of(heading: string, items: readonly string[], text: string, cited: readonly string[]): GuideSection {
        return new GuideSection(heading, items, text, cited);
    }

    readonly heading: string;
    readonly items: readonly string[];
    readonly text: string;
    /** The IDs of the runs it cites, as `*<id>*` */
    readonly cited: readonly string[];

    private constructor(heading: string, items: readonly string[], text: string, cited: readonly string[]) {
        this.heading = heading;
        this.items = items;
        this.text = text;
        this.cited = cited;
    }

    names(item: string): boolean {
        return this.items.includes(item);
    }

    cites(run: string): boolean {
        return this.cited.includes(run);
    }
}

/** An item of the checklist, as the guide needs it: its id, and what it asks for. */
export interface ChecklistItemText {
    id: string;
    text: string;
}

/**
 * review-guide.md, parsed once: its sections, the rules the judge reads, made from the checklist's items and the
 * sections that name them, and which runs it cites under which item.
 */
export class ReviewGuide {

    private static readonly runId = /\*([\da-f]{8})\*/g;

    /** The guide, whose sections may only name the checklist's items. */
    static parse(markdown: string, checklist: readonly ChecklistItemText[]): ReviewGuide {
        const known = new Set(checklist.map(item => item.id));
        const sections = markdown.split(/\n(?=#{2,3} )/).filter(part => /^#{2,3} /.test(part)).map(part => {
            const [ title, ...lines ] = part.split('\n');
            const heading = title.replace(/^#+\s*/, '');
            const itemsLine = /\*\*Items:\*\*([^\n]*)/.exec(part)?.[1] ?? '';
            const named = [ ...itemsLine.matchAll(/`([^`]+)`/g) ].map(match => match[1]);
            const unknown = named.filter(item => ! known.has(item));
            if (unknown.length > 0) {
                throw new Error(`review-guide.md's section "${ heading }" names ${ unknown.join(', ') }, which aren't items of the checklist`);
            }
            return GuideSection.of(
                heading,
                named,
                lines.join('\n').replace(/\*\*Items:\*\*[^\n]*\n?/, '').trim(),
                [ ...new Set([ ...part.matchAll(ReviewGuide.runId) ].map(match => match[1])) ],
            );
        });
        return new ReviewGuide(sections, checklist);
    }

    /**
     * The checklist as the judge's rules: each item's text, then the guide's sections that name it, with each run the
     * guide cites renamed `run R<n>`, numbered in the order the guide first cites them, so the judge can't tell which run
     * it is from its ID. Links to other sections of the guide keep their text only.
     */
    readonly rules: readonly JudgeRule[];

    readonly sections: readonly GuideSection[];

    private constructor(sections: readonly GuideSection[], checklist: readonly ChecklistItemText[]) {
        this.sections = sections;
        const numbers = new Map([ ...new Set(sections.flatMap(section => section.cited)) ].map((id, index) => [ id, index + 1 ]));
        const anonymous = (text: string) => text
            .replace(ReviewGuide.runId, (_, id: string) => `*run R${ numbers.get(id) }*`)
            .replace(/\[([^\]]+)\]\(#[^)]*\)/g, '$1');
        this.rules = checklist.map(item => ({
            id: item.id,
            readme: [
                `# ${ item.id }`,
                '',
                item.text,
                ...sections.filter(section => section.names(item.id)).flatMap(section => [ '', `## ${ section.heading }`, '', anonymous(section.text) ]),
            ].join('\n'),
        }));
    }

    /** Whether the guide cites `run` in a section that names `item`, so the judge's rules describe its verdict */
    cites(run: string, item: string): boolean {
        return this.sections.some(section => section.cites(run) && section.names(item));
    }
}
