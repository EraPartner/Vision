import { useEffect, useRef } from "react";
import { resolveAuroraMode } from "@/components/layout/shaderAuroraMode";
import { auroraBlobs } from "@/components/layout/auroraBlobs";

/**
 * WebGL aurora — the "enhanced visual effects" layer (ADR-071).
 *
 * One fullscreen quad running 4-octave value-noise fbm, tinted with the
 * theme's --primary/--accent, plus the two aurora blobs the CSS draws on the
 * other tiers (auroraBlobs.ts mirrors their geometry and drift). Drawing the
 * blobs here keeps one animator: the noise and the blobs change in the same
 * frame, so the window redraws at the shader's cadence instead of at the
 * union of two unsynchronised ones (phase D, 2026-10-26). While the program
 * is live, fx-webgl-live drops the CSS blob layers; they return as the
 * fallback when the context is lost. Budgeted deliberately (ADR-020 history):
 * renders at 0.25× resolution upscaled by CSS, capped at ~20 fps, pauses
 * whenever the window is blurred or the document hidden (rAF alone only
 * pauses for hidden tabs) and draws a single static frame under
 * prefers-reduced-motion or while `staticAtmosphere` is set (ADR-075
 * large-display mitigation — the CSS side freezes the blobs via
 * fx-static-atmosphere; the canvas must hold a frame too or its ~20fps
 * redraw keeps forcing the full-backdrop recomposite the class exists to
 * avoid). Any WebGL failure leaves the CSS aurora blobs (always rendered
 * underneath) as the silent fallback.
 */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_c1;
