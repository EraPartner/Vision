#include <metal_stdlib>
using namespace metal;

struct AuroraUniforms {
    float2 res;
    float time;
    float noiseAlpha;
    float4 c1;
    float4 c2;
    float4 blobA;
    float4 blobB;
    float4 blobACol;
    float4 blobBCol;
};

vertex float4 auroraVertex(uint vid [[vertex_id]]) {
    const float2 positions[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    return float4(positions[vid], 0.0, 1.0);
}

static float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453123); }

static float noise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + float2(1.0, 0.0)), u.x),
        mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), u.x),
        u.y);
}

static float fbm(float2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.0;
        a *= 0.5;
    }
    return v;
}

fragment float4 auroraFragment(float4 position [[position]], constant AuroraUniforms &u [[buffer(0)]]) {
    // gl_FragCoord has a bottom-left origin.
    float2 coord = float2(position.x, u.res.y - position.y);
    float2 uv = coord / u.res;
    float2 p = uv * float2(u.res.x / u.res.y, 1.0);
    float t = u.time * 0.045;
    float n1 = fbm(p * 1.3 + float2(t, -t * 0.6));
    float n2 = fbm(p * 1.7 - float2(t * 0.7, t * 0.4) + 3.7);
    float m1 = smoothstep(0.34, 0.68, n1);
    float m2 = smoothstep(0.38, 0.72, n2);
    float3 col = u.c1.rgb * m1 + u.c2.rgb * m2;
    float a = clamp(max(m1, m2), 0.0, 1.0) * 0.65 * u.noiseAlpha;
    float4 noiseLayer = float4(col * a, a);
    // Same stacking as the CSS: ::before blob, the noise, then the ::after blob; each
    // gradient linear in alpha from its colour at the centre to transparent at the radius.
    float aa = u.blobA.w * clamp(1.0 - distance(coord, u.blobA.xy) / u.blobA.z, 0.0, 1.0);
    float ab = u.blobB.w * clamp(1.0 - distance(coord, u.blobB.xy) / u.blobB.z, 0.0, 1.0);
    float4 under = noiseLayer + float4(u.blobACol.rgb * aa, aa) * (1.0 - noiseLayer.a);
    return float4(u.blobBCol.rgb * ab, ab) + under * (1.0 - ab);
}
