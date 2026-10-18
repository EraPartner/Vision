import { SaxesParser } from "saxes";
import type {
  WorkbookXmlDocument,
  WorkbookXmlElement,
} from "@vision/shared-utils/analysis/workbook";

/** Minimal XML reader for the same tag/attribute/text access used by the browser DOM
 * adapter. ZIP, CRC, cell/date conversion and provenance validation stay shared. */
class Element implements WorkbookXmlElement {
  children: Element[] = [];
  parts: Array<string | Element> = [];
  readonly name: string;
  readonly attributes: Record<string, string>;
  constructor(name: string, attributes: Record<string, string>) {
    this.name = name;
    this.attributes = attributes;
  }
  get textContent(): string {
    return this.parts
      .map((part) => (typeof part === "string" ? part : part.textContent))
      .join("");
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  getElementsByTagName(name: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.name === name ? [child] : []),
      ...child.getElementsByTagName(name),
    ]);
  }
}
export function parseAnalysisWorkbookXml(source: string): WorkbookXmlDocument {
  const root = new Element("#document", {}),
    stack = [root];
  const parser = new SaxesParser();
  let failed = false;
  parser.on("opentag", (tag) => {
    const element = new Element(
      tag.name,
      tag.attributes as Record<string, string>,
    );
    const parent = stack.at(-1)!;
    parent.children.push(element);
    parent.parts.push(element);
    stack.push(element);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (text) => {
    stack.at(-1)!.parts.push(text);
  });
  parser.on("cdata", (text) => {
    stack.at(-1)!.parts.push(text);
  });
  parser.on("error", () => {
    failed = true;
  });
  parser.write(source).close();
  return {
    querySelector: (selector) =>
      failed && selector === "parsererror" ? true : null,
    getElementsByTagName: (name) =>
      failed ? [] : root.getElementsByTagName(name),
  };
}
