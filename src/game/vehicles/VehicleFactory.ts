import * as THREE from 'three';
import { Vehicle, VEHICLE_SPECS, vehicleClassOf, type VehicleId } from './Vehicle';
import type { TransmissionMode } from './Transmission';

const PAINT = 0xb71c1c;
const PAINT_DARK = 0x7f1212;
const CLADDING = 0x1c1c1e;
const GLASS = 0x87c4de;
const RUBBER = 0x111113;
const RIM = 0xc5c8ce;
const LIGHT_ON = 0xfff4c8;
const TAIL = 0xc62828;

function std(color: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.42,
    roughness: 0.38,
    envMapIntensity: 1.1,
    ...extra,
  });
}

function glassMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: GLASS,
    metalness: 0.55,
    roughness: 0.08,
    transparent: true,
    opacity: 0.48,
    envMapIntensity: 1.4,
  });
}

/**
 * Side-profile extrude: shape X = forward (Z), shape Y = height.
 * Resulting mesh is Y-up, +Z forward, centered on X.
 */
function extrudeProfile(
  pts: Array<[number, number]>,
  width: number,
  bevel = 0.032,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.85,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 1,
  });
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

function addMesh(
  g: THREE.Group,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  cast = true,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function makeWheel(radius: number, width: number, steer: boolean): THREE.Group {
  const pivot = new THREE.Group();
  pivot.userData.wheelPivot = true;
  pivot.userData.frontSteer = steer;
  pivot.userData.wheelRadius = radius;

  const spin = new THREE.Group();
  spin.userData.spinMesh = true;
  pivot.add(spin);

  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 18),
    new THREE.MeshStandardMaterial({ color: RUBBER, roughness: 0.92, metalness: 0.05 }),
  );
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  spin.add(tire);

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.55, 16),
    new THREE.MeshStandardMaterial({ color: RIM, metalness: 0.82, roughness: 0.22, envMapIntensity: 1.3 }),
  );
  rim.rotation.z = Math.PI / 2;
  spin.add(rim);

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, width * 0.62, 10),
    new THREE.MeshStandardMaterial({ color: 0x888890, metalness: 0.75, roughness: 0.3 }),
  );
  hub.rotation.z = Math.PI / 2;
  spin.add(hub);

  const spokeMat = new THREE.MeshStandardMaterial({ color: 0xd0d2d6, metalness: 0.7, roughness: 0.28 });
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(width * 0.18, radius * 0.48, 0.04), spokeMat);
    spoke.rotation.z = Math.PI / 2;
    spoke.rotation.x = (i * Math.PI * 2) / 5;
    spin.add(spoke);
  }
  return pivot;
}

function fenderArch(g: THREE.Group, x: number, z: number, radius: number, bodyMat: THREE.Material): void {
  // Wide flare sitting over the tire — reads as a wheel arch, not a hoop.
  const flare = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, radius * 1.7), bodyMat);
  flare.position.set(x, radius + 0.14, z);
  flare.castShadow = true;
  g.add(flare);
  const well = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, radius * 1.15, radius * 1.55),
    new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.92 }),
  );
  well.position.set(x * 0.9, radius * 0.55, z);
  g.add(well);
}

/**
 * Mk4/Mk5-ish Golf hatchback: long hood, inset greenhouse, kicked C-pillar,
 * hatch glass, arches, clustered lights. Not a fridge.
 */
