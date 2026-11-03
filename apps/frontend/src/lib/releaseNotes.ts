/**
 * Plain-text summary of a GitHub release body for the About update row.
 *
 * Release bodies are Markdown, and the release workflow generates them from
 * merged pull requests ("* title by @author in https://…/pull/1"). The update
 * row shows two clamped lines of plain text, so headings, list markers,
 * emphasis, links and URLs are reduced to their readable text, and the
 * remaining lines are joined with " · ".
 */
export function releaseNotesSummary(markdown: string): string {
    return markdown
        .replace(/<!--[\s\S]*?-->/g, "")
        .split(/\r?\n/)
        .filter((line) => !/^\s*#{1,6}\s/.test(line))
        .map((line) =>
            line
                .replace(/<[^>]+>/g, "")
                .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
                .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
                .replace(/\s+in\s+https?:\/\/\S+/g, "")
                .replace(/https?:\/\/\S+/g, "")
                .replace(/^\s*(?:>\s*)+/, "")
                .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
                .replace(/(\*\*|__)(.+?)\1/g, "$2")
                .replace(
                    /(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g,
                    "$1$2",
                )
                .replace(/`([^`]*)`/g, "$1")
                .replace(/\s+/g, " ")
                .trim(),
        )
        .filter((line) => line !== "" && !/:$/.test(line))
        .join(" · ");
}
