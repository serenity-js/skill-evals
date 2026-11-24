// Compares the text of a layout's skills with #3616's, block by block, wherever each layout keeps the blocks.
// Layouts B and C move #3616's sections between files without rewriting them, so the only blocks that differ
// should be the frontmatter, the overviews and the cross-references.
//
// Usage: node skill-layouts/src/content.ts [<layout>...]
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { evalRoot } from './layouts.ts';

export interface SkillFile {
    /** Relative to the package's skills, e.g. `serenity-js-screenplay/references/tasks.md` */
    file: string;
    content: string;
}

export interface Block {
    file: string;
    text: string;
}

/** The paragraphs, lists, headings and code blocks of a Markdown file, each as it's written. */
export function blocksOf(markdown: string): string[] {
    const blocks: string[] = [];
    let current: string[] = [];
    let inCode = false;
    const flush = () => {
        if (current.length > 0) {
            blocks.push(current.join('\n'));
        }
        current = [];
    };
    const lines = markdown.split('\n');
    for (const [ index, line ] of lines.entries()) {
        if (line.startsWith('```')) {
            inCode = ! inCode;
        }
        // the frontmatter is one block, which ends at its closing ---
        const inFrontmatter = current[0] === '---' && ! current.slice(1).includes('---');
        if (! inCode && ! inFrontmatter && line.trim() === '') {
            flush();
        }
        else {
            current.push(line.trimEnd());
        }
        if (index === lines.length - 1) {
            flush();
        }
    }
    return blocks;
}

export function filesOf(directory: string): SkillFile[] {
    return readdirSync(directory, { recursive: true, encoding: 'utf8' })
        .filter(file => file.endsWith('.md'))
        .sort()
        .map(file => ({ file: file.split(sep).join('/'), content: readFileSync(join(directory, file), 'utf8') }));
}

function blocksIn(files: SkillFile[]): Block[] {
    return files.flatMap(({ file, content }) => blocksOf(content).map(text => ({ file, text })));
}

/** Removes one block with the same text from `pool` for each of `blocks`, and returns those that had none. */
function unmatched(blocks: Block[], pool: Block[]): Block[] {
    const remaining = new Map<string, number>();
    for (const { text } of pool) {
        remaining.set(text, (remaining.get(text) ?? 0) + 1);
    }
    return blocks.filter(({ text }) => {
        const count = remaining.get(text) ?? 0;
        remaining.set(text, count - 1);
        return count <= 0;
    });
}

export function compareLayout(base: SkillFile[], layout: SkillFile[]): { onlyInBase: Block[], onlyInLayout: Block[] } {
    const baseBlocks = blocksIn(base);
    const layoutBlocks = blocksIn(layout);
    return { onlyInBase: unmatched(baseBlocks, layoutBlocks), onlyInLayout: unmatched(layoutBlocks, baseBlocks) };
}

function quoted(blocks: Block[]): string[] {
    return blocks.flatMap(({ file, text }) => [ `\`${ file }\`:`, '', '````text', text, '````', '' ]);
}

export function report(layoutId: string, root: string = evalRoot): string {
    const { onlyInBase, onlyInLayout } = compareLayout(filesOf(join(root, 'layouts', 'a', 'core')), filesOf(join(root, 'layouts', layoutId, 'core')));
    return [
        `## Layout ${ layoutId.toUpperCase() } against #3616`,
        '',
        `Every other block of #3616's skills appears in layout ${ layoutId.toUpperCase() } unchanged.`,
        '',
        `### Only in #3616 (${ onlyInBase.length } blocks)`,
        '',
        ...quoted(onlyInBase),
        `### Only in layout ${ layoutId.toUpperCase() } (${ onlyInLayout.length } blocks)`,
        '',
        ...quoted(onlyInLayout),
    ].join('\n');
}

if (import.meta.main) {
    const layouts = process.argv.slice(2);
    console.log((layouts.length > 0 ? layouts : [ 'b', 'c' ]).map(layout => report(layout)).join('\n'));
}
