/**
 * Centralized, modular theme and color design system for Smuggler's Town 3D.
 *
 * Defines color palettes for UI, HUD radar, 3D atmospheric sky, lighting,
 * and procedural terrain biomes. Supports swappable presets so the visual
 * aesthetic can be extended, tweaked, or themed cleanly in one place.
 */

interface ColorTheme {
  readonly id: string;
  readonly name: string;
  readonly ui: {
    readonly bg: string;
    readonly panel: string;
    readonly panel2: string;
    readonly panelGlass: string;
    readonly line: string;
    readonly ink: string;
    readonly muted: string;
    readonly accent: string;
    readonly sand: string; // Secondary / gold highlight
    readonly hot: string;
    readonly cool: string;
    readonly good: string;
    readonly scrim: string;
    readonly fieldBg: string;
    readonly insetBg: string;
  };
  readonly minimap: {
    readonly lowGround: { readonly r: number; readonly g: number; readonly b: number };
    readonly highRidge: { readonly r: number; readonly g: number; readonly b: number };
    readonly rings: string;
    readonly north: string;
    readonly rimDefault: string;
  };
  readonly sky: {
    readonly zenith: number;
    readonly mid: number;
    readonly horizon: number;
    readonly midLight: number;
    readonly haze: number;
    readonly nadir: string;
  };
  readonly lighting: {
    readonly sun: number;
    readonly ambient: number;
    readonly groundBounce: number;
  };
  readonly terrain: {
    readonly gridBg: string;
    readonly gridLine: string;
    readonly biome: {
      readonly bedrock: readonly [number, number, number];
      readonly steppe: readonly [number, number, number];
      readonly cliff: readonly [number, number, number];
      readonly snow: readonly [number, number, number];
    };
  };
  readonly buildings: {
    readonly tall: number;
    readonly mid: number;
    readonly low: number;
    readonly propRock: number;
    readonly deck: number;
  };
}

/**
 * Modern High-Octane Obsidian & Cyber-Arcade Theme (Default).
 * Deep midnight obsidian bases, dark frosted glassmorphism, electric coral & cyber amber accents,
 * tactical blue-slate radar relief, and clean alpine terrain.
 */
export const CYBER_OBSIDIAN_THEME: ColorTheme = {
  id: 'cyber-obsidian',
  name: 'Cyber Obsidian',
  ui: {
    bg: '#0b0f17',
    panel: '#111a26',
    panel2: '#172334',
    panelGlass: 'rgba(15, 22, 34, 0.86)',
    line: '#223247',
    ink: '#f1f5f9',
    muted: '#94a3b8',
    accent: '#ff5500',
    sand: '#fbbf24',
    hot: '#ff2a5f',
    cool: '#38bdf8',
    good: '#10b981',
    scrim: 'rgba(11, 15, 23, 0.95)',
    fieldBg: 'rgba(7, 11, 18, 0.65)',
    insetBg: 'rgba(0, 0, 0, 0.35)'
  },
  minimap: {
    lowGround: { r: 16, g: 24, b: 38 },
    highRidge: { r: 131, g: 164, b: 208 },
    rings: 'rgba(241, 245, 249, 0.15)',
    north: 'rgba(241, 245, 249, 0.85)',
    rimDefault: 'rgba(56, 189, 248, 0.35)'
  },
  sky: {
    zenith: 0x245cb5,
    mid: 0x649edc,
    horizon: 0xc4d8ee,
    midLight: 0x98bfe6,
    haze: 0x9ab7d6,
    nadir: '#3d2e1e'
  },
  lighting: {
    sun: 0xfff2dd,
    ambient: 0x8899bb,
    groundBounce: 0x4d3b28
  },
  terrain: {
    gridBg: '#0f1724',
    gridLine: '#22344c',
    biome: {
      bedrock: [0.80, 0.65, 0.45],
      steppe: [0.88, 0.73, 0.48],
      cliff: [0.68, 0.52, 0.36],
      snow: [0.90, 0.86, 0.78]
    }
  },
  buildings: {
    tall: 0x28384a,
    mid: 0x354252,
    low: 0x3b404a,
    propRock: 0x7a5a3e,
    deck: 0x1e2736
  }
};

/**
 * Neon Night / Synthwave Theme Preset.
 */