function buildGolf(): THREE.Group {
  const g = new THREE.Group();
  const body = std(PAINT);
  const bodyLow = std(PAINT_DARK, { roughness: 0.5, metalness: 0.28 });
  const dark = std(CLADDING, { metalness: 0.25, roughness: 0.62 });
  const glass = glassMat();
  const chrome = std(0xcfd4da, { metalness: 0.85, roughness: 0.18 });

  // Lower body (wider) — hood through rocker / tail
  const lower = extrudeProfile(
    [
      [2.06, 0.16],
      [2.12, 0.32],
      [2.10, 0.48],
      [1.98, 0.58],
      [1.15, 0.70],
      [0.66, 0.76],
      [-1.72, 0.71],
      [-1.98, 0.69],
      [-2.08, 0.54],
      [-2.12, 0.32],
      [-2.06, 0.16],
      [-1.42, 0.17],
      [1.42, 0.17],
    ],
    1.58,
    0.03,
  );
  addMesh(g, lower, body);

  // Greenhouse — narrower cabin + hatch (the silhouette that reads "Golf")
  const cabin = extrudeProfile(
    [
      [0.68, 0.76],
      [0.16, 1.36],
      [-0.18, 1.43],
      [-0.98, 1.445],
      [-1.26, 1.36],
      [-1.50, 1.16],
      [-1.86, 0.88],
      [-1.74, 0.73],
      [0.62, 0.76],
    ],
    1.46,
    0.028,
  );
  addMesh(g, cabin, body);

  // Hood plane — long nose reads hatch, not van
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.035, 1.18), body);
  hood.position.set(0, 0.69, 1.32);
  hood.rotation.x = 0.09;
  hood.castShadow = true;
  g.add(hood);

  // A-pillars
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.64, 0.52), dark);
    pillar.position.set(side * 0.71, 1.08, 0.40);
    pillar.rotation.x = -0.7;
    g.add(pillar);
  }

  // Hatch spoiler lip (C-pillar kick)
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.045, 0.2), body);
  spoiler.position.set(0, 1.40, -1.30);
  spoiler.castShadow = true;
  g.add(spoiler);

  // Belt / cladding stripe
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.14, 3.55), bodyLow);
  skirt.position.set(0, 0.24, 0.02);
  skirt.castShadow = true;
  g.add(skirt);

  // Windshield (raked)
  const wind = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.78), glass);
  wind.position.set(0, 1.06, 0.40);
  wind.rotation.x = -0.72;
  g.add(wind);

  // Rear hatch glass
  const rearG = new THREE.Mesh(new THREE.PlaneGeometry(1.28, 0.62), glass);
  rearG.position.set(0, 1.05, -1.66);
  rearG.rotation.x = 0.55;
  rearG.rotation.y = Math.PI;
  g.add(rearG);

  // Side glass (front door + rear quarter)
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.42), glass);
    door.position.set(side * 0.74, 1.08, 0.02);
    door.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(door);
    const qtr = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.38), glass);
    qtr.position.set(side * 0.74, 1.08, -0.82);
    qtr.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(qtr);
  }

  // Roof black print (Golf-ish)
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.03, 1.18), dark);
  roof.position.set(0, 1.445, -0.55);
  g.add(roof);

  // Front bumper + grille
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.22, 0.22), dark);
  bumperF.position.set(0, 0.30, 2.10);
  bumperF.castShadow = true;
  g.add(bumperF);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.16, 0.06), dark);
  grille.position.set(0, 0.54, 2.06);
  g.add(grille);
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.07, 14), chrome);
  badge.position.set(0, 0.62, 2.08);
  g.add(badge);
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.1, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xf0f0e8, roughness: 0.6 }),
  );
  plate.position.set(0, 0.28, 2.20);
  g.add(plate);

  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.2, 0.18), dark);
  bumperR.position.set(0, 0.28, -2.10);
  g.add(bumperR);

  // Headlights — swept clusters
  const hlMat = new THREE.MeshStandardMaterial({
    color: LIGHT_ON,
    emissive: 0xffe7a8,
    emissiveIntensity: 0.55,
    metalness: 0.4,
    roughness: 0.15,
  });
  const hlL = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.15, 0.08), hlMat);
  hlL.position.set(-0.58, 0.56, 2.04);
  hlL.rotation.y = 0.18;
  hlL.userData.headlight = true;
  g.add(hlL);
  const hlR = hlL.clone();
  hlR.position.x = 0.58;
  hlR.rotation.y = -0.18;
  hlR.userData.headlight = true;
  g.add(hlR);

  // Fog lamps
  const fog = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.05), hlMat);
  fog.position.set(-0.62, 0.34, 2.12);
  fog.userData.headlight = true;
  g.add(fog);
  const fogR = fog.clone();
  fogR.position.x = 0.62;
  fogR.userData.headlight = true;
  g.add(fogR);

  // Taillights — vertical hatch clusters
  const tlMat = new THREE.MeshStandardMaterial({
    color: TAIL,
    emissive: 0xff2208,
    emissiveIntensity: 0.45,
    roughness: 0.25,
  });
  const tl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.28, 0.06), tlMat);
  tl.position.set(-0.62, 0.78, -2.06);
  g.add(tl);
  const tlR = tl.clone();
  tlR.position.x = 0.62;
  g.add(tlR);

  // Mirrors
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.06), dark);
    arm.position.set(side * 0.82, 0.92, 0.55);
    g.add(arm);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.18), body);
    cap.position.set(side * 0.94, 0.92, 0.52);
    g.add(cap);
  }

  // Headlight spots (night)
  for (const sx of [-0.5, 0.5]) {
    const spot = new THREE.SpotLight(0xfff1c4, 0, 38, Math.PI / 7.5, 0.48, 1.15);
    spot.position.set(sx, 0.58, 2.05);
    const tgt = new THREE.Object3D();
    tgt.position.set(sx * 0.15, 0.25, 14);
    g.add(tgt);
    spot.target = tgt;
    spot.userData.headSpot = true;
    g.add(spot);
  }

  const wr = 0.315;
  const ww = 0.2;
  const track = 0.88;
  const zb = 1.26;
  const wheels: Array<[number, number, number, boolean]> = [
    [-track, wr, zb, true],
    [track, wr, zb, true],
    [-track, wr, -zb, false],
    [track, wr, -zb, false],
  ];
  for (const [x, y, z, steer] of wheels) {
    const w = makeWheel(wr, ww, steer);
    w.position.set(x, y, z);
    g.add(w);
    fenderArch(g, x, z, wr, body);
  }

  return g;
}

