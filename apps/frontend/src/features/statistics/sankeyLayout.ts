/**
 * Sankey layout (ADR-245; replaces `d3-sankey`).
 *
 * A typed port of d3-sankey 0.12.3's `sankey()` and `sankeyLinkHorizontal()`
 * with the options Vision uses: string node ids, `justify` alignment, default
 * node and link order, six relaxation iterations. The arithmetic and the
 * order of operations are kept as in the original so positions match it
 * exactly; a differential test compared the two before the package was
 * removed.
 *
 * d3-sankey: Copyright 2015, Mike Bostock. All rights reserved.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * redistributions of source code must retain the above copyright notice, this
 * list of conditions and the following disclaimer; redistributions in binary
 * form must reproduce the above copyright notice, this list of conditions and
 * the following disclaimer in the documentation and/or other materials
 * provided with the distribution; neither the name of the author nor the names
 * of contributors may be used to endorse or promote products derived from this
 * software without specific prior written permission.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
import { max, min, sum } from "d3-array";

export interface SankeyInputNode {
    id: string;
}

export interface SankeyInputLink {
    source: string;
    target: string;
    value: number;
}

export type LayoutNode<N extends SankeyInputNode> = N & {
    index: number;
    value: number;
    depth: number;
    height: number;
    layer: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    sourceLinks: LayoutLink<N>[];
    targetLinks: LayoutLink<N>[];
};

export interface LayoutLink<N extends SankeyInputNode> {
    index: number;
    source: LayoutNode<N>;
    target: LayoutNode<N>;
    value: number;
    width: number;
    y0: number;
    y1: number;
}

export interface SankeyLayout<N extends SankeyInputNode> {
    nodes: LayoutNode<N>[];
    links: LayoutLink<N>[];
}

export interface SankeyOptions {
    nodeWidth: number;
    nodePadding: number;
    extent: [[number, number], [number, number]];
}

const ITERATIONS = 6;

function ascendingBreadth(a: { y0: number }, b: { y0: number }): number {
    return a.y0 - b.y0;
}

/** `order || a.index - b.index`, as d3-sankey writes it (0 and NaN tie). */
function byIndexWhenTied(
    order: number,
    a: { index: number },
    b: { index: number },
): number {
    return order === 0 || Number.isNaN(order) ? a.index - b.index : order;
}

function ascendingSourceBreadth<N extends SankeyInputNode>(
    a: LayoutLink<N>,
    b: LayoutLink<N>,
) {
    return byIndexWhenTied(ascendingBreadth(a.source, b.source), a, b);
}

function ascendingTargetBreadth<N extends SankeyInputNode>(
    a: LayoutLink<N>,
    b: LayoutLink<N>,
) {
    return byIndexWhenTied(ascendingBreadth(a.target, b.target), a, b);
}

/**
 * Lay out nodes and links. Inputs are copied, never mutated. Throws on a
 * link to an unknown id ("missing: id") or a cycle ("circular link"), like
 * d3-sankey.
 */
