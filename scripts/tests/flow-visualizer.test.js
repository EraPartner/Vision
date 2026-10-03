const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "../..");
const frontendRequire = createRequire(
  resolve(root, "apps/frontend/package.json"),
);
const { JSDOM } = frontendRequire("jsdom");
const html = readFileSync(resolve(root, "docs/flow-visualizer.html"), "utf8");
const data = JSON.parse(html.match(/id="flow-data">([\s\S]*?)<\/script>/)[1]);
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function open(hash = "", reducedMotion = false) {
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
  for (let i = 0; i < data.components.length; i++) {
    for (const b of data.components.slice(i + 1)) {
      const a = data.components[i];
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
    for (const key of ["id", "name", "category", "summary"])
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
    assert.match(guide.split("---")[1], new RegExp(`^${key}:`, "m"));
  }
  for (const [, id] of guide.matchAll(
    /\]\([^)]*flow-visualizer\.html#([\w-]+)\)/g,
  )) {
    assert.ok(
      data.flows.some((flow) => flow.id === id),
      id,
    );
  }
  const links = [...guide.matchAll(/\[\[([^\]]+)\]\]/g)].map(
    (match) => match[1].split("|")[0],
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
      doc.querySelector(".journey-intro h1").textContent,
      data.flows.find((f) => f.id === "api-request").name,
    );
    assert.ok(doc.getElementById("diagram").hasAttribute("hidden"));
    assert.equal(doc.getElementById("track").value, "start");
    doc.getElementById("track").value = "all";
    doc.getElementById("track").dispatchEvent(new dom.window.Event("change"));
    for (const flow of data.flows) {
      doc.querySelector(`[data-flow="${flow.id}"]`).click();
      const cards = [...doc.querySelectorAll(".journey-step")];
      assert.equal(cards.length, flow.steps.length, flow.id);
      assert.equal(
        doc.querySelectorAll("#flow-edges .arrow").length,
        flow.steps.length,
        flow.id,
      );
      for (let i = 0; i < cards.length; i++) {
        cards[i].click();
        assert.equal(
          doc.querySelector('[aria-current="step"]').dataset.step,
          String(i),
        );
        assert.equal(
          doc.getElementById("progress").textContent,
          `${i + 1} / ${cards.length}`,
        );
        for (const edge of doc.querySelectorAll("#flow-edges .arrow"))
          assert.ok(!edge.getAttribute("d").includes("NaN"));
      }
      doc.getElementById("view-architecture").click();
      assert.equal(doc.getElementById("diagram").hasAttribute("hidden"), false);
      assert.equal(doc.getElementById("journey").hidden, true);
      doc.getElementById("view-journey").click();
    }
  } finally {
    dom.window.close();
  }
});

test("learning paths keep their order and combine with search", () => {
  const dom = open();
  const doc = dom.window.document;
  try {
    const select = doc.getElementById("track");
    for (const path of data.learningPaths) {
      select.value = path.id;
      select.dispatchEvent(new dom.window.Event("change"));
      assert.deepEqual(
        [...doc.querySelectorAll(".flow-btn")].map((b) => b.dataset.flow),
        path.flows,
      );
    }
    const search = doc.getElementById("search");
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
      doc
        .querySelector('[data-flow="backup-restore"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    doc.getElementById("btn-next").click();
    assert.equal(
      doc.getElementById("progress").textContent,
      `2 / ${data.flows.find((f) => f.id === "backup-restore").steps.length}`,
    );
    const step = doc.querySelectorAll("#step-list .step")[3];
    step.querySelector("button.step-select").click();
    assert.equal(step.querySelector("button.step-select details"), null);
    assert.equal(doc.querySelector('[aria-current="step"]').dataset.step, "3");
    const summary = step.querySelector("summary");
    summary.click();
    assert.ok(step.querySelector("details").open);
    assert.equal(doc.querySelector('[aria-current="step"]').dataset.step, "3");
    const input = doc.getElementById("search");
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      }),
    );
    assert.equal(doc.querySelector('[aria-current="step"]').dataset.step, "3");
    doc.getElementById("btn-all").click();
    assert.equal(
      doc.getElementById("btn-all").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      doc.querySelectorAll(".journey-step.active").length,
      doc.querySelectorAll(".journey-step").length,
    );
    doc.getElementById("view-architecture").click();
    doc.getElementById("btn-restart").click();
    assert.equal(doc.querySelectorAll(".token").length, 0);
    dom.window.location.hash = "split-shared-expense";
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(
      doc
        .querySelector('[data-flow="split-shared-expense"]')
        .getAttribute("aria-pressed"),
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
