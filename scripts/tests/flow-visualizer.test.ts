import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

// The scripts check has no DOM lib and jsdom ships no type declarations here,
// so these structural types cover exactly the DOM surface this test drives.
interface DomEvent {
  readonly type: string;
}

interface DomElement {
  textContent: string | null;
  value: string;
  hidden: boolean;
  open: boolean;
  readonly dataset: Record<string, string | undefined>;
  click(): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  dispatchEvent(event: DomEvent): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): Iterable<DomElement> & {
    readonly length: number;
    item(index: number): DomElement | null;
  };
}

interface DomDocument {
  getElementById(id: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): Iterable<DomElement> & {
    readonly length: number;
    item(index: number): DomElement | null;
  };
}

interface DomWindow {
  readonly document: DomDocument;
  readonly location: { hash: string };
  readonly Event: new (type: string) => DomEvent;
  readonly KeyboardEvent: new (
    type: string,
    init: { key: string; bubbles?: boolean },
  ) => DomEvent;
  readonly HTMLElement: { prototype: { scrollIntoView: () => void } };
  matchMedia: (query: string) => { matches: boolean };
  requestAnimationFrame: (callback: () => void) => number;
  eval(source: string): void;
  close(): void;
  setTimeout(callback: () => void, delay: number): unknown;
  dispatchEvent(event: DomEvent): boolean;
}

interface Dom {
  readonly window: DomWindow;
}

type JsdomConstructor = new (
  html: string,
  options: { url: string; runScripts: "outside-only" },
) => Dom;

interface Component {
  id: string;
  x: number;
  y: number;
  path?: string;
}

interface FlowStep {
  from: string;
  to: string;
  payload: string;
  annotation: string;
}

interface Flow {
  id: string;
  name: string;
  category: string;
  summary: string;
  steps: FlowStep[];
  docs: { path: string }[];
}

interface FlowData {
  components: Component[];
  flows: Flow[];
  baseEdges: string[][];
  learningPaths: { id: string; flows: string[] }[];
}

const root = resolve(import.meta.dirname, "../..");
const frontendRequire = createRequire(
  resolve(root, "apps/frontend/package.json"),
);
const jsdom: unknown = frontendRequire("jsdom");
assert.ok(
  typeof jsdom === "object" &&
    jsdom !== null &&
    "JSDOM" in jsdom &&
    typeof jsdom.JSDOM === "function",
  "jsdom must export a JSDOM constructor",
);
// jsdom has no bundled declarations; the structural Dom types above describe it.
const JSDOM = jsdom.JSDOM as JsdomConstructor;

function capture(source: string, pattern: RegExp, label: string): string {
  const value = source.match(pattern)?.[1];
  assert.ok(value !== undefined, `${label} must be present`);
  return value;
}

const html = readFileSync(resolve(root, "docs/flow-visualizer.html"), "utf8");
// Trusted repository fixture: its shape is asserted by the first test.
const data = JSON.parse(
  capture(html, /id="flow-data">([\s\S]*?)<\/script>/, "flow data"),
) as FlowData;
const script = capture(html, /<script>([\s\S]*?)<\/script>/, "script");

function element(found: DomElement | null, selector: string): DomElement {
  assert.ok(found, `${selector} must exist`);
  return found;
}

function byId(doc: DomDocument, id: string): DomElement {
  return element(doc.getElementById(id), `#${id}`);
}

function query(scope: DomDocument | DomElement, selector: string): DomElement {
  return element(scope.querySelector(selector), selector);
}

function flowById(id: string): Flow {
  const flow = data.flows.find((f) => f.id === id);
  assert.ok(flow, `${id} flow must exist`);
  return flow;
}

function open(hash = "", reducedMotion = false): Dom {
  // This is a DOM unit test. It loads no browser, resources or network service.
  const dom = new JSDOM(html, {
    url: `https://docs.example.test/flow-visualizer.html${hash}`,
    runScripts: "outside-only",
  });
  dom.window.matchMedia = () => ({ matches: reducedMotion });
  dom.window.requestAnimationFrame = () => 0;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.eval(script);
  return dom;
}