/**
 * New Flyer–style 40' transit: raked windshield, destination sign, beltline,
 * window bays, wheel wells — not a refrigerator.
 */
function buildNewFlyerBus(hybrid: boolean): THREE.Group {
  const g = new THREE.Group();
  const body = std(0xf3f5f7, { metalness: 0.22, roughness: 0.48 });
  const blue = std(0x1a4780, { metalness: 0.18, roughness: 0.5 });
  const green = std(hybrid ? 0x2a8a55 : 0x348a46, { metalness: 0.15, roughness: 0.55 });
  const dark = std(0x16181c, { metalness: 0.2, roughness: 0.7 });
  const glass = glassMat();
  glass.opacity = 0.55;

  const hull = extrudeProfile(
    [
      [6.05, 0.18],
      [6.16, 0.42],
      [6.10, 0.92],
      [5.86, 2.52],
      [5.62, 2.98],
      [-5.55, 3.02],
      [-5.88, 2.86],
      [-6.08, 1.15],
      [-6.14, 0.42],
      [-6.04, 0.18],
    ],
    2.48,
    0.04,
  );
  addMesh(g, hull, body);

  // Blue belt + green pinstripe (GRT-ish, no logo)
  const belt = new THREE.Mesh(new THREE.BoxGeometry(2.52, 0.38, 12.05), blue);
  belt.position.set(0, 0.98, 0);
  g.add(belt);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.53, 0.08, 12.08), green);
  stripe.position.set(0, 1.20, 0);
  g.add(stripe);

  // Black window band
  const band = new THREE.Mesh(new THREE.BoxGeometry(2.50, 1.05, 10.4), dark);
  band.position.set(0, 2.05, -0.15);
  g.add(band);

  // Windshield (large, raked)
  const wind = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.55), glass);
  wind.position.set(0, 1.78, 5.92);
  wind.rotation.x = -0.18;
  g.add(wind);

  // Destination sign
  const dest = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.32, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0a0c10, emissive: 0x1a3344, emissiveIntensity: 0.55 }),
  );
  dest.position.set(0, 2.78, 5.78);
  g.add(dest);

  // Side windows
  for (let i = 0; i < 6; i++) {
    const z = 4.35 - i * 1.62;
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(1.38, 0.88), glass);
      w.position.set(side * 1.255, 2.08, z);
      w.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      g.add(w);
    }
  }

  // Front door (curb)
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.85), glass);
  door.position.set(-1.255, 1.35, 4.35);
  door.rotation.y = -Math.PI / 2;
  g.add(door);

  // Rear window + engine door
  const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.7), glass);
  rearWin.position.set(0, 2.15, -6.05);
  rearWin.rotation.y = Math.PI;
  g.add(rearWin);
  const engineDoor = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.15, 0.08), dark);
  engineDoor.position.set(0, 0.85, -6.10);
  g.add(engineDoor);

  // Roof HVAC
  const hvac = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.28, 3.4), dark);
  hvac.position.set(0, 3.18, 0.4);
  g.add(hvac);
  if (hybrid) {
    const pack = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 0.38, 3.0),
      new THREE.MeshStandardMaterial({ color: 0x243028, metalness: 0.45, roughness: 0.4 }),
    );
    pack.position.set(0, 3.28, -1.8);
    g.add(pack);
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.04), green);
    badge.position.set(0.85, 1.55, 6.14);
    g.add(badge);
  } else {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.05, 8), dark);
    stack.position.set(1.05, 3.35, -5.15);
    g.add(stack);
  }

  // Bumper + headlights
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.32, 0.28), dark);
  bumper.position.set(0, 0.40, 6.12);
  g.add(bumper);

  const hlMat = new THREE.MeshStandardMaterial({
    color: LIGHT_ON,
    emissive: 0xffe08a,
    emissiveIntensity: 0.65,
    roughness: 0.18,
  });
  const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.08), hlMat);
  hl.position.set(-0.92, 0.78, 6.12);
  hl.userData.headlight = true;
  g.add(hl);
  const hr = hl.clone();
  hr.position.x = 0.92;
  hr.userData.headlight = true;
  g.add(hr);

  const tlMat = new THREE.MeshStandardMaterial({
    color: TAIL,
    emissive: 0xff1a00,
    emissiveIntensity: 0.5,
    roughness: 0.28,
  });
  const tl = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 0.06), tlMat);
  tl.position.set(-1.05, 1.15, -6.12);
  g.add(tl);
  const tlr = tl.clone();
  tlr.position.x = 1.05;
  g.add(tlr);

  // Big transit mirrors
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.55), dark);
    arm.position.set(side * 1.32, 2.15, 5.55);
    g.add(arm);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.22), dark);
    cap.position.set(side * 1.42, 2.05, 5.28);
    g.add(cap);
  }

  for (const sx of [-0.85, 0.85]) {
    const spot = new THREE.SpotLight(0xfff1c4, 0, 42, Math.PI / 7, 0.5, 1.1);
    spot.position.set(sx, 0.82, 6.1);
    const tgt = new THREE.Object3D();
    tgt.position.set(sx * 0.1, 0.3, 16);
    g.add(tgt);
    spot.target = tgt;
    spot.userData.headSpot = true;
    g.add(spot);
  }

  const wr = 0.48;
  const ww = 0.3;
  const track = 1.12;
  // 40' two-axle + dual rear
  const layout: Array<[number, number, boolean, number]> = [
    [-track, 3.85, true, 1],
    [track, 3.85, true, 1],
    [-track, -3.55, false, 1],
    [track, -3.55, false, 1],
    [-track - 0.22, -3.55, false, 0.92],
    [track + 0.22, -3.55, false, 0.92],
  ];
  for (const [x, z, steer, scale] of layout) {
    const w = makeWheel(wr * scale, ww, steer);
    w.position.set(x, wr * scale, z);
    g.add(w);
  }
  // Wheel well lips
  for (const z of [3.85, -3.55]) {
    for (const x of [-1.22, 1.22]) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 1.15), dark);
      lip.position.set(x, 0.55, z);
      g.add(lip);
    }
  }

  return g;
}

export function createVehicle(id: VehicleId, transmission: TransmissionMode = 'auto'): Vehicle {
  const spec = VEHICLE_SPECS[id];
  const cls = vehicleClassOf(id);
  const mesh = cls === 'golf' ? buildGolf() : buildNewFlyerBus(id === 'bus_hybrid');
  mesh.name = spec.name;
  return new Vehicle(spec, mesh, transmission);
}
