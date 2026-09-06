/**
 * Procedural 2D canvas graffiti artists for the word "TOWN".
 * Comprehensive suite of 10 distinct, authentic street art styles:
 * 1. Subway Bubble Throw-Up ("Throwie") - fat 3D drops, bubbly letters, paint drips
 * 2. Speed Drift Chisel Tag - forward aerodynamic slant, razor-sharp points, speed cut
 * 3. Desert Wasteland Military Stencil - bridge cutouts, framing brackets, overspray mist
 * 4. Heavy-Metal Chrome Wildstyle - horizon-split liquid chrome, star flares, flame glow
 * 5. Skate-Punk Fat-Cap Marker Tag - raw expressive hand-drawn lettering, halo, drip runs
 * 6. Urban Blockbuster 3D - giant high-impact architectural block letters with deep extrusion
 * 7. Krink Mop Squeezer Tag - juicy, bleeding, dripping street mop marker
 * 8. Melting Acid Psychedelic - wavy, molten liquid lettering with psychedelic gradients
 * 9. Cyberpunk Neon Drift Tag - geometric sharp cuts, chromatic aberration, neon aura
 * 10. Street "HELLO" Sticker Slap - priority mail adhesive label with scrawled marker tag
 */

/** Helper for hex colors or fallback */
const toHex = (c: number): string => '#' + c.toString(16).padStart(6, '0');

/**
 * 1. SUV (Back Tailgate)
 * Classic NYC subway bubble-letter throw-up ("Throwie").
 * Chubby rounded connected letters, dual-tone gradient fill, thick comic ink
 * outline, deep 3D drop-shadow block extrusion, highlight shines, and paint drips.
 */