test("flow data references valid nodes, source paths, docs and learning paths", () => {
  const ids = new Set(data.components.map((c) => c.id));
  assert.equal(ids.size, data.components.length);
  const flows = new Set(data.flows.map((f) => f.id));
  assert.equal(flows.size, data.flows.length);
  for (const edge of data.baseEdges)
    for (const id of edge) assert.ok(ids.has(id), id);
  for (const c of data.components) {
    assert.ok(
      c.x >= 0 && c.y >= 0 && c.x + 168 <= 1520 && c.y + 56 <= 1420,
      c.id,
    );
    if (c.path) assert.ok(existsSync(resolve(root, c.path)), c.path);
  }
  for (const [i, a] of data.components.entries()) {
    for (const b of data.components.slice(i + 1)) {
      assert.ok(
        a.x + 168 <= b.x ||
          b.x + 168 <= a.x ||
          a.y + 56 <= b.y ||
          b.y + 56 <= a.y,
        `overlap: ${a.id} / ${b.id}`,
      );
    }
  }
  for (const flow of data.flows) {
    for (const key of ["id", "name", "category", "summary"] as const)
      assert.ok(flow[key]?.trim(), flow.id);
    assert.ok(flow.steps.length, flow.id);
    assert.ok(flow.docs.length, flow.id);
    for (const doc of flow.docs) {
      assert.ok(!doc.path.includes("..") && !doc.path.includes(":"), doc.path);
      assert.ok(existsSync(resolve(root, "docs", doc.path)), doc.path);
    }
    for (const step of flow.steps) {
      assert.ok(
        ids.has(step.from) && ids.has(step.to),
        `${flow.id}: ${step.from} / ${step.to}`,
      );
      assert.ok(step.payload?.trim() && step.annotation?.trim(), flow.id);
      for (const path of step.annotation.match(
        /(?:apps|packaging|packages)\/[\w./-]+/g,
      ) || []) {
        assert.ok(
          existsSync(resolve(root, path.replace(/\.$/, ""))),
          `${flow.id}: ${path}`,
        );
      }
    }
  }
  for (const path of data.learningPaths) {
    assert.equal(new Set(path.flows).size, path.flows.length);
    for (const id of path.flows) assert.ok(flows.has(id), id);
  }
});

test("visual documentation links and index counts match the catalogue", () => {
  for (const path of [
    "docs/index.md",
    "docs/architecture/index.md",
    "docs/diagrams/index.md",
    "docs/features/views.md",
  ]) {
    const note = readFileSync(resolve(root, path), "utf8");
    assert.match(
      note,
      new RegExp(
        `${data.components.length} components(?: /| and) ${data.flows.length} flows`,
      ),
      path,
    );
  }
  const guide = readFileSync(
    resolve(root, "docs/guides/visual-learning.md"),
    "utf8",
  );
  for (const key of ["title", "type", "date", "tags", "description"]) {
    assert.match(guide.split("---")[1] ?? "", new RegExp(`^${key}:`, "m"));
  }
  for (const [, id] of guide.matchAll(
    /\]\([^)]*flow-visualizer\.html#([\w-]+)\)/g,
  )) {
    assert.ok(
      data.flows.some((flow) => flow.id === id),
      String(id),
    );
  }
  const links = [...guide.matchAll(/\[\[([^\]]+)\]\]/g)].map(
    (match) => match[1]?.split("|")[0] ?? "",
  );
  assert.ok(links.includes("docs/guides/index"));
  for (const link of links)
    assert.ok(existsSync(resolve(root, `${link}.md`)), link);
  assert.ok(
    readFileSync(resolve(root, "docs/guides/index.md"), "utf8").includes(
      "[[docs/guides/visual-learning|",
    ),
  );
});

