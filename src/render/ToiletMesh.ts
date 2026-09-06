/**
 * Procedural 3D Smoking Golden Toilet asset for contraband pickups.
 * Built from Three.js primitives:
 * - 24K polished gold pedestal, flared bowl, seat ring, lid, and cistern tank
 * - Chrome flush lever
 * - Burning fire core inside the bowl cavity with flickering firelight
 * - Heavy upward billowing smoke plume that soars 35-50 meters into the sky
 * - Integrated towering sky beacon beam
 */
import {
  Group, Mesh, CylinderGeometry, BoxGeometry, TorusGeometry, CircleGeometry,
  PlaneGeometry, MeshStandardMaterial, MeshBasicMaterial, PointLight,
  CanvasTexture, DoubleSide, NormalBlending, AdditiveBlending,
  type Camera, type Material
} from 'three';

/** Generates a procedural radial soft-smoke alpha texture with turbulent density. */
function createSmokeTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;

  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.35, 'rgba(230,230,230,0.5)');
  grad.addColorStop(0.7, 'rgba(180,180,180,0.18)');
  grad.addColorStop(1, 'rgba(100,100,100,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  // Layer subtle fractal noise puffs
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < 20; i++) {
    const x = 32 + Math.random() * 64;
    const y = 32 + Math.random() * 64;
    const r = 12 + Math.random() * 24;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new CanvasTexture(c);
  texture.needsUpdate = true;
  return texture;
}

interface SmokePuff {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly baseSize: number;
  readonly speed: number;
  readonly swirlPhase: number;
  readonly swirlRadius: number;
  progress: number;
}

export class SmokingToilet {
  readonly group = new Group();
  readonly model = new Group();
  readonly beacon: Mesh;

  private readonly fireLight: PointLight;
  private readonly goldLight: PointLight;
  private readonly smokeGroup = new Group();
  private readonly smokeParticles: SmokePuff[] = [];
  private readonly smokeTexture: CanvasTexture;
  private readonly planeGeom: PlaneGeometry;

