/** How many of some things there are, of how many: such as 17 of the 20 held-out verdicts the judge agreed with. */
export class Share {

    static of(count: number, of: number): Share {
        return new Share(count, of);
    }

    /** How many of `items` are counted */
    static counting<T>(items: readonly T[], isCounted: (item: T) => boolean): Share {
        return new Share(items.filter(isCounted).length, items.length);
    }

    readonly count: number;
    readonly of: number;

    private constructor(count: number, of: number) {
        this.count = count;
        this.of = of;
    }

    /** Whether the share is at least `fraction` of the whole, such as 0.85 */
    isAtLeast(fraction: number): boolean {
        return this.count >= fraction * this.of;
    }

    /** As a whole percentage, such as `85%`, or `n/a` of nothing */
    percent(): string {
        return this.of === 0 ? 'n/a' : `${ Math.round(100 * this.count / this.of) }%`;
    }

    /** As the reports show it: `17 of 20 (85%)` */
    toString(): string {
        return `${ this.count } of ${ this.of } (${ this.percent() })`;
    }

    toJSON(): { count: number, of: number } {
        return { count: this.count, of: this.of };
    }
}