export function drawSubwayBubbleGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0x3399ff
): void {
  ctx.save();
  const text = 'TOWN';

  // Backdrop glow / aura
  const aura = ctx.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * 0.48);
  aura.addColorStop(0, 'rgba(51, 153, 255, 0.45)');
  aura.addColorStop(0.7, 'rgba(180, 50, 240, 0.2)');
  aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = aura;
  ctx.fillRect(0, 0, w, h);

  const fontSize = Math.floor(h * 0.58);
  ctx.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cx = w / 2;
  const cy = h / 2 - 4;

  // 1. Heavy 3D extrusion drop-shadow (offset down-right)
  ctx.fillStyle = '#0a0614';
  ctx.strokeStyle = '#0a0614';
  ctx.lineWidth = 14;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (let offset = 14; offset >= 2; offset -= 2) {
    ctx.strokeText(text, cx + offset * 0.7, cy + offset);
    ctx.fillText(text, cx + offset * 0.7, cy + offset);
  }

  // 2. Thick black comic outline
  ctx.strokeStyle = '#0d0d12';
  ctx.lineWidth = 12;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, cx, cy);

  // 3. Vibrant bubbly gradient fill (Cyan to Gold/Pink)
  const grad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
  grad.addColorStop(0, '#7df9ff');
  grad.addColorStop(0.45, toHex(accentColor));
  grad.addColorStop(0.85, '#ffdd55');
  grad.addColorStop(1, '#ff66aa');
  ctx.fillStyle = grad;
  ctx.fillText(text, cx, cy);

  // 4. White rounded highlight gleams
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  const metrics = ctx.measureText(text);
  const totalW = metrics.width;
  const letterSpacing = totalW / 4;
  const startX = cx - totalW / 2 + letterSpacing * 0.5;

  for (let i = 0; i < 4; i++) {
    const lx = startX + i * letterSpacing;
    const ly = cy - fontSize * 0.28;
    ctx.beginPath();
    ctx.ellipse(lx - 4, ly, fontSize * 0.12, fontSize * 0.05, -0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lx + fontSize * 0.1, ly + 2, fontSize * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5. Authentic paint drips hanging underneath
  ctx.fillStyle = toHex(accentColor);
  const dripXs = [cx - totalW * 0.36, cx - totalW * 0.12, cx + totalW * 0.15, cx + totalW * 0.38];
  const dripLengths = [fontSize * 0.35, fontSize * 0.48, fontSize * 0.28, fontSize * 0.42];

  for (let i = 0; i < dripXs.length; i++) {
    const dx = dripXs[i];
    const len = dripLengths[i];
    if (dx === undefined || len === undefined) continue;
    const dy = cy + fontSize * 0.3;
    ctx.beginPath();
    ctx.moveTo(dx - 3, dy);
    ctx.lineTo(dx - 2, dy + len);
    ctx.arc(dx, dy + len, 4.5, 0, Math.PI);
    ctx.lineTo(dx + 3, dy);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dx, dy + len + 8, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 2. Rally Car (Back Trunk / Lower Hatch)
 * Japanese / Street-Racer chisel-tip drift calligraphy tag.
 * Fast, forward-slanted aerodynamic letters with razor-sharp terminal points,
 * speed cuts, neon rim glow, and a lightning underline flourish.
 */
export function drawDriftTagGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0xff4444
): void {
  ctx.save();
  const text = 'TOWN';

  ctx.translate(w / 2, h / 2);
  ctx.transform(1, 0, -0.3, 1, 0, 0); // ~17 degree forward aerodynamic slant

  const fontSize = Math.floor(h * 0.52);
  ctx.font = `italic 900 ${fontSize}px "Impact", "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 1. Neon Aura / Rim Glow
  ctx.shadowColor = toHex(accentColor);
  ctx.shadowBlur = 18;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.strokeText(text, 0, -4);
  ctx.shadowBlur = 0;

  // 2. High-contrast sharp black drop-shadow
  ctx.fillStyle = '#050508';
  ctx.strokeStyle = '#050508';
  ctx.lineWidth = 12;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 3;
  ctx.strokeText(text, 8, 8);
  ctx.fillText(text, 8, 8);

  // 3. Electric Fire Gradient Fill (Crimson to Electric Yellow-White)
  const grad = ctx.createLinearGradient(0, -fontSize / 2, 0, fontSize / 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.25, '#ffdd44');
  grad.addColorStop(0.65, toHex(accentColor));
  grad.addColorStop(1, '#660011');
  ctx.fillStyle = grad;
  ctx.fillText(text, 0, -4);

  // 4. Razor-sharp horizontal speed cut through the center
  ctx.fillStyle = '#050508';
  ctx.fillRect(-w * 0.4, -2, w * 0.8, 3);

  // 5. High-speed underline arrow flourish
  const arrowY = fontSize * 0.42;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-w * 0.36, arrowY - 2);
  ctx.lineTo(w * 0.32, arrowY - 2);
  ctx.lineTo(w * 0.38, arrowY + 1);
  ctx.lineTo(w * 0.30, arrowY + 6);
  ctx.lineTo(-w * 0.28, arrowY + 4);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * 3. Trophy Truck (Back Tailgate)
 * Desert Wasteland Military Spray Stencil.
 * High-impact industrial block stencil with authentic bridge cutouts,
 * fuzzy overspray mist, and distressed fleck splatter.
 */
export function drawMilitaryStencilGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0x33cc66
): void {
  ctx.save();
  const cx = w / 2;
  const cy = h / 2;

  // Stencil bounding bracket [ TOWN ]
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 3;
  const bw = w * 0.88;
  const bh = h * 0.68;
  const bx = cx - bw / 2;
  const by = cy - bh / 2;

  const clen = 16;
  ctx.beginPath();
  ctx.moveTo(bx, by + clen); ctx.lineTo(bx, by); ctx.lineTo(bx + clen, by);
  ctx.moveTo(bx + bw - clen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + clen);
  ctx.moveTo(bx, by + bh - clen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + clen, by + bh);
  ctx.moveTo(bx + bw - clen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - clen);
  ctx.stroke();

  // 1. Soft overspray haze
  const fontSize = Math.floor(h * 0.46);
  ctx.font = `900 ${fontSize}px "Courier New", "Impact", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = 'T O W N';

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 10;
  ctx.fillText(text, cx + 3, cy + 3);
  ctx.shadowBlur = 0;

  // 2. High-vis stencil body (Distressed bone-white)
  ctx.fillStyle = '#f8f4e6';
  ctx.fillText(text, cx, cy);

  // 3. Stencil Bridge Cuts
  ctx.fillStyle = '#1c1f1e';
  ctx.fillRect(cx - bw * 0.42, cy - 2, bw * 0.84, 4);
  for (const sx of [-bw * 0.28, -bw * 0.09, bw * 0.1, bw * 0.3]) {
    ctx.fillRect(cx + sx - 2, cy - fontSize * 0.3, 4, fontSize * 0.6);
  }

  // 4. Distressed speckle splatter
  ctx.fillStyle = toHex(accentColor);
  for (let i = 0; i < 45; i++) {
    const px = bx + ((i * 73) % bw);
    const py = by + ((i * 109) % bh);
    const rad = 1 + (i % 3);
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 4. Monster Truck (Top Roof / Cab)
 * Heavy-Metal Chrome Wildstyle Graffiti.
 * Beveled wildstyle lettering with horizon-split liquid chrome reflection,
 * sharp spikes, and magenta flame flourishes.
 */
export function drawChromeWildstyleGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0xaa55ff
): void {
  ctx.save();
  const text = 'TOWN';
  const cx = w / 2;
  const cy = h / 2;

  const fontSize = Math.floor(h * 0.54);
  ctx.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 1. Hot magenta/purple airbrush flame glow
  ctx.shadowColor = toHex(accentColor);
  ctx.shadowBlur = 24;
  ctx.strokeStyle = '#ff0077';
  ctx.lineWidth = 14;
  ctx.strokeText(text, cx, cy);
  ctx.shadowBlur = 0;

  // 2. Heavy dark rim
  ctx.strokeStyle = '#120520';
  ctx.lineWidth = 10;
  ctx.strokeText(text, cx, cy);

  // 3. Horizon-Split Liquid Chrome Gradient Fill
  const chromeGrad = ctx.createLinearGradient(0, cy - fontSize * 0.5, 0, cy + fontSize * 0.5);
  chromeGrad.addColorStop(0, '#102040');
  chromeGrad.addColorStop(0.48, '#aeeeff');
  chromeGrad.addColorStop(0.50, '#ffffff'); // bright horizon flash
  chromeGrad.addColorStop(0.52, '#d47718');
  chromeGrad.addColorStop(0.82, '#502008');
  chromeGrad.addColorStop(1, '#ff88ff');
  ctx.fillStyle = chromeGrad;
  ctx.fillText(text, cx, cy);

  // 4. Chrome star glint sparkles
  ctx.fillStyle = '#ffffff';
  for (const [gx, gy] of [
    [cx - w * 0.32, cy - fontSize * 0.24],
    [cx - w * 0.05, cy - fontSize * 0.28],
    [cx + w * 0.18, cy + fontSize * 0.15],
    [cx + w * 0.34, cy - fontSize * 0.18]
  ] as const) {
    ctx.beginPath();
    ctx.arc(gx, gy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(gx - 7, gy - 0.75, 14, 1.5);
    ctx.fillRect(gx - 0.75, gy - 7, 1.5, 14);
  }

  ctx.restore();
}

/**
 * 5. Dune Buggy (Front Sloped Hood / Nose)
 * Skate-Punk Fat-Cap Spray Drip Tag.
 * Raw, expressive hand-style street marker with sharp loops,
 * punk star accents, and authentic dripping paint trails.
 */
export function drawPunkDripTagGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0xffcc33
): void {
  ctx.save();
  const text = 'TOWN';
  const cx = w / 2;
  const cy = h / 2 - 6;

  const fontSize = Math.floor(h * 0.5);
  ctx.font = `italic 900 ${fontSize}px "Impact", "Arial Black", cursive, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 1. Raw pitch-black shadow offset
  ctx.fillStyle = '#0a0a0c';
  ctx.strokeStyle = '#0a0a0c';
  ctx.lineWidth = 10;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, cx + 5, cy + 6);
  ctx.fillText(text, cx + 5, cy + 6);

  // 2. Radioactive Acid Neon Fill (Toxic lime to hot sun yellow)
  const grad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
  grad.addColorStop(0, '#c6ff00');
  grad.addColorStop(0.5, toHex(accentColor));
  grad.addColorStop(1, '#ff9100');
  ctx.fillStyle = grad;
  ctx.fillText(text, cx, cy);

  // 3. Punk Halo / Crown flourish over the word
  ctx.strokeStyle = '#c6ff00';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy - fontSize * 0.44, w * 0.22, 6, -0.05, 0, Math.PI * 2);
  ctx.stroke();

  // 4. Dripping paint streaks
  ctx.fillStyle = '#c6ff00';
  const drips = [
    { x: cx - w * 0.32, l: h * 0.35, r: 3 },
    { x: cx - w * 0.12, l: h * 0.46, r: 3.5 },
    { x: cx + w * 0.08, l: h * 0.3, r: 2.5 },
    { x: cx + w * 0.28, l: h * 0.42, r: 3.2 }
  ];
  for (const d of drips) {
    const dy = cy + fontSize * 0.28;
    ctx.beginPath();
    ctx.moveTo(d.x - 1.5, dy);
    ctx.lineTo(d.x - 1, dy + d.l);
    ctx.arc(d.x, dy + d.l, d.r, 0, Math.PI);
    ctx.lineTo(d.x + 1.5, dy);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(d.x, dy + d.l + 8, d.r * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 6. Urban Blockbuster 3D (Rally Car / SUV Roofs)
 * Giant architectural high-contrast block letters with deep 3D bevel extrusion.
 */
export function drawBlockbusterGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0xffffff
): void {
  ctx.save();
  const text = 'T O W N';
  const cx = w / 2;
  const cy = h / 2;
  const fontSize = Math.floor(h * 0.52);

  ctx.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Deep 3D perspective block drop
  ctx.fillStyle = '#101015';
  for (let i = 18; i >= 2; i -= 2) {
    ctx.fillText(text, cx - i * 0.6, cy + i);
  }

  // Heavy outer border
  ctx.strokeStyle = '#050508';
  ctx.lineWidth = 14;
  ctx.strokeText(text, cx, cy);

  // Two-tone architectural fill
  const blockGrad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
  blockGrad.addColorStop(0, '#ffffff');
  blockGrad.addColorStop(0.4, toHex(accentColor));
  blockGrad.addColorStop(1, '#ff3300');
  ctx.fillStyle = blockGrad;
  ctx.fillText(text, cx, cy);

  // Inner beveled highlight line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 3;
  ctx.strokeText(text, cx, cy);

  ctx.restore();
}

/**
 * 7. Krink Mop Squeezer Drip Tag (Dune Buggy Tub / Side Panels)
 * Wet, juicy bleeding street mop marker with heavy pooling drips.
 */
export function drawMopDripGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0x00ffff
): void {
  ctx.save();
  const text = 'TOWN';
  const cx = w / 2;
  const cy = h / 2 - 8;
  const fontSize = Math.floor(h * 0.48);

  ctx.font = `italic 900 ${fontSize}px "Trebuchet MS", "Impact", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Deep ink bleed shadow
  ctx.shadowColor = toHex(accentColor);
  ctx.shadowBlur = 12;
  ctx.fillStyle = toHex(accentColor);
  ctx.fillText(text, cx, cy);
  ctx.shadowBlur = 0;

  // Solid wet ink core
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, cx - 1, cy - 1);

  // Heavy dripping ink pools
  ctx.fillStyle = toHex(accentColor);
  for (const [xFrac, len, r] of [
    [-0.32, h * 0.42, 4],
    [-0.10, h * 0.55, 5],
    [0.12, h * 0.38, 3.5],
    [0.34, h * 0.50, 4.5]
  ] as const) {
    const dx = cx + w * xFrac;
    const dy = cy + fontSize * 0.28;
    ctx.beginPath();
    ctx.moveTo(dx - 2, dy);
    ctx.lineTo(dx - 1, dy + len);
    ctx.arc(dx, dy + len, r, 0, Math.PI);
    ctx.lineTo(dx + 2, dy);
    ctx.closePath();
    ctx.fill();

    // Round drip bead
    ctx.beginPath();
    ctx.arc(dx, dy + len + 10, r * 0.75, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 8. Melting Acid Psychedelic (Monster Truck / SUV Body Sides)
 * Wavy liquid lettering with melting ripples and fiery psychedelic gradient.
 */
export function drawAcidPsychedelicGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0xff00ff
): void {
  ctx.save();
  const text = 'TOWN';
  const cx = w / 2;
  const cy = h / 2;
  const fontSize = Math.floor(h * 0.52);

  // Wavy distortion
  ctx.translate(cx, cy);
  ctx.rotate(-0.06);

  ctx.font = `900 ${fontSize}px "Cooper Black", "Arial Black", cursive, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Melting liquid flame aura
  ctx.shadowColor = '#ffff00';
  ctx.shadowBlur = 16;
  ctx.strokeStyle = '#200030';
  ctx.lineWidth = 14;
  ctx.strokeText(text, 0, 0);
  ctx.shadowBlur = 0;

  // Psychedelic melting gradient
  const acidGrad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  acidGrad.addColorStop(0, '#ff0055');
  acidGrad.addColorStop(0.3, toHex(accentColor));
  acidGrad.addColorStop(0.7, '#00ffcc');
  acidGrad.addColorStop(1, '#ffee00');
  ctx.fillStyle = acidGrad;
  ctx.fillText(text, 0, 0);

  // Liquid melting ripple drips along bottom curves
  ctx.fillStyle = '#ffee00';
  for (const [ox, oy, rad] of [[-w * 0.28, fontSize * 0.32, 5], [-w * 0.05, fontSize * 0.36, 6], [w * 0.2, fontSize * 0.34, 5]] as const) {
    ctx.beginPath();
    ctx.arc(ox, oy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * 9. Cyberpunk Neon Drift Tag (Rally Car / Doors / Spoilers)
 * Geometric sharp angular strokes with neon cyan & hot magenta chromatic split.
 */
export function drawCyberpunkNeonTag(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  accentColor = 0x00f0ff
): void {
  ctx.save();
  const text = 'TOWN';
  const cx = w / 2;
  const cy = h / 2;
  const fontSize = Math.floor(h * 0.48);

  ctx.font = `italic 900 ${fontSize}px "Courier New", "Impact", monospace, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Chromatic aberration split (Red/Magenta shifted left)
  ctx.fillStyle = 'rgba(255, 0, 90, 0.85)';
  ctx.fillText(text, cx - 4, cy - 2);

  // Chromatic aberration split (Cyan/Blue shifted right)
  ctx.fillStyle = 'rgba(0, 240, 255, 0.85)';
  ctx.fillText(text, cx + 4, cy + 2);

  // High-voltage bright white core
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = toHex(accentColor);
  ctx.shadowBlur = 14;
  ctx.fillText(text, cx, cy);
  ctx.shadowBlur = 0;

  // Digital circuit framing line and tick marks
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.38, cy + fontSize * 0.4);
  ctx.lineTo(cx + w * 0.38, cy + fontSize * 0.4);
  ctx.lineTo(cx + w * 0.42, cy + fontSize * 0.25);
  ctx.stroke();

  // Mini digital barcode
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 14; i++) {
    const bx = cx - w * 0.35 + i * 8;
    ctx.fillRect(bx, cy + fontSize * 0.45, i % 3 === 0 ? 3 : 1.5, 8);
  }

  ctx.restore();
}

/**
 * 10. Street "HELLO" Sticker Slap (SUV Quarter Panel / Trophy Truck Bedsides)
 * Authentic Priority / Name Badge adhesive decal with weathered paper & hand-scrawled marker.
 */
export function drawStickerSlapGraffiti(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): void {
  ctx.save();
  const cx = w / 2;
  const cy = h / 2;

  // Authentic slight tilted decal angle (~8 degrees)
  ctx.translate(cx, cy);
  ctx.rotate(0.12);

  const sw = w * 0.82;
  const sh = h * 0.76;
  const sx = -sw / 2;
  const sy = -sh / 2;

  // Drop shadow behind the sticker paper
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(sx + 5, sy + 5, sw, sh);

  // White sticker backing
  ctx.fillStyle = '#f8f8f2';
  ctx.fillRect(sx, sy, sw, sh);

  // Red / Blue header bar
  ctx.fillStyle = '#d32f2f';
  ctx.fillRect(sx, sy, sw, sh * 0.26);

  // Header text: "HELLO"
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 ${Math.floor(sh * 0.16)}px "Arial Black", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('HELLO', 0, sy + sh * 0.13);

  // Hand-scrawled fat black ink marker: "TOWN"
  ctx.fillStyle = '#0a0a0c';
  ctx.font = `italic 900 ${Math.floor(sh * 0.46)}px "Impact", cursive, sans-serif`;
  ctx.fillText('TOWN', 0, sy + sh * 0.62);

  // Marker underline swoop
  ctx.strokeStyle = '#0a0a0c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-sw * 0.32, sy + sh * 0.84);
  ctx.quadraticCurveTo(0, sy + sh * 0.90, sw * 0.32, sy + sh * 0.82);
  ctx.stroke();

  ctx.restore();
}
