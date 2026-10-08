/**
 * The view modes and what each one draws: data only, read by main.ts's
 * setViewMode. One row per mode, all rows required: a new mode that forgets
 * a trait is a type error rather than a feature that silently defaults off.
 */
export type ViewMode =
  'photoreal' | 'masked-tiles' | 'best-3d' | 'painted-3d' | 'painted-metro' | 'footprint-3d' | 'vector-city' | 'game3d' | 'cutout-3d';

/** The V key's order. */
export const VIEW_MODE_CYCLE: readonly ViewMode[] = [
  'photoreal', 'masked-tiles', 'cutout-3d', 'best-3d', 'painted-3d', 'painted-metro', 'footprint-3d', 'vector-city', 'game3d'
];

/**
 * paintsWalls: photos on walls, baker runs every frame (painted-3d, painted-metro, footprint-3d)
 * paintsBoxes: collider boxes with photos on their faces (painted-3d, painted-metro)
 * showsPrisms: Overture footprint prisms drawn instead of the boxes (footprint-3d, vector-city)
 * prismPhysics: the cars hit the Overture prism walls rather than the classifier boxes
 *   (footprint-3d, vector-city, and cutout-3d, which collides with them but never draws them)
 * proceduralFacades: Metropolis facade on every wall the photos left bare (painted-metro, vector-city)
 * showsTiles: Google 3D tiles on screen, raw, masked, snapped or cut (photoreal, masked-tiles, best-3d, cutout-3d)
 * snapsTiles: those tiles snapped onto the collider boxes (best-3d)
 * cutsToFootprints: tile fragments outside the 1 m footprint stencil are discarded (cutout-3d)
 */
export interface ViewModeTraits {
  label: string;
  paintsWalls: boolean;
  paintsBoxes: boolean;
  showsPrisms: boolean;
  prismPhysics: boolean;
  proceduralFacades: boolean;
  showsTiles: boolean;
  snapsTiles: boolean;
  cutsToFootprints: boolean;
}

const F = false, T = true;
export const VIEW_MODES: Record<ViewMode, ViewModeTraits> = {
  photoreal:      { label: 'VIEW: REAL 3D',            paintsWalls: F, paintsBoxes: F, showsPrisms: F, prismPhysics: F, proceduralFacades: F, showsTiles: T, snapsTiles: F, cutsToFootprints: F },
  'masked-tiles': { label: 'VIEW: MASKED 3D TILES',    paintsWalls: F, paintsBoxes: F, showsPrisms: F, prismPhysics: F, proceduralFacades: F, showsTiles: T, snapsTiles: F, cutsToFootprints: F },
  'cutout-3d':    { label: 'VIEW: CUTOUT 3D',          paintsWalls: F, paintsBoxes: F, showsPrisms: F, prismPhysics: T, proceduralFacades: F, showsTiles: T, snapsTiles: F, cutsToFootprints: T },
  'best-3d':      { label: 'VIEW: BEST 3D',            paintsWalls: F, paintsBoxes: F, showsPrisms: F, prismPhysics: F, proceduralFacades: F, showsTiles: T, snapsTiles: T, cutsToFootprints: F },
  'painted-3d':   { label: 'VIEW: PAINTED 3D',         paintsWalls: T, paintsBoxes: T, showsPrisms: F, prismPhysics: F, proceduralFacades: F, showsTiles: F, snapsTiles: F, cutsToFootprints: F },
  'painted-metro':{ label: 'VIEW: PAINTED METROPOLIS', paintsWalls: T, paintsBoxes: T, showsPrisms: F, prismPhysics: F, proceduralFacades: T, showsTiles: F, snapsTiles: F, cutsToFootprints: F },
  'footprint-3d': { label: 'VIEW: FOOTPRINT 3D',       paintsWalls: T, paintsBoxes: F, showsPrisms: T, prismPhysics: T, proceduralFacades: F, showsTiles: F, snapsTiles: F, cutsToFootprints: F },
  'vector-city':  { label: 'VIEW: VECTOR CITY',        paintsWalls: F, paintsBoxes: F, showsPrisms: T, prismPhysics: T, proceduralFacades: T, showsTiles: F, snapsTiles: F, cutsToFootprints: F },
  game3d:         { label: 'VIEW: ARCADE 3D',          paintsWalls: F, paintsBoxes: F, showsPrisms: F, prismPhysics: F, proceduralFacades: F, showsTiles: F, snapsTiles: F, cutsToFootprints: F },
};

export const traits = (m: ViewMode): ViewModeTraits => VIEW_MODES[m];

/** A `?view=` value, if it names a mode. */
export function parseViewMode(v: string | null | undefined): ViewMode | null {
  return v != null && Object.prototype.hasOwnProperty.call(VIEW_MODES, v) ? (v as ViewMode) : null;
}