test("every flow renders in both views and each step can be selected", () => {
  const dom = open();
  const doc = dom.window.document;
  try {
    assert.equal(
      query(doc, ".journey-intro h1").textContent,
      flowById("api-request").name,
    );
    assert.ok(byId(doc, "diagram").hasAttribute("hidden"));
    assert.equal(byId(doc, "track").value, "start");
    byId(doc, "track").value = "all";
    byId(doc, "track").dispatchEvent(new dom.window.Event("change"));
    for (const flow of data.flows) {
      query(doc, `[data-flow="${flow.id}"]`).click();
      const cards = [...doc.querySelectorAll(".journey-step")];
      assert.equal(cards.length, flow.steps.length, flow.id);
      assert.equal(
        doc.querySelectorAll("#flow-edges .arrow").length,
        flow.steps.length,
        flow.id,
      );
      for (const [i, card] of cards.entries()) {
        card.click();
        assert.equal(
          query(doc, '[aria-current="step"]').dataset.step,
          String(i),
        );
        assert.equal(
          byId(doc, "progress").textContent,
          `${i + 1} / ${cards.length}`,
        );
        for (const edge of doc.querySelectorAll("#flow-edges .arrow")) {
          const d = edge.getAttribute("d");
          assert.ok(d !== null && !d.includes("NaN"));
        }
      }
      byId(doc, "view-architecture").click();
      assert.equal(byId(doc, "diagram").hasAttribute("hidden"), false);
      assert.equal(byId(doc, "journey").hidden, true);
      byId(doc, "view-journey").click();
    }
  } finally {
    dom.window.close();
  }
});

test("learning paths keep their order and combine with search", () => {
  const dom = open();
  const doc = dom.window.document;
  try {
    const select = byId(doc, "track");
    for (const path of data.learningPaths) {
      select.value = path.id;
      select.dispatchEvent(new dom.window.Event("change"));
      assert.deepEqual(
        [...doc.querySelectorAll(".flow-btn")].map((b) => b.dataset.flow),
        path.flows,
      );
    }
    const search = byId(doc, "search");
    search.value = "no matching flow 12345";
    search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.querySelectorAll(".flow-btn").length, 0);
    assert.ok(doc.querySelector(".no-results"));
    search.value = "rollback";
    search.dispatchEvent(new dom.window.Event("input"));
    assert.ok(doc.querySelector('[data-flow="backup-restore"]'));
  } finally {
    dom.window.close();
  }
});

test("deep links, clear, controls and keyboard focus preserve selection", async () => {
  const dom = open("#backup-restore", true);
  const doc = dom.window.document;
  try {
    assert.equal(
      query(doc, '[data-flow="backup-restore"]').getAttribute("aria-pressed"),
      "true",
    );
    byId(doc, "btn-next").click();
    assert.equal(
      byId(doc, "progress").textContent,
      `2 / ${flowById("backup-restore").steps.length}`,
    );
    const step = element(
      doc.querySelectorAll("#step-list .step").item(3),
      "#step-list .step:nth(3)",
    );
    query(step, "button.step-select").click();
    assert.equal(step.querySelector("button.step-select details"), null);
    assert.equal(query(doc, '[aria-current="step"]').dataset.step, "3");
    const summary = query(step, "summary");
    summary.click();
    assert.ok(query(step, "details").open);
    assert.equal(query(doc, '[aria-current="step"]').dataset.step, "3");
    const input = byId(doc, "search");
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      }),
    );
    assert.equal(query(doc, '[aria-current="step"]').dataset.step, "3");
    byId(doc, "btn-all").click();
    assert.equal(byId(doc, "btn-all").getAttribute("aria-pressed"), "true");
    assert.equal(
      doc.querySelectorAll(".journey-step.active").length,
      doc.querySelectorAll(".journey-step").length,
    );
    byId(doc, "view-architecture").click();
    byId(doc, "btn-restart").click();
    assert.equal(doc.querySelectorAll(".token").length, 0);
    dom.window.location.hash = "split-shared-expense";
    await new Promise<void>((resolve) =>
      dom.window.setTimeout(() => resolve(), 0),
    );
    assert.equal(
      query(doc, '[data-flow="split-shared-expense"]').getAttribute(
        "aria-pressed",
      ),
      "true",
    );
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape" }),
    );
    assert.equal(dom.window.location.hash, "");
    assert.equal(doc.querySelectorAll(".journey-step").length, 0);
  } finally {
    dom.window.close();
  }
});