export function sankeyLayout<N extends SankeyInputNode>(
    input: { nodes: readonly N[]; links: readonly SankeyInputLink[] },
    options: SankeyOptions,
): SankeyLayout<N> {
    const [[x0, y0], [x1, y1]] = options.extent;
    const dx = options.nodeWidth;
    const dy = options.nodePadding;
    let py = dy;

    // computeNodeLinks
    const nodes = input.nodes.map((node, index): LayoutNode<N> => ({
        ...node,
        index,
        value: 0,
        depth: 0,
        height: 0,
        layer: 0,
        x0: 0,
        x1: 0,
        y0: 0,
        y1: 0,
        sourceLinks: [],
        targetLinks: [],
    }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const find = (id: string) => {
        const node = nodeById.get(id);
        if (!node) throw new Error(`missing: ${id}`);
        return node;
    };
    const links = input.links.map((link, index): LayoutLink<N> => {
        const source = find(link.source);
        const target = find(link.target);
        const laid = {
            index,
            source,
            target,
            value: link.value,
            width: 0,
            y0: 0,
            y1: 0,
        };
        source.sourceLinks.push(laid);
        target.targetLinks.push(laid);
        return laid;
    });

    // computeNodeValues
    for (const node of nodes) {
        node.value = Math.max(
            sum(node.sourceLinks, (link) => link.value),
            sum(node.targetLinks, (link) => link.value),
        );
    }

    // computeNodeDepths / computeNodeHeights
    const walk = (
        assign: (node: LayoutNode<N>, x: number) => void,
        next: (node: LayoutNode<N>) => LayoutNode<N>[],
    ) => {
        let current = new Set(nodes);
        let x = 0;
        while (current.size > 0) {
            const following = new Set<LayoutNode<N>>();
            for (const node of current) {
                assign(node, x);
                for (const other of next(node)) following.add(other);
            }
            if (++x > nodes.length) throw new Error("circular link");
            current = following;
        }
    };
    walk(
        (node, x) => (node.depth = x),
        (node) => node.sourceLinks.map((link) => link.target),
    );
    walk(
        (node, x) => (node.height = x),
        (node) => node.targetLinks.map((link) => link.source),
    );

    // computeNodeLayers (justify alignment)
    // d3-array returns undefined for empty or all-NaN input; d3-sankey then
    // computes with it, which NaN reproduces.
    const layerCount = (max(nodes, (node) => node.depth) ?? Number.NaN) + 1;
    const kx = (x1 - x0 - dx) / (layerCount - 1);
    const columns: LayoutNode<N>[][] = new Array<LayoutNode<N>[]>(layerCount);
    for (const node of nodes) {
        const aligned =
            node.sourceLinks.length > 0 ? node.depth : layerCount - 1;
        const i = Math.max(0, Math.min(layerCount - 1, Math.floor(aligned)));
        node.layer = i;
        node.x0 = x0 + i * kx;
        node.x1 = node.x0 + dx;
        if (columns[i]) columns[i].push(node);
        else columns[i] = [node];
    }

    const reorderLinks = (column: LayoutNode<N>[]) => {
        for (const { sourceLinks, targetLinks } of column) {
            sourceLinks.sort(ascendingTargetBreadth);
            targetLinks.sort(ascendingSourceBreadth);
        }
    };
    const reorderNodeLinks = ({ sourceLinks, targetLinks }: LayoutNode<N>) => {
        for (const {
            source: { sourceLinks: links },
        } of targetLinks) {
            links.sort(ascendingTargetBreadth);
        }
        for (const {
            target: { targetLinks: links },
        } of sourceLinks) {
            links.sort(ascendingSourceBreadth);
        }
    };

    // computeNodeBreadths
    py = Math.min(
        dy,
        (y1 - y0) /
            ((max(columns, (column) => column.length) ?? Number.NaN) - 1),
    );
    const ky =
        min(
            columns,
            (column) =>
                (y1 - y0 - (column.length - 1) * py) /
                sum(column, (node) => node.value),
        ) ?? Number.NaN;
    for (const column of columns) {
        let y = y0;
        for (const node of column) {
            node.y0 = y;
            node.y1 = y + node.value * ky;
            y = node.y1 + py;
            for (const link of node.sourceLinks) link.width = link.value * ky;
        }
        y = (y1 - y + py) / (column.length + 1);
        for (const [i, node] of column.entries()) {
            node.y0 += y * (i + 1);
            node.y1 += y * (i + 1);
        }
        reorderLinks(column);
    }

    const targetTop = (source: LayoutNode<N>, target: LayoutNode<N>) => {
        let y = source.y0 - ((source.sourceLinks.length - 1) * py) / 2;
        for (const { target: node, width } of source.sourceLinks) {
            if (node === target) break;
            y += width + py;
        }
        for (const { source: node, width } of target.targetLinks) {
            if (node === source) break;
            y -= width;
        }
        return y;
    };
    const sourceTop = (source: LayoutNode<N>, target: LayoutNode<N>) => {
        let y = target.y0 - ((target.targetLinks.length - 1) * py) / 2;
        for (const { source: node, width } of target.targetLinks) {
            if (node === source) break;
            y += width + py;
        }
        for (const { target: node, width } of source.sourceLinks) {
            if (node === target) break;
            y -= width;
        }
        return y;
    };

    const collideDown = (
        column: LayoutNode<N>[],
        start: number,
        from: number,
        alpha: number,
    ) => {
        let y = start;
        for (const node of column.slice(Math.max(from, 0))) {
            const shift = (y - node.y0) * alpha;
            if (shift > 1e-6) {
                node.y0 += shift;
                node.y1 += shift;
            }
            y = node.y1 + py;
        }
    };
    const collideUp = (
        column: LayoutNode<N>[],
        start: number,
        from: number,
        alpha: number,
    ) => {
        let y = start;
        for (const node of column.slice(0, from + 1).reverse()) {
            const shift = (node.y1 - y) * alpha;
            if (shift > 1e-6) {
                node.y0 -= shift;
                node.y1 -= shift;
            }
            y = node.y0 - py;
        }
    };
    const resolveCollisions = (column: LayoutNode<N>[], alpha: number) => {
        const i = column.length >> 1;
        const subject = column[i];
        if (subject === undefined) return;
        collideUp(column, subject.y0 - py, i - 1, alpha);
        collideDown(column, subject.y1 + py, i + 1, alpha);
        collideUp(column, y1, column.length - 1, alpha);
        collideDown(column, y0, 0, alpha);
    };

    for (let iteration = 0; iteration < ITERATIONS; ++iteration) {
        const alpha = Math.pow(0.99, iteration);
        const beta = Math.max(1 - alpha, (iteration + 1) / ITERATIONS);
        // relaxRightToLeft
        for (let i = columns.length - 2; i >= 0; --i) {
            const column = columns[i];
            if (column === undefined) continue;
            for (const source of column) {
                let y = 0;
                let w = 0;
                for (const { target, value } of source.sourceLinks) {
                    const v = value * (target.layer - source.layer);
                    y += sourceTop(source, target) * v;
                    w += v;
                }
                if (!(w > 0)) continue;
                const shift = (y / w - source.y0) * alpha;
                source.y0 += shift;
                source.y1 += shift;
                reorderNodeLinks(source);
            }
            column.sort(ascendingBreadth);
            resolveCollisions(column, beta);
        }
        // relaxLeftToRight
        for (let i = 1; i < columns.length; ++i) {
            const column = columns[i];
            if (column === undefined) continue;
            for (const target of column) {
                let y = 0;
                let w = 0;
                for (const { source, value } of target.targetLinks) {
                    const v = value * (target.layer - source.layer);
                    y += targetTop(source, target) * v;
                    w += v;
                }
                if (!(w > 0)) continue;
                const shift = (y / w - target.y0) * alpha;
                target.y0 += shift;
                target.y1 += shift;
                reorderNodeLinks(target);
            }
            column.sort(ascendingBreadth);
            resolveCollisions(column, beta);
        }
    }

    // computeLinkBreadths
    for (const node of nodes) {
        let top = node.y0;
        let bottom = top;
        for (const link of node.sourceLinks) {
            link.y0 = top + link.width / 2;
            top += link.width;
        }
        for (const link of node.targetLinks) {
            link.y1 = bottom + link.width / 2;
            bottom += link.width;
        }
    }

    return { nodes, links };
}

/** SVG path of a link, as d3-shape 1's horizontal link generator draws it. */
export function sankeyLinkPath<N extends SankeyInputNode>(
    link: LayoutLink<N>,
): string {
    const sx = link.source.x1;
    const tx = link.target.x0;
    const mx = (sx + tx) / 2;
    return `M${sx},${link.y0}C${mx},${link.y0},${mx},${link.y1},${tx},${link.y1}`;
}