uniform vec3 u_c2;
// Blobs in canvas pixels, y up: (centre x, centre y, fade-out radius, alpha).
uniform vec4 u_blob_a;
uniform vec4 u_blob_b;
uniform vec3 u_blob_a_col;
uniform vec3 u_blob_b_col;
// The noise layer's opacity (the canvas element itself was 0.6 / 0.5 dark
// before it drew the blobs too).
uniform float u_noise_alpha;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
    );
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    vec2 p = uv * vec2(u_res.x / u_res.y, 1.0);
    float t = u_time * 0.045;
    float n1 = fbm(p * 1.3 + vec2(t, -t * 0.6));
    float n2 = fbm(p * 1.7 - vec2(t * 0.7, t * 0.4) + 3.7);
    // 4-octave value-noise fbm lives in roughly [0.3, 0.7] — thresholds must
    // sit inside that band or the layer renders effectively invisible.
    float m1 = smoothstep(0.34, 0.68, n1);
    float m2 = smoothstep(0.38, 0.72, n2);
    vec3 col = u_c1 * m1 + u_c2 * m2;
    float a = clamp(max(m1, m2), 0.0, 1.0) * 0.65 * u_noise_alpha;
    vec4 noiseLayer = vec4(col * a, a);
    // Same stacking as the CSS: ::before blob, then the canvas, then the
    // ::after blob. Gradients are linear in alpha (premultiplied), from the
    // colour at the centre to transparent at the radius.
    float aa = u_blob_a.w * clamp(1.0 - distance(gl_FragCoord.xy, u_blob_a.xy) / u_blob_a.z, 0.0, 1.0);
    float ab = u_blob_b.w * clamp(1.0 - distance(gl_FragCoord.xy, u_blob_b.xy) / u_blob_b.z, 0.0, 1.0);
    vec4 under = noiseLayer + vec4(u_blob_a_col * aa, aa) * (1.0 - noiseLayer.a);
    gl_FragColor = vec4(u_blob_b_col * ab, ab) + under * (1.0 - ab);
}
`;

function parseHslComponents(raw: string): [number, number, number] | null {
    const m = raw.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (h % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = l - c / 2;
    const seg: Array<[number, number, number]> = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
    ];
    const [r, g, b] = seg[Math.min(5, Math.floor(hp))] ?? [0, 0, 0];
    return [r + m, g + m, b + m];
}

function resolveThemeColor(
    varName: string,
    fallback: [number, number, number],
): [number, number, number] {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
        varName,
    );
    const hsl = parseHslComponents(raw);
    return hsl ? hslToRgb(hsl[0], hsl[1], hsl[2]) : fallback;
}

function readAlpha(style: CSSStyleDeclaration, varName: string, fallback: number): number {
    const value = Number.parseFloat(style.getPropertyValue(varName));
    return Number.isFinite(value) ? value : fallback;
}

interface ShaderAuroraProps {
    /** fx-static-atmosphere state (ADR-075): large display while the user
     * kept a higher tier — hold a static frame instead of looping. */
    staticAtmosphere: boolean;
    /** Whether the blobs drift, as the CSS blobs would on this tier: with
     * Full effects, or on the standard tier. Enhanced without Full effects
     * keeps them at rest (21775a26). */
    blobDrift: boolean;
}

const RESOLUTION_SCALE = 0.25;
// Backing-store width cap (ADR-075): on 1×-scaled large outputs (4K TV at
// native resolution) innerWidth is huge and 0.25× alone would still be a
// half-megapixel canvas. The content is blurry noise and soft radial
// gradients — capping is invisible.
const MAX_CANVAS_WIDTH = 640;
// ~20 fps cap: every shader frame damages the whole window, so the enhanced
// idle cost is per frame, not per pixel. The clock runs on elapsed time, so
// the motion keeps its speed; the blobs drift <=15 px/s, <=0.75 px a step.
// 48, not 50: three 60 Hz vsyncs (50.0 ms) must pass the check despite jitter.
const FRAME_MIN_MS = 48;
// The animation clock advances only while the loop runs, so a pause (window
// blurred, modal open) resumes where it stopped instead of jumping ahead. A
// long gap between two frames (a stalled main thread) counts as one frame.
const MAX_FRAME_STEP_MS = 100;
const NOISE_ALPHA_LIGHT = 0.6;
const NOISE_ALPHA_DARK = 0.5;

export function ShaderAurora({ staticAtmosphere, blobDrift }: ShaderAuroraProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    // The GL lifecycle effect mounts once ([] deps — rebuilding the context on
    // every display move would be far costlier than the loop it manages), so
    // the live prop value flows in through a ref and prop changes re-run the
    // effect's mode decision via the callback it registers.
    const staticAtmosphereRef = useRef(staticAtmosphere);
    const blobDriftRef = useRef(blobDrift);
    const syncRef = useRef<(() => void) | undefined>(undefined);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let gl: WebGLRenderingContext | null = null;
        try {
            // Decorative background: prefer the integrated GPU (battery) and let a
            // blocklisted/software renderer fall through to the cheap CSS blobs
            // rather than run the fbm shader on the CPU.
            gl = canvas.getContext("webgl", {
                alpha: true,
                antialias: false,
                depth: false,
                stencil: false,
                powerPreference: "low-power",
                failIfMajorPerformanceCaveat: true,
            });
        } catch {
            gl = null;
        }
        if (!gl) return; // CSS blobs underneath remain the fallback

        const compile = (type: number, src: string) => {
            const shader = gl.createShader(type);
            if (!shader) return null;
            gl.shaderSource(shader, src);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
            return shader;
        };

        // Uniform locations live in mutable slots so they can be re-resolved when
        // the GL resources are rebuilt after a context-restore (GPU restart).
        let uRes: WebGLUniformLocation | null = null;
        let uTime: WebGLUniformLocation | null = null;
        let uC1: WebGLUniformLocation | null = null;
        let uC2: WebGLUniformLocation | null = null;
        let uBlobA: WebGLUniformLocation | null = null;
        let uBlobB: WebGLUniformLocation | null = null;
        let uBlobACol: WebGLUniformLocation | null = null;
        let uBlobBCol: WebGLUniformLocation | null = null;
        let uNoiseAlpha: WebGLUniformLocation | null = null;

        // Compile + link the program and set up the fullscreen-triangle geometry.
        // Returns false if any step fails (e.g. the context is still recovering),
        // leaving the CSS blobs as the fallback.
        const buildResources = (): boolean => {
            const vs = compile(gl.VERTEX_SHADER, VERT);
            const fs = compile(gl.FRAGMENT_SHADER, FRAG);
            // createProgram returns null on a lost context; the DOM typings omit that.
            const program = gl.createProgram() as WebGLProgram | null;
            if (!vs || !fs || program == null) return false;
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
            gl.useProgram(program);

            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(
                gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]),
                gl.STATIC_DRAW,
            );
            const aPos = gl.getAttribLocation(program, "a_pos");
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

            uRes = gl.getUniformLocation(program, "u_res");
            uTime = gl.getUniformLocation(program, "u_time");
            uC1 = gl.getUniformLocation(program, "u_c1");
            uC2 = gl.getUniformLocation(program, "u_c2");
            uBlobA = gl.getUniformLocation(program, "u_blob_a");
            uBlobB = gl.getUniformLocation(program, "u_blob_b");
            uBlobACol = gl.getUniformLocation(program, "u_blob_a_col");
            uBlobBCol = gl.getUniformLocation(program, "u_blob_b_col");
            uNoiseAlpha = gl.getUniformLocation(program, "u_noise_alpha");
            return true;
        };

        if (!buildResources()) return;
        // Freeze the CSS fallback only after a drawable WebGL program exists.
        // The enhanced tier alone is insufficient: context creation/compilation
        // may fail, in which case the animated CSS blobs must stay live.
        document.documentElement.classList.add("fx-webgl-live");

        let c1 = resolveThemeColor("--primary", [0.18, 0.65, 0.45]);
        let c2 = resolveThemeColor("--accent", [0.85, 0.7, 0.4]);
        // The blob tint follows .liquid-canvas: alphas from the theme tokens
        // (light/dark), hues swapped on the Wealth pages (data-tint).
        const host = canvas.parentElement ?? document.documentElement;
        let blobAlphaA = 0.1;
        let blobAlphaB = 0.08;
        let wealthTint = false;
        let noiseAlpha = NOISE_ALPHA_LIGHT;
        let rem = 16;
        const readTint = () => {
            const style = getComputedStyle(host);
            blobAlphaA = readAlpha(style, "--aurora-primary-alpha", blobAlphaA);
            blobAlphaB = readAlpha(style, "--aurora-accent-alpha", blobAlphaB);
            wealthTint = host.getAttribute("data-tint") === "wealth";
            noiseAlpha = document.documentElement.classList.contains("dark")
                ? NOISE_ALPHA_DARK
                : NOISE_ALPHA_LIGHT;
            const rootFontSize = Number.parseFloat(
                getComputedStyle(document.documentElement).fontSize,
            );
            rem = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
        };
        readTint();

        const motionQuery = window.matchMedia(
            "(prefers-reduced-motion: reduce)",
        );
        let reducedMotion = motionQuery.matches;

        // Active animation time (see MAX_FRAME_STEP_MS).
        let clockMs = 0;
        let lastFrameAt: number | null = null;
        let held = false;

        const draw = () => {
            const timeSec = clockMs / 1000;
            const cssWidth = Math.max(1, window.innerWidth);
            const cssHeight = Math.max(1, window.innerHeight);
            const scale = canvas.width / cssWidth;
            const blobs = auroraBlobs(
                { width: cssWidth, height: cssHeight, rem },
                timeSec,
                blobDriftRef.current && !held,
            );
            const blobA = wealthTint ? c2 : c1;
            const blobB = wealthTint ? c1 : c2;
            gl.uniform2f(uRes, canvas.width, canvas.height);
            gl.uniform1f(uTime, timeSec);
            gl.uniform3f(uC1, c1[0], c1[1], c1[2]);
            gl.uniform3f(uC2, c2[0], c2[1], c2[2]);
            // gl_FragCoord runs bottom-up; the CSS geometry runs top-down.
            gl.uniform4f(
                uBlobA,
                blobs.a.x * scale,
                canvas.height - blobs.a.y * scale,
                blobs.a.radius * scale,
                blobAlphaA,
            );
            gl.uniform4f(
                uBlobB,
                blobs.b.x * scale,
                canvas.height - blobs.b.y * scale,
                blobs.b.radius * scale,
                blobAlphaB,
            );
            gl.uniform3f(uBlobACol, blobA[0], blobA[1], blobA[2]);
            gl.uniform3f(uBlobBCol, blobB[0], blobB[1], blobB[2]);
            gl.uniform1f(uNoiseAlpha, noiseAlpha);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        };

        // Theme, tint and fx-modal-open all arrive as attribute changes on
        // <html> or the canvas host. The animated loop repaints on its own; a
        // held frame is redrawn here or it would keep the old colours.
        const onAttributesChange = () => {
            c1 = resolveThemeColor("--primary", c1);
            c2 = resolveThemeColor("--accent", c2);
            readTint();
            syncRef.current?.();
            if (!running && !contextLost) draw();
        };
        const themeObserver = new MutationObserver(onAttributesChange);
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style"],
        });
        if (host !== document.documentElement) {
            themeObserver.observe(host, {
                attributes: true,
                attributeFilter: ["data-tint"],
            });
        }

        const resize = () => {
            const scale = Math.min(
                RESOLUTION_SCALE,
                MAX_CANVAS_WIDTH / Math.max(1, window.innerWidth),
            );
            const w = Math.max(1, Math.floor(window.innerWidth * scale));
            const h = Math.max(1, Math.floor(window.innerHeight * scale));
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
            // Setting canvas.width wipes the backing store; the animated loop
            // repaints next frame, but a held frame (static, or paused while
            // blurred or under a modal) must be redrawn here or the aurora
            // blanks until the loop resumes.
            if (!running && !contextLost) draw();
        };

        let raf = 0;
        let running = false;
        let contextLost = false;

        resize();
        window.addEventListener("resize", resize);

        const frame = (now: number) => {
            raf = requestAnimationFrame(frame);
            if (lastFrameAt !== null) {
                const step = now - lastFrameAt;
                if (step < FRAME_MIN_MS) return;
                clockMs += Math.min(step, MAX_FRAME_STEP_MS);
            }
            lastFrameAt = now;
            draw();
        };
        const startLoop = () => {
            if (running || contextLost) return;
            running = true;
            lastFrameAt = null;
            raf = requestAnimationFrame(frame);
        };
        const stopLoop = () => {
            running = false;
            cancelAnimationFrame(raf);
        };
        // rAF's implicit throttling only covers hidden tabs (and, in Electron,
        // fully occluded windows) — a desktop window left visible behind
        // another keeps drawing at ~20fps forever. Gate the loop on window
        // focus + document visibility (mirroring the CSS blobs'
        // fx-idle-atmosphere pause; the last rendered frame stays on screen)
        // and on static-atmosphere (ADR-075: hold a frame, mirroring the CSS
        // blobs' fx-static-atmosphere freeze).
        const syncLoop = () => {
            const mode = resolveAuroraMode({
                contextLost,
                reducedMotion,
                staticAtmosphere: staticAtmosphereRef.current,
                hidden: document.hidden,
                focused: document.hasFocus(),
                modalOpen:
                    document.documentElement.classList.contains("fx-modal-open"),
            });
            if (mode === "loop") {
                held = false;
                startLoop();
            } else {
                stopLoop();
                // A static frame puts the blobs at rest, like the CSS
                // `animation: none`; a stopped one keeps the last frame.
                if (mode === "static" && !held) {
                    held = true;
                    draw();
                }
            }
        };
        syncRef.current = syncLoop;

        const onMotionChange = () => {
            reducedMotion = motionQuery.matches;
            syncLoop();
        };
        motionQuery.addEventListener("change", onMotionChange);
        syncLoop();
        window.addEventListener("focus", syncLoop);
        window.addEventListener("blur", syncLoop);
        document.addEventListener("visibilitychange", syncLoop);

        const onContextLost = (e: Event) => {
            e.preventDefault();
            contextLost = true;
            document.documentElement.classList.remove("fx-webgl-live");
            stopLoop();
        };
        // Without this, a GPU-process restart leaves the aurora permanently blank
        // (all GL objects were invalidated) while its listeners keep running.
        // Rebuild the program/geometry, then resume from the current motion state.
        const onContextRestored = () => {
            if (!buildResources()) return;
            contextLost = false;
            document.documentElement.classList.add("fx-webgl-live");
            resize();
            held = false;
            syncLoop();
        };
        canvas.addEventListener("webglcontextlost", onContextLost);
        canvas.addEventListener("webglcontextrestored", onContextRestored);

        return () => {
            syncRef.current = undefined;
            document.documentElement.classList.remove("fx-webgl-live");
            stopLoop();
            window.removeEventListener("resize", resize);
            motionQuery.removeEventListener("change", onMotionChange);
            window.removeEventListener("focus", syncLoop);
            window.removeEventListener("blur", syncLoop);
            document.removeEventListener("visibilitychange", syncLoop);
            canvas.removeEventListener("webglcontextlost", onContextLost);
            canvas.removeEventListener(
                "webglcontextrestored",
                onContextRestored,
            );
            themeObserver.disconnect();
            gl.getExtension("WEBGL_lose_context")?.loseContext();
        };
    }, []);

    // Display transitions (dragged to/from a >6MP display, detected by the
    // useVisualEffectsTier resize+poll): re-run the mode decision so the loop
    // stops into a held frame, or resumes, without tearing down the context.
    // No-op before GL init or after a WebGL failure (syncRef stays unset —
    // the CSS blobs are animating as the fallback and nothing must change).
    useEffect(() => {
        staticAtmosphereRef.current = staticAtmosphere;
        syncRef.current?.();
    }, [staticAtmosphere]);

    // Full effects toggled: the loop picks the new drift up on its next
    // frame; nothing to do while it is stopped (the held frame stays).
    useEffect(() => {
        blobDriftRef.current = blobDrift;
    }, [blobDrift]);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            // The noise opacity (0.6, dark 0.5) lives in the shader now
            // (u_noise_alpha), so the blobs it also draws keep their CSS
            // alphas. Dark mode stays capped well below the old 0.8: shader
            // peaks (0.65 in the fragment) × 0.8 pushed bright primary washes
            // behind light foreground text — "Good afternoon" went
            // light-on-light. 0.5 keeps the ambiance while the canvas-text
            // halo (index.css) guarantees legibility at the peaks.
            className="absolute inset-0 h-full w-full"
        />
    );
}