  constructor(beaconFadeTexture: CanvasTexture) {
    this.smokeTexture = createSmokeTexture();
    this.planeGeom = new PlaneGeometry(1, 1);

    // --- MATERIALS ---
    const goldMat = new MeshStandardMaterial({
      color: 0xf5c024,
      metalness: 0.88,
      roughness: 0.24,
      emissive: 0x4a3200,
      emissiveIntensity: 0.15
    });

    const goldAccent = new MeshStandardMaterial({
      color: 0xffd952,
      metalness: 0.94,
      roughness: 0.16
    });

    const chromeMat = new MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.95,
      roughness: 0.1
    });

    const cavityMat = new MeshStandardMaterial({
      color: 0x241208,
      roughness: 0.85,
      emissive: 0xff3b00,
      emissiveIntensity: 0.7
    });

    const fireDiscMat = new MeshBasicMaterial({
      color: 0xff5500
    });

    // --- 3D GOLDEN TOILET GEOMETRY ---
    // 1. Pedestal / Foot Base (chamfered oval base)
    const baseFoot = new Mesh(new CylinderGeometry(0.55, 0.65, 0.22, 24), goldMat);
    baseFoot.position.y = 0.11;
    baseFoot.scale.set(0.85, 1, 1.25);
    this.model.add(baseFoot);

    // 2. Pedestal Neck
    const neck = new Mesh(new CylinderGeometry(0.42, 0.48, 0.55, 24), goldMat);
    neck.position.set(0, 0.42, 0.05);
    neck.scale.set(0.8, 1, 1.15);
    this.model.add(neck);

    // 3. Toilet Bowl (flared outer bowl)
    const bowlOuter = new Mesh(new CylinderGeometry(0.68, 0.42, 0.55, 28), goldMat);
    bowlOuter.position.set(0, 0.88, 0.15);
    bowlOuter.scale.set(0.88, 1, 1.25);
    this.model.add(bowlOuter);

    // 4. Inner Bowl Cavity (dark fiery depth)
    const cavity = new Mesh(new CylinderGeometry(0.48, 0.2, 0.45, 24), cavityMat);
    cavity.position.set(0, 0.95, 0.2);
    cavity.scale.set(0.82, 1, 1.15);
    this.model.add(cavity);

    // 5. Fire / Embers Disc in bowl
    const fireDisc = new Mesh(new CircleGeometry(0.35, 24), fireDiscMat);
    fireDisc.rotation.x = -Math.PI / 2;
    fireDisc.position.set(0, 0.82, 0.2);
    this.model.add(fireDisc);

    // 6. Toilet Seat Ring (raised open ring)
    const seat = new Mesh(new TorusGeometry(0.48, 0.07, 16, 32), goldAccent);
    seat.rotation.x = Math.PI / 2;
    seat.position.set(0, 1.16, 0.18);
    seat.scale.set(0.88, 1.2, 1);
    this.model.add(seat);

    // 7. Toilet Cistern / Water Tank (at rear)
    const tank = new Mesh(new BoxGeometry(0.95, 0.95, 0.45), goldMat);
    tank.position.set(0, 1.35, -0.45);
    this.model.add(tank);

    // 8. Tank Lid with slight bevel/lip
    const tankLid = new Mesh(new BoxGeometry(1.02, 0.12, 0.5), goldAccent);
    tankLid.position.set(0, 1.86, -0.45);
    this.model.add(tankLid);

    // 9. Chrome Flush Lever
    const handleArm = new Mesh(new CylinderGeometry(0.02, 0.02, 0.14, 12), chromeMat);
    handleArm.rotation.z = Math.PI / 2;
    handleArm.position.set(0.53, 1.72, -0.42);
    this.model.add(handleArm);

    const handleTip = new Mesh(new BoxGeometry(0.04, 0.1, 0.04), chromeMat);
    handleTip.position.set(0.6, 1.7, -0.42);
    this.model.add(handleTip);

    // 10. Toilet Lid (propped open against tank)
    const lid = new Mesh(new BoxGeometry(0.82, 0.95, 0.06), goldAccent);
    lid.position.set(0, 1.5, -0.2);
    lid.rotation.x = -0.12;
    this.model.add(lid);

    // 11. Fiery Glow Point Light inside the bowl
    this.fireLight = new PointLight(0xff5500, 3.5, 9, 1.8);
    this.fireLight.position.set(0, 1.2, 0.2);
    this.model.add(this.fireLight);

    // 12. Golden Amber Light for ground / bed illumination
    this.goldLight = new PointLight(0xffbb22, 2.2, 35, 1.5);
    this.goldLight.position.set(0, 1.8, 0);
    this.model.add(this.goldLight);

    // 13. Sky Beacon Column
    const beaconMat = new MeshBasicMaterial({
      color: 0xffb830,
      transparent: true,
      opacity: 0.4,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      map: beaconFadeTexture
    });
    this.beacon = new Mesh(new CylinderGeometry(0.45, 0.9, 55, 24, 1, true), beaconMat);
    this.beacon.position.set(0, 27.5, -0.45);
    this.beacon.renderOrder = 0;

    // --- HEAVY SMOKE PLUME PARTICLES ---
    const smokeCount = 48;
    for (let i = 0; i < smokeCount; i++) {
      const progress = i / smokeCount;
      const baseSize = 0.7 + Math.random() * 0.4;
      const mat = new MeshBasicMaterial({
        map: this.smokeTexture,
        transparent: true,
        depthWrite: false,
        blending: NormalBlending,
        side: DoubleSide
      });
      mat.color.setHex(0xff4500);
      mat.opacity = 0.8;

      const puff = new Mesh(this.planeGeom, mat);
      puff.renderOrder = 10;

      const puffData: SmokePuff = {
        mesh: puff,
        baseSize,
        speed: 0.11 + Math.random() * 0.05,
        swirlPhase: i * 2.39996 + Math.random() * 0.5,
        swirlRadius: 1.8 + Math.random() * 1.2,
        progress
      };

      this.smokeParticles.push(puffData);
      this.smokeGroup.add(puff);
    }

    this.model.add(this.smokeGroup);
    this.group.add(this.model, this.beacon);
  }

  /** Advance smoke plume simulation and fire flicker each frame. */
  update(dt: number, timeS: number, camera?: Camera | null, carried = false): void {
    // 1. Animated fire flicker
    this.fireLight.intensity = 3.2 + Math.sin(timeS * 14.5) * 0.6 + Math.cos(timeS * 22.3) * 0.4;

    // 2. Camera billboard orientation for smoke puffs
    const camQuat = camera ? camera.quaternion : null;

    // 3. Update each smoke particle
    for (let i = 0; i < this.smokeParticles.length; i++) {
      const p = this.smokeParticles[i]!;
      p.progress = (p.progress + dt * p.speed) % 1;

      const progress = p.progress;
      // Vertical trajectory: rises from bowl (y=1.1) to ~38m sky height
      const y = 1.1 + Math.pow(progress, 0.85) * (carried ? 22 : 38);
      const spread = Math.pow(progress, 0.75) * p.swirlRadius;
      const angle = p.swirlPhase + timeS * (carried ? 1.2 : 0.6);

      // Trailing plume if vehicle is moving, otherwise natural swirl
      const x = Math.cos(angle) * spread * 0.55;
      const z = Math.sin(angle) * spread * 0.55 + 0.2 + (carried ? progress * 1.5 : 0);

      p.mesh.position.set(x, y, z);

      // Expanding cloud scale as it rises
      const scale = p.baseSize * (1 + progress * (carried ? 3.5 : 5.0));
      p.mesh.scale.set(scale, scale, 1);

      if (camQuat) {
        p.mesh.quaternion.copy(camQuat);
      } else {
        p.mesh.rotation.z += dt * 0.5;
      }

      // Color and opacity progression
      const mat = p.mesh.material as MeshBasicMaterial;
      if (progress < 0.12) {
        // Fiery flame burst at the bowl rim
        mat.color.setHex(0xff4500);
        mat.opacity = 0.85;
      } else if (progress < 0.25) {
        // Blazing ember glow transitioning to soot
        mat.color.setHex(0xd04810);
        mat.opacity = 0.78;
      } else if (progress < 0.5) {
        // Dense dark charcoal soot billows
        mat.color.setHex(0x1a1614);
        mat.opacity = 0.82;
      } else if (progress < 0.8) {
        // Voluminous billowing smoke clouds
        const grey = 0.22 + (progress - 0.5) * 0.3;
        mat.color.setRGB(grey, grey * 0.95, grey * 0.9);
        mat.opacity = 0.65;
      } else {
        // High-altitude atmospheric haze dissipation
        const fade = (progress - 0.8) / 0.2;
        mat.color.setHex(0x555048);
        mat.opacity = Math.max(0, (1 - fade) * 0.5);
      }
    }
  }

  dispose(): void {
    this.group.traverse(obj => {
      const m = obj as Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        if (Array.isArray(m.material)) {
          for (const mat of m.material) (mat as Material).dispose();
        } else {
          (m.material as Material).dispose();
        }
      }
    });
    this.planeGeom.dispose();
    this.smokeTexture.dispose();
  }
}
