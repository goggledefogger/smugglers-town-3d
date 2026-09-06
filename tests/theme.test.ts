import { describe, it, expect, beforeEach } from 'vitest';
import {
  CYBER_OBSIDIAN_THEME,
  NEON_NIGHT_THEME,
  THEMES,
  getActiveTheme,
  setActiveTheme,
  applyThemeToDocument,
  UI_COLORS,
  MINIMAP_COLORS,
  SKY_COLORS,
  LIGHTING_COLORS,
  TERRAIN_COLORS,
  BUILDING_COLORS
} from '../src/core/theme.ts';

describe('Modular Color Theme System', () => {
  beforeEach(() => {
    setActiveTheme(CYBER_OBSIDIAN_THEME);
  });

  it('defaults to Cyber Obsidian theme with sleek dark palette', () => {
    const active = getActiveTheme();
    expect(active.id).toBe('cyber-obsidian');
    expect(active.ui.bg).toBe('#0b0f17');
    expect(active.ui.accent).toBe('#ff5500');
    expect(active.ui.ink).toBe('#f1f5f9');
  });

  it('exports convenient typed color token objects matching the default theme', () => {
    expect(UI_COLORS.bg).toBe(CYBER_OBSIDIAN_THEME.ui.bg);
    expect(MINIMAP_COLORS.lowGround).toEqual(CYBER_OBSIDIAN_THEME.minimap.lowGround);
    expect(SKY_COLORS.zenith).toBe(CYBER_OBSIDIAN_THEME.sky.zenith);
    expect(LIGHTING_COLORS.groundBounce).toBe(CYBER_OBSIDIAN_THEME.lighting.groundBounce);
    expect(TERRAIN_COLORS.gridBg).toBe(CYBER_OBSIDIAN_THEME.terrain.gridBg);
    expect(BUILDING_COLORS.tall).toBe(CYBER_OBSIDIAN_THEME.buildings.tall);
  });

  it('supports switching to another theme preset seamlessly', () => {
    setActiveTheme(NEON_NIGHT_THEME);
    expect(getActiveTheme().id).toBe('neon-night');
    expect(getActiveTheme().ui.bg).toBe('#0a0a14');
    expect(getActiveTheme().ui.accent).toBe('#ff007f');

    setActiveTheme(CYBER_OBSIDIAN_THEME);
    expect(getActiveTheme().id).toBe('cyber-obsidian');
  });

  it('has all required color sections populated for all registered themes', () => {
    for (const [id, theme] of Object.entries(THEMES)) {
      expect(theme.id).toBe(id);
      expect(theme.name).toBeDefined();

      // UI tokens
      expect(theme.ui.bg).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.ui.panel).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.ui.line).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.ui.accent).toBeDefined();
      expect(theme.ui.sand).toBeDefined();

      // Minimap tokens
      expect(theme.minimap.lowGround.r).toBeGreaterThanOrEqual(0);
      expect(theme.minimap.highRidge.r).toBeGreaterThanOrEqual(0);

      // Sky & Lighting
      expect(typeof theme.sky.zenith).toBe('number');
      expect(typeof theme.sky.horizon).toBe('number');
      expect(typeof theme.lighting.sun).toBe('number');
      expect(typeof theme.lighting.groundBounce).toBe('number');

      // Terrain biome
      expect(theme.terrain.biome.bedrock).toHaveLength(3);
      expect(theme.terrain.biome.steppe).toHaveLength(3);
      expect(theme.terrain.biome.cliff).toHaveLength(3);
      expect(theme.terrain.biome.snow).toHaveLength(3);

      // Buildings
      expect(typeof theme.buildings.tall).toBe('number');
      expect(typeof theme.buildings.propRock).toBe('number');
    }
  });

  it('applies theme variables to document root safely in DOM environment or noops in node', () => {
    expect(() => applyThemeToDocument(CYBER_OBSIDIAN_THEME)).not.toThrow();
  });
});
