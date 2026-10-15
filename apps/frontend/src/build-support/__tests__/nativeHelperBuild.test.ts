// @vitest-environment node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeHelper } from "../../../scripts/build-native-helper";
import {
    activity,
    household,
    partner,
} from "@/lib/belgianTax/__tests__/testHousehold";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const jsdom = pathToFileURL(require.resolve("jsdom")).href;
const identity = {
    abi: 1,
    documentId: "synthetic-document",
    generation: "synthetic-graph",
};
const sample = household([partner("A", [activity("employee", 50_000)])]);
let directory: string;
let entry: string;
let files: string[];
let modules: string[];
let html: string;

async function hashes(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function walk(relative = "") {
        for (const item of await readdir(path.join(root, relative), {
            withFileTypes: true,
        })) {
            const name = path.join(relative, item.name);
            if (item.isDirectory()) await walk(name);
            else
                result[name] = createHash("sha256")
                    .update(await readFile(path.join(root, name)))
                    .digest("hex");
        }
    }
    await walk();
    return result;
}

beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vision-helper-artifact-"));
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
    const built = await buildNativeHelper({ outDir: directory, scratch: true });
    if (Array.isArray(built) || !("output" in built))
        throw new Error("Expected single helper build output");
    files = built.output.map((item) => item.fileName);
    for (const item of built.output) {
        if (item.type !== "chunk") continue;
        for (const imported of [...item.imports, ...item.dynamicImports]) {
            expect(imported.startsWith("native-helper-assets/")).toBe(true);
            expect(files).toContain(imported);
        }
    }
    modules = built.output.flatMap((item) =>
        item.type === "chunk"
            ? Object.entries(item.modules)
                  .filter(([, value]) => value.renderedLength > 0)
                  .map(([name]) => name)
            : [],
    );
    html = await readFile(path.join(directory, "native-helper.html"), "utf8");
    const script = html.match(/src="([^"]+\.js)"/);
    if (!script?.[1]) throw new Error("Missing emitted helper entry");
    entry = pathToFileURL(
        path.join(directory, script[1].replace(/^\//, "")),
    ).href;
}, 30_000);

async function run(body: string, bridge = true) {
    // Node loads the untouched emitted ESM and its actual lazy chunks. JSDOM is
    // only the synthetic document/host transport, not a replacement source module.
    const program = `
        import assert from 'node:assert/strict';
        import { JSDOM } from ${JSON.stringify(jsdom)};
        const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {url:'http://127.0.0.1:45678/native-helper.html'});
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        globalThis.MutationObserver = dom.window.MutationObserver;
        let providerRequests = 0, storageCalls = 0, readyCalls = 0, failedCalls = 0;
        globalThis.fetch = async (url) => {
            if (!new URL(String(url),window.location.href).pathname.startsWith('/native-helper-assets/')) {
                providerRequests++; throw Error('Provider request forbidden');
            }
            return new Response('');
        };
        for (const method of ['getItem','setItem','removeItem','clear']) {
            dom.window.Storage.prototype[method] = () => { storageCalls++; throw Error('Storage hydration forbidden'); };
        }
        window.electronAPI = {ready:()=>{throw Error('Generic readiness forbidden');}};
        const id = ${JSON.stringify(identity)};
        const sample = ${JSON.stringify(sample)};
        let releaseAck;
        let ack = Promise.resolve();
        let resolveReady, resolveFailed;
        const readyObserved = new Promise(resolve => resolveReady = resolve);
        const failedObserved = new Promise(resolve => resolveFailed = resolve);
        const ready = async p => { readyCalls++; assert.deepEqual(p, {documentId:id.documentId,generation:id.generation}); resolveReady(); await ack; };
        const failed = async (p,code) => { failedCalls++; assert.equal(code,'bootstrap-failed'); assert.deepEqual(p,{documentId:id.documentId,generation:id.generation}); resolveFailed(); };
        if (${bridge}) {
            Object.defineProperties(window, {
                __visionNativeHelperReady: {value:ready, configurable:true},
                __visionNativeHelperFailed: {value:failed, configurable:true},
                __VISION_NATIVE_PALETTE__: {value:true},
                __VISION_NATIVE_REPORTS__: {value:true},
            });
        }
        await import(${JSON.stringify(entry)});
        ${body}
        assert.equal(providerRequests, 0);
        assert.equal(storageCalls, 0);
        dom.window.close();
        console.log('built-helper-ok');
        process.exit(0);
    `;
    const result = await execute(
        process.execPath,
        ["--input-type=module", "-e", program],
        { timeout: 15_000 },
    );
    expect(result.stdout.trim()).toBe("built-helper-ok");
}

