import { useEffect, useRef } from "react";

/**
 * WebGL aurora — the "enhanced visual effects" layer (ADR-071).
 *
 * One fullscreen quad running 4-octave value-noise fbm, tinted with the
 * theme's --primary/--accent. Budgeted deliberately (ADR-020 history):
 * renders at 0.25× resolution upscaled by CSS, capped at ~30 fps, pauses
 * when the tab is hidden (rAF) and draws a single static frame under
 * prefers-reduced-motion. Any WebGL failure leaves the CSS aurora blobs
 * (always rendered underneath) as the silent fallback.
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
    float a = clamp(max(m1, m2), 0.0, 1.0) * 0.65;
    gl_FragColor = vec4(col * a, a);
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
        [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ];
    const [r, g, b] = seg[Math.min(5, Math.floor(hp))] ?? [0, 0, 0];
    return [r + m, g + m, b + m];
}

function resolveThemeColor(varName: string, fallback: [number, number, number]): [number, number, number] {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName);
    const hsl = parseHslComponents(raw);
    return hsl ? hslToRgb(hsl[0], hsl[1], hsl[2]) : fallback;
}

const RESOLUTION_SCALE = 0.25;
const FRAME_MIN_MS = 33; // ~30 fps cap

export function ShaderAurora() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let gl: WebGLRenderingContext | null = null;
        try {
            gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false });
        } catch {
            gl = null;
        }
        if (!gl) return; // CSS blobs underneath remain the fallback

        const compile = (type: number, src: string) => {
            const shader = gl!.createShader(type);
            if (!shader) return null;
            gl!.shaderSource(shader, src);
            gl!.compileShader(shader);
            if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) return null;
            return shader;
        };

        const vs = compile(gl.VERTEX_SHADER, VERT);
        const fs = compile(gl.FRAGMENT_SHADER, FRAG);
        const program = gl.createProgram();
        if (!vs || !fs || !program) return;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
        gl.useProgram(program);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(program, "a_pos");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const uRes = gl.getUniformLocation(program, "u_res");
        const uTime = gl.getUniformLocation(program, "u_time");
        const uC1 = gl.getUniformLocation(program, "u_c1");
        const uC2 = gl.getUniformLocation(program, "u_c2");

        let c1 = resolveThemeColor("--primary", [0.18, 0.65, 0.45]);
        let c2 = resolveThemeColor("--accent", [0.85, 0.7, 0.4]);
        const refreshColors = () => {
            c1 = resolveThemeColor("--primary", c1);
            c2 = resolveThemeColor("--accent", c2);
        };
        const themeObserver = new MutationObserver(refreshColors);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });

        const resize = () => {
            const w = Math.max(1, Math.floor(window.innerWidth * RESOLUTION_SCALE));
            const h = Math.max(1, Math.floor(window.innerHeight * RESOLUTION_SCALE));
            canvas.width = w;
            canvas.height = h;
            gl!.viewport(0, 0, w, h);
        };
        resize();
        window.addEventListener("resize", resize);

        const draw = (timeSec: number) => {
            gl!.uniform2f(uRes, canvas.width, canvas.height);
            gl!.uniform1f(uTime, timeSec);
            gl!.uniform3f(uC1, c1[0], c1[1], c1[2]);
            gl!.uniform3f(uC2, c2[0], c2[1], c2[2]);
            gl!.clearColor(0, 0, 0, 0);
            gl!.clear(gl!.COLOR_BUFFER_BIT);
            gl!.drawArrays(gl!.TRIANGLES, 0, 3);
        };

        const reducedMotion =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        let raf = 0;
        let last = 0;
        if (reducedMotion) {
            draw(0);
        } else {
            const frame = (now: number) => {
                raf = requestAnimationFrame(frame);
                if (now - last < FRAME_MIN_MS) return;
                last = now;
                draw(now / 1000);
            };
            raf = requestAnimationFrame(frame);
        }

        const onContextLost = (e: Event) => {
            e.preventDefault();
            cancelAnimationFrame(raf);
        };
        canvas.addEventListener("webglcontextlost", onContextLost);

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", resize);
            canvas.removeEventListener("webglcontextlost", onContextLost);
            themeObserver.disconnect();
            gl?.getExtension("WEBGL_lose_context")?.loseContext();
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            // Dark mode capped well below the old 0.8: shader peaks (0.65 in
            // the fragment) × 0.8 pushed bright primary washes behind light
            // foreground text — "Good afternoon" went light-on-light. 0.5
            // keeps the ambiance while the canvas-text halo (index.css)
            // guarantees legibility at the peaks.
            className="absolute inset-0 h-full w-full opacity-60 dark:opacity-50"
        />
    );
}
