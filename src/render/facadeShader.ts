/**
 * The Metropolis facade: a procedural building wall for any vertical face
 * the photos could not cover, and a faint story/bay grid laid over the
 * photos they did. Shared by the collider boxes (Painted Metropolis) and the
 * Overture prisms (Vector City). Unlit: the result is written straight to
 * the fragment like the photos and the satellite ground around it.
 */
export const FACADE_GLSL = `
float facadeHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

/** How much window detail to draw here: none far away or at a grazing angle (moire). */
float facadeFade(vec3 nrm, vec3 wpos) {
  vec3 viewDir = normalize(cameraPosition - wpos);
  float viewDot = clamp(abs(dot(nrm, viewDir)), 0.0, 1.0);
  float dist = length(wpos - cameraPosition);
  return (1.0 - smoothstep(140.0, 320.0, dist)) * smoothstep(0.10, 0.35, viewDot);
}

/**
 * wallU: metres along the wall; hAbove: metres above the wall foot; bHeight: wall height;
 * seed: one value per building; cornerDist: metres to the nearest vertical edge.
 */
vec3 metroWall(float wallU, float hAbove, float bHeight, vec3 nrm, vec3 wpos, vec2 seed, float cornerDist) {
  float belowRoof = bHeight - hAbove;
  float bSeed = facadeHash(seed);
  float isTower = step(38.0, bHeight);
  float isMid = step(16.0, bHeight) * (1.0 - isTower);
  vec3 base;
  if (isTower > 0.5) {
    base = bSeed < 0.35 ? vec3(0.15, 0.22, 0.32) : (bSeed < 0.70 ? vec3(0.13, 0.16, 0.20) : vec3(0.20, 0.25, 0.28));
  } else if (isMid > 0.5) {
    base = bSeed < 0.35 ? vec3(0.55, 0.50, 0.43) : (bSeed < 0.70 ? vec3(0.46, 0.47, 0.49) : vec3(0.50, 0.44, 0.38));
  } else {
    base = bSeed < 0.45 ? vec3(0.48, 0.25, 0.19) : (bSeed < 0.75 ? vec3(0.41, 0.33, 0.27) : vec3(0.50, 0.47, 0.42));
  }
  float story = isTower > 0.5 ? 3.6 : 3.2;
  float bay = isTower > 0.5 ? 2.2 : 2.8;
  vec2 bays = vec2(wallU / bay, belowRoof / story);
  vec2 room = floor(bays);
  vec2 edge = abs(fract(bays) - 0.5);
  vec2 aa = max(fwidth(bays), vec2(0.001));
  vec2 ap = isTower > 0.5 ? vec2(0.38, 0.34) : vec2(0.28, 0.24);
  vec2 aperture = 1.0 - smoothstep(ap - aa, ap + aa, edge);
  float windows = aperture.x * aperture.y;
  windows *= 1.0 - smoothstep(0.15, 0.5, max(aa.x, aa.y));
  windows *= step(5.5, bHeight) * step(0.4, belowRoof);
  float fade = facadeFade(nrm, wpos);
  windows *= fade;

  float roomHash = facadeHash(room + seed * 17.0 + vec2(37.17, 73.91));
  vec3 darkGlass = mix(vec3(0.07, 0.10, 0.14), vec3(0.14, 0.20, 0.28), clamp(1.0 - belowRoof / bHeight, 0.0, 1.0));
  vec3 win = roomHash > 0.68 ? vec3(1.0, 0.85, 0.55) * (0.85 + 0.25 * sin(roomHash * 25.0))
    : (roomHash > 0.54 ? vec3(0.75, 0.90, 1.0) * 0.9 : darkGlass);
  float mullion = 1.0 - smoothstep(0.03 - aa.x, 0.03 + aa.x, abs(edge.x - 0.22));
  win = mix(win, base * 0.7, mullion * 0.6);

  // one sun: faces along z catch more of it than faces along x
  float faceLight = 0.62 + 0.10 * abs(nrm.z);
  float contact = smoothstep(0.0, 0.12, hAbove / max(1.0, bHeight));
  float eave = smoothstep(0.0, 0.6, belowRoof);
  vec3 wall = base * faceLight * mix(0.72, 1.0, contact) * mix(0.82, 1.0, eave);

  float isStore = (1.0 - step(4.2, hAbove)) * step(0.65, hAbove);
  if (isStore > 0.5) {
    vec2 sb = vec2(wallU / 3.6, hAbove / 4.2);
    vec2 se = abs(fract(sb) - 0.5);
    vec2 sa = max(fwidth(sb), vec2(0.001));
    vec2 sap = 1.0 - smoothstep(vec2(0.38, 0.32) - sa, vec2(0.38, 0.32) + sa, se);
    wall = mix(wall, vec3(0.96, 0.82, 0.58) * 0.7, sap.x * sap.y * fade * 0.85);
  }
  float isPlinth = 1.0 - step(0.65, hAbove);
  wall = mix(wall, vec3(0.18, 0.19, 0.21), isPlinth * 0.9);
  wall *= mix(0.70, 1.0, smoothstep(0.0, 0.65, cornerDist));
  if (isStore < 0.5 && isPlinth < 0.5) wall = mix(wall, win, windows * 0.78);
  return wall;
}

/** A faint story and bay grid over a photographed wall, so the blur reads as floors. */
vec3 photoDetail(vec3 photo, float wallU, float hAbove, float bHeight, vec3 nrm, vec3 wpos) {
  if (bHeight < 5.5) return photo;
  vec2 bays = vec2(wallU / 2.8, (bHeight - hAbove) / 3.2);
  vec2 edge = abs(fract(bays) - 0.5);
  vec2 aa = max(fwidth(bays), vec2(0.001));
  float lines = max(smoothstep(0.44 - aa.x, 0.44 + aa.x, edge.x), smoothstep(0.44 - aa.y, 0.44 + aa.y, edge.y));
  lines *= 1.0 - smoothstep(0.15, 0.5, max(aa.x, aa.y));
  return photo * mix(1.0, 0.86, lines * facadeFade(nrm, wpos));
}

/** The satellite roof framed by a parapet; edgeDist is metres in from the roof edge. */
vec3 metroRoof(vec3 sat, float edgeDist) {
  float isParapet = 1.0 - smoothstep(0.55, 0.75, edgeDist);
  float inner = smoothstep(0.70, 1.40, edgeDist);
  return mix(sat * mix(0.75, 1.0, inner), vec3(0.24, 0.25, 0.27), isParapet);
}
`;