describe("optional native helper built artifact", () => {
    it("emits one canonical HTML and confines every static/lazy artifact to its reserved namespace", async () => {
        expect(
            files.filter((name) => !name.startsWith("native-helper-assets/")),
        ).toEqual(["native-helper.html"]);
        expect(
            files.filter((name) => name.endsWith(".js")).length,
        ).toBeGreaterThan(3);
        expect(files.some((name) => /\.(css|woff2?|ttf)$/.test(name))).toBe(
            false,
        );
        expect(html).not.toMatch(
            /modulepreload|stylesheet|font|\/assets\/|id="root"/,
        );
        expect(
            modules.some((name) => /nativeHelperDocument\.ts$/.test(name)),
        ).toBe(true);
        expect(modules.join("\n")).not.toMatch(
            /react-dom|react-router|\/App\.tsx|\/main\.tsx|settingsPreload|categoriesPreload|\/pages\/|@fontsource/,
        );
        for (const name of files)
            expect(await readFile(path.join(directory, name))).toBeTruthy();
    });

    it("preserves every ordinary artifact byte when added after a normal build and refuses missing baseline", async () => {
        const output = await mkdtemp(
            path.join(tmpdir(), "vision-helper-baseline-"),
        );
        await expect(buildNativeHelper({ outDir: output })).rejects.toThrow();
        await writeFile(
            path.join(output, "index.html"),
            "ordinary-index-sentinel",
        );
        await mkdir(path.join(output, "assets"));
        await writeFile(
            path.join(output, "assets", "ordinary.js"),
            "ordinary-js-sentinel",
        );
        const before = await hashes(output);
        await buildNativeHelper({ outDir: output });
        const after = await hashes(output);
        for (const [name, hash] of Object.entries(before))
            expect(after[name]).toBe(hash);
        const production = fileURLToPath(
            new URL("../../../../../dist", import.meta.url),
        );
        await expect(
            buildNativeHelper({ outDir: production, scratch: true }),
        ).rejects.toThrow("isolated output");
    }, 30_000);

    it("is inert without a host invocation and refuses bootstrap without captured document-start bridges", async () => {
        await run(
            `
            assert.equal(window.__VISION_NATIVE_HELPER_ABI__,1);
            for (const name of ['__VISION_NATIVE_HELPER_ABI__','__visionNativeBootstrapHelper','__visionNativeUpdateHelperLocale','__visionNativeDisposeHelper']) {
                const property=Object.getOwnPropertyDescriptor(window,name);
                assert.equal(property.writable,false); assert.equal(property.configurable,false);
            }
            assert.equal(window.__visionNativePaletteAnswer,undefined);
            assert.equal(readyCalls,0); assert.equal(failedCalls,0);
            assert.equal(document.body.childElementCount,0);
            assert.throws(()=>window.__visionNativeBootstrapHelper({...id,initialLanguage:'en'}),/document-start/);
            window.__visionNativeHelperReady=ready;
            window.__visionNativeHelperFailed=failed;
            assert.throws(()=>window.__visionNativeBootstrapHelper({...id,initialLanguage:'en'}),/document-start/);
        `,
            false,
        );
    });

    it("runs actual source helpers/locales and waits for ready ACK before a racing locale update", async () => {
        await run(`
            assert.equal(readyCalls,0);
            ack = new Promise(resolve => releaseAck=resolve);
            Object.defineProperty(window,'__visionNativeHelperReady',{value:()=>{throw Error('Must use captured bridge');}});
            assert.deepEqual(window.__visionNativeBootstrapHelper({...id,initialLanguage:'en'}),{...id,started:true});
            await readyObserved;
            assert.equal(document.documentElement.lang,'en');
            assert.deepEqual(await window.__visionNativePaletteAnswer('2+2','us','EUR',2),{kind:'arithmetic',text:'4'});
            assert.equal((await window.__visionNativeTaxReportProfile(JSON.stringify(sample),2025)).employmentType,'employee');
            const settings=JSON.stringify({belgian_tax_household_v2:sample});
            const english=await window.__visionNativeTaxReportContext(settings,2025);
            assert.equal(english.precomputedPIT.brackets[0].label,'Bracket 1 (25%)');
            let settled=false;
            const update=window.__visionNativeUpdateHelperLocale({...id,language:'nl'}).then(value=>{settled=true;return value;});
            await new Promise(resolve=>setTimeout(resolve,0)); assert.equal(settled,false);
            releaseAck();
            assert.deepEqual(await update,{...id,language:'nl'});
            assert.equal(document.documentElement.lang,'nl');
            const dutch=await window.__visionNativeTaxReportContext(settings,2025);
            assert.notEqual(dutch.precomputedPIT.brackets[0].label,english.precomputedPIT.brackets[0].label);
            assert.equal(readyCalls,1); assert.equal(failedCalls,0);
            await assert.rejects(window.__visionNativeUpdateHelperLocale({...id,generation:'stale',language:'en'}),/unavailable/);
            assert.throws(()=>window.__visionNativeBootstrapHelper({...id,initialLanguage:'en'}),/already issued/);
            assert.deepEqual(window.__visionNativeDisposeHelper(id),{...id,disposed:true});
            assert.deepEqual(window.__visionNativeDisposeHelper(id),{...id,disposed:true});
            assert.equal(await window.__visionNativePaletteAnswer('2+2','us','EUR',2),null);
        `);
    });

    it("fails closed on rejected native ACK with only the fixed structural failure code", async () => {
        await run(`
            ack=Promise.reject(Error('synthetic private error text'));
            ack.catch(()=>{});
            window.__visionNativeBootstrapHelper({...id,initialLanguage:'nl'});
            await failedObserved;
            assert.equal(failedCalls,1); assert.equal(readyCalls,1);
            assert.equal(await window.__visionNativePaletteAnswer('2+2','us','EUR',2),null);
            await assert.rejects(window.__visionNativeUpdateHelperLocale({...id,language:'en'}),/unavailable/);
            window.__visionNativeDisposeHelper(id);
        `);
    });

    it("rejects malformed/stale host requests and suppresses late ACK effects after explicit disposal", async () => {
        await run(`
            assert.throws(()=>window.__visionNativeBootstrapHelper({...id,abi:2,initialLanguage:'en'}));
            assert.throws(()=>window.__visionNativeBootstrapHelper({...id,initialLanguage:'en',extra:true}));
            assert.equal(readyCalls,0);
            ack=new Promise(resolve=>releaseAck=resolve);
            window.__visionNativeBootstrapHelper({...id,initialLanguage:'en'});
            await readyObserved;
            assert.throws(()=>window.__visionNativeDisposeHelper({...id,documentId:'stale'}),/mismatch/);
            window.__visionNativeDisposeHelper(id);
            releaseAck();
            await new Promise(resolve=>setTimeout(resolve,0));
            assert.equal(failedCalls,0);
            assert.equal(await window.__visionNativePaletteAnswer('2+2','us','EUR',2),null);
            await assert.rejects(window.__visionNativeUpdateHelperLocale({...id,language:'nl'}),/unavailable/);
        `);
    });
});