export const NEON_NIGHT_THEME: ColorTheme = {
  id: 'neon-night',
  name: 'Neon Night',
  ui: {
    bg: '#0a0a14',
    panel: '#131226',
    panel2: '#1d1b38',
    panelGlass: 'rgba(19, 18, 38, 0.88)',
    line: '#2d2856',
    ink: '#f8f8fc',
    muted: '#9e9bb8',
    accent: '#ff007f',
    sand: '#ffd000',
    hot: '#ff1744',
    cool: '#00f0ff',
    good: '#00e676',
    scrim: 'rgba(10, 10, 20, 0.96)',
    fieldBg: 'rgba(8, 8, 16, 0.7)',
    insetBg: 'rgba(0, 0, 0, 0.4)'
  },
  minimap: {
    lowGround: { r: 18, g: 15, b: 38 },
    highRidge: { r: 160, g: 130, b: 240 },
    rings: 'rgba(240, 230, 255, 0.18)',
    north: 'rgba(255, 230, 255, 0.9)',
    rimDefault: 'rgba(0, 240, 255, 0.4)'
  },
  sky: {
    zenith: 0x1a0b36,
    mid: 0x3d1a6d,
    horizon: 0x7b3294,
    midLight: 0x5e237a,
    haze: 0x6e2c84,
    nadir: '#120824'
  },
  lighting: {
    sun: 0xffd0e8,
    ambient: 0x7b68ae,
    groundBounce: 0x2b1d44
  },
  terrain: {
    gridBg: '#120f24',
    gridLine: '#2b214d',
    biome: {
      bedrock: [0.22, 0.18, 0.38],
      steppe: [0.32, 0.22, 0.48],
      cliff: [0.48, 0.38, 0.62],
      snow: [0.85, 0.78, 0.95]
    }
  },
  buildings: {
    tall: 0x2d1f4d,
    mid: 0x3d2b68,
    low: 0x261942,
    propRock: 0x3a2c54,
    deck: 0x1f1538
  }
};

/**
 * Available theme presets for simple selection or runtime swapping.
 */
export const THEMES: Record<string, ColorTheme> = {
  [CYBER_OBSIDIAN_THEME.id]: CYBER_OBSIDIAN_THEME,
  [NEON_NIGHT_THEME.id]: NEON_NIGHT_THEME
};

/** Active theme singleton */
let activeTheme: ColorTheme = CYBER_OBSIDIAN_THEME;

export function getActiveTheme(): ColorTheme {
  return activeTheme;
}

export function setActiveTheme(theme: ColorTheme): void {
  activeTheme = theme;
  if (typeof document !== 'undefined') {
    applyThemeToDocument(theme);
  }
}

/**
 * Applies a theme's UI variables directly to the document root element.
 */
export function applyThemeToDocument(theme: ColorTheme = activeTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const { ui } = theme;
  root.style.setProperty('--bg', ui.bg);
  root.style.setProperty('--panel', ui.panel);
  root.style.setProperty('--panel2', ui.panel2);
  root.style.setProperty('--panel-glass', ui.panelGlass);
  root.style.setProperty('--line', ui.line);
  root.style.setProperty('--ink', ui.ink);
  root.style.setProperty('--muted', ui.muted);
  root.style.setProperty('--accent', ui.accent);
  root.style.setProperty('--sand', ui.sand);
  root.style.setProperty('--hot', ui.hot);
  root.style.setProperty('--cool', ui.cool);
  root.style.setProperty('--good', ui.good);
  root.style.setProperty('--scrim', ui.scrim);
  root.style.setProperty('--field-bg', ui.fieldBg);
  root.style.setProperty('--inset-bg', ui.insetBg);

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', ui.bg);
  }
}

// Convenience token exports referencing active theme
export const UI_COLORS = CYBER_OBSIDIAN_THEME.ui;
export const MINIMAP_COLORS = CYBER_OBSIDIAN_THEME.minimap;
export const SKY_COLORS = CYBER_OBSIDIAN_THEME.sky;
export const LIGHTING_COLORS = CYBER_OBSIDIAN_THEME.lighting;
export const TERRAIN_COLORS = CYBER_OBSIDIAN_THEME.terrain;
export const BUILDING_COLORS = CYBER_OBSIDIAN_THEME.buildings;
