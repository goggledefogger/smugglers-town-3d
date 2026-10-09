import { describe, it, expect, afterEach } from 'vitest';
import { injectDetailGrain } from '../src/render/DetailGrain.ts';
import { injectTileSharpen, getTileSharpen, setTileSharpen, SHARPEN_FRAGMENT } from '../src/render/TileSharpen.ts';
import { TILE_SHARPEN_DEFAULT, TILE_SHARPEN_AT_START, clampSharpen } from '../src/render/lookConfig.ts';

// a MeshBasicMaterial-shaped shader object, as three hands to onBeforeCompile
const basicShader = (): any => ({
  uniforms: {} as Record<string, { value: unknown }>,
  vertexShader: 'void main() {\n#include <begin_vertex>\n#include <project_vertex>\n}',
  fragmentShader: 'void main() {\nvec4 diffuseColor = vec4(diffuse, opacity);\n#include <map_fragment>\n#include <color_fragment>\n}'
});

describe('tile sharpen', () => {
  afterEach(() => setTileSharpen(TILE_SHARPEN_DEFAULT));

  it('defaults to 0.5 with no ?sharpen', () => {
    expect(TILE_SHARPEN_DEFAULT).toBe(0.5);
    expect(TILE_SHARPEN_AT_START).toBe(TILE_SHARPEN_DEFAULT);
    expect(getTileSharpen()).toBe(TILE_SHARPEN_DEFAULT);
  });

  it('clamps URL and console values to [0, 1]', () => {
    expect(clampSharpen('0.3')).toBeCloseTo(0.3);
    expect(clampSharpen('2')).toBe(1);
    expect(clampSharpen('-1')).toBe(0);
    expect(clampSharpen('abc')).toBeNull();
    expect(clampSharpen(null)).toBeNull();
    setTileSharpen(7);
    expect(getTileSharpen()).toBe(1);
  });

  it('injects after map_fragment and ahead of the grain, with the shared uniform', () => {
    const s = basicShader();
    injectDetailGrain(s);
    injectTileSharpen(s);
    expect(s.fragmentShader).toContain('uniform float uSharpen;');
    expect(s.uniforms.uSharpen?.value).toBe(TILE_SHARPEN_DEFAULT);
    const map = s.fragmentShader.indexOf('#include <map_fragment>');
    const sharpen = s.fragmentShader.indexOf('textureSize(map, 0)');
    const grain = s.fragmentShader.indexOf('diffuseColor.rgb *= 1.0 + (g - 0.5)');
    expect(map).toBeGreaterThan(-1);
    expect(sharpen).toBeGreaterThan(map);
    expect(grain).toBeGreaterThan(sharpen);
    // one uniform object across programs, so the debug hook retunes every tile at once
    const t = basicShader();
    injectDetailGrain(t);
    injectTileSharpen(t);
    expect(t.uniforms.uSharpen).toBe(s.uniforms.uSharpen);
    setTileSharpen(0.2);
    expect(s.uniforms.uSharpen?.value).toBe(0.2);
  });

  it('touches the albedo only inside a strength > 0 branch, so 0 leaves it bit-exact', () => {
    const body = SHARPEN_FRAGMENT;
    const branch = body.indexOf('if (sw > 0.0)');
    expect(body).toContain('float sw = uSharpen * (1.0 - smoothstep(uGrainFade.x, uGrainFade.y');
    expect(branch).toBeGreaterThan(-1);
    const writes = [...body.matchAll(/diffuseColor\.rgb\s*=/g)].map(m => m.index!);
    expect(writes.length).toBe(1);
    expect(writes[0]).toBeGreaterThan(branch);
    expect(body).not.toMatch(/sampledDiffuseColor\s*=/);
  });

  it('leaves a shader without the grain, or without a map, alone', () => {
    const noGrain = basicShader();
    const before = noGrain.fragmentShader;
    injectTileSharpen(noGrain);
    expect(noGrain.fragmentShader).toBe(before);
    expect(noGrain.uniforms.uSharpen).toBeUndefined();
    const noMap = { uniforms: {}, vertexShader: 'void main(){}', fragmentShader: 'void main(){}' };
    injectTileSharpen(noMap as any);
    expect(noMap.fragmentShader).toBe('void main(){}');
  });
});
