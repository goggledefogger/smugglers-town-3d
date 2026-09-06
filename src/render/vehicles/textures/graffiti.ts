/**
/**
 * Procedural 2D canvas graffiti artists for the word "TOWN".
 * Each vehicle archetype receives a distinct visual culture and graffiti style:
 * 1. SUV: Subway Bubble Throw-Up ("Throwie") with fat 3D drops and highlights
 * 2. Rally Car: Speed Drift Chisel Tag with forward aerodynamic slant and arrow flourish
 * 3. Trophy Truck: Desert Wasteland Military Spray Stencil with bridge cuts and splatter
 * 4. Monster Truck: Heavy-Metal Chrome Wildstyle with horizon reflection and flame licks
 * 5. Dune Buggy: Skate-Punk Fat-Cap Marker Tag with long drippy paint runs
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
  // Highlights along tops of each letter
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

    // Secondary micro gleam
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

    // Detached paint droplet below
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

  // Aerodynamic forward skew and speed tilt
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
  ctx.shadowBlur = 0; // reset shadow

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

  // Corner brackets
  const clen = 16;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(bx, by + clen); ctx.lineTo(bx, by); ctx.lineTo(bx + clen, by);
  // Top-right
  ctx.moveTo(bx + bw - clen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + clen);
  // Bottom-left
  ctx.moveTo(bx, by + bh - clen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + clen, by + bh);
  // Bottom-right
  ctx.moveTo(bx + bw - clen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - clen);
  ctx.stroke();

  // 1. Soft overspray haze under the spray paint
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

  // 2. High-vis stencil body (Distressed bone-white / military hazard yellow)
  ctx.fillStyle = '#f8f4e6';
  ctx.fillText(text, cx, cy);

  // 3. Stencil Bridge Cuts (masking horizontal/vertical slits through the letters)
  // Cuts through the middle of the characters to simulate physical spray bridges
  ctx.fillStyle = '#1c1f1e'; // match tailgate dark panel tone
  ctx.fillRect(cx - bw * 0.42, cy - 2, bw * 0.84, 4); // horizontal bridge line
  for (const sx of [-bw * 0.28, -bw * 0.09, bw * 0.1, bw * 0.3]) {
    ctx.fillRect(cx + sx - 2, cy - fontSize * 0.3, 4, fontSize * 0.6);
  }

  // 4. Distressed speckle splatter across the stencil
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
  // Top half: Deep blue to pale sky blue; Bottom half: Golden desert to deep bronze
  const chromeGrad = ctx.createLinearGradient(0, cy - fontSize * 0.5, 0, cy + fontSize * 0.5);
  chromeGrad.addColorStop(0, '#102040');
  chromeGrad.addColorStop(0.48, '#aeeeff');
  chromeGrad.addColorStop(0.50, '#ffffff'); // bright horizon flash line
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
    // 4-point flare
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

  // 4. Dripping paint streaks running down the dipped nose
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

    // Secondary droplet
    ctx.beginPath();
    ctx.arc(d.x, dy + d.l + 8, d.r * 0.65, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
