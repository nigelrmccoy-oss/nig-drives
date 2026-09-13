import * as THREE from 'three';
import { Vehicle, VEHICLE_SPECS, vehicleClassOf, type VehicleId } from './Vehicle';

function makeWheel(radius: number, width: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius, radius, width, 12);
  geo.rotateZ(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

function buildGolf(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xc62828,
    metalness: 0.35,
    roughness: 0.4,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x88c7e8,
    metalness: 0.2,
    roughness: 0.15,
    transparent: true,
    opacity: 0.75,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.55, 3.9), bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.55, 2.1), bodyMat);
  cabin.position.set(0, 1.05, -0.15);
  cabin.castShadow = true;
  g.add(cabin);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 0.08), glassMat);
  windshield.position.set(0, 1.1, 0.95);
  windshield.rotation.x = -0.35;
  g.add(windshield);

  const roofGlass = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 1.4), glassMat);
  roofGlass.position.set(0, 1.34, -0.1);
  g.add(roofGlass);

  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.25, 0.25), dark);
  bumperF.position.set(0, 0.35, 2.05);
  g.add(bumperF);
  const bumperR = bumperF.clone();
  bumperR.position.z = -2.05;
  g.add(bumperR);

  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xfff5cc,
    emissive: 0xffe08a,
    emissiveIntensity: 0.6,
  });
  const hl = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.1), lightMat);
  hl.position.set(-0.55, 0.55, 1.98);
  g.add(hl);
  const hr = hl.clone();
  hr.position.x = 0.55;
  g.add(hr);

  const wr = 0.32;
  const ww = 0.22;
  const positions: Array<[number, number, number]> = [
    [-0.85, wr, 1.25],
    [0.85, wr, 1.25],
    [-0.85, wr, -1.25],
    [0.85, wr, -1.25],
  ];
  for (const [x, y, z] of positions) {
    const w = makeWheel(wr, ww);
    w.position.set(x, y, z);
    g.add(w);
  }

  return g;
}

/**
 * Stylized New Flyer–style transit bus (not a trademarked GRT replica).
 * White body, blue beltline, green accent — reads as KW-area transit.
 */
function buildNewFlyerBus(hybrid: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xf4f6f8,
    metalness: 0.25,
    roughness: 0.45,
  });
  const blueMat = new THREE.MeshStandardMaterial({
    color: 0x1e4d8c,
    metalness: 0.2,
    roughness: 0.5,
  });
  const greenMat = new THREE.MeshStandardMaterial({
    color: hybrid ? 0x2e8b57 : 0x3d9b4f,
    metalness: 0.15,
    roughness: 0.55,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x6eb8d8,
    metalness: 0.15,
    roughness: 0.2,
    transparent: true,
    opacity: 0.72,
  });

  // Low-floor-ish box with slightly rounded front read via bumper stack
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.55, 2.55, 12.0), bodyMat);
  body.position.y = 1.55;
  body.castShadow = true;
  g.add(body);

  // Blue beltline (New Flyer / transit look)
  const belt = new THREE.Mesh(new THREE.BoxGeometry(2.58, 0.42, 12.05), blueMat);
  belt.position.y = 1.05;
  g.add(belt);

  // Green accent stripe (stylized GRT-ish, not a logo)
  const accent = new THREE.Mesh(new THREE.BoxGeometry(2.59, 0.12, 12.06), greenMat);
  accent.position.y = 1.32;
  g.add(accent);

  // Roof fairing
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.22, 10.5), dark);
  roof.position.y = 2.92;
  g.add(roof);

  if (hybrid) {
    // Hybrid battery pack bulge on roof
    const pack = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.35, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x2a3a2a, metalness: 0.4, roughness: 0.4 }),
    );
    pack.position.set(0, 3.15, -1.5);
    g.add(pack);
    // Small "HYBRID" plate colour block
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.06), greenMat);
    badge.position.set(0.7, 1.7, 6.02);
    g.add(badge);
  } else {
    // Diesel exhaust stack hint (rear curb side)
    const stack = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.2, 8),
      dark,
    );
    stack.position.set(1.1, 3.1, -5.2);
    g.add(stack);
  }

  // Front windshield (large transit glass)
  const wind = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.5, 0.08), glassMat);
  wind.position.set(0, 2.05, 5.95);
  g.add(wind);

  // Destination board
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.38, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x112233, emissiveIntensity: 0.3 }),
  );
  board.position.set(0, 2.95, 5.98);
  g.add(board);

  // Side windows
  for (let i = 0; i < 6; i++) {
    const z = 4.5 - i * 1.7;
    const wL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.95, 1.35), glassMat);
    wL.position.set(-1.29, 2.1, z);
    g.add(wL);
    const wR = wL.clone();
    wR.position.x = 1.29;
    g.add(wR);
  }

  // Front bumper / bike-rack area
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.35, 0.35), dark);
  bumper.position.set(0, 0.45, 6.05);
  g.add(bumper);

  // Headlights
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xfff8e0,
    emissive: 0xffe08a,
    emissiveIntensity: 0.7,
  });
  const hl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.22, 0.1), lightMat);
  hl.position.set(-0.85, 0.85, 6.02);
  g.add(hl);
  const hr = hl.clone();
  hr.position.x = 0.85;
  g.add(hr);

  // Door hint (front curb)
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.8, 1.1), glassMat);
  door.position.set(-1.3, 1.4, 4.2);
  g.add(door);

  const wr = 0.5;
  const ww = 0.32;
  const positions: Array<[number, number, number]> = [
    [-1.15, wr, 3.9],
    [1.15, wr, 3.9],
    [-1.15, wr, 0.3],
    [1.15, wr, 0.3],
    [-1.15, wr, -3.8],
    [1.15, wr, -3.8],
  ];
  for (const [x, y, z] of positions) {
    const w = makeWheel(wr, ww);
    w.position.set(x, y, z);
    g.add(w);
  }

  return g;
}

export function createVehicle(id: VehicleId): Vehicle {
  const spec = VEHICLE_SPECS[id];
  const cls = vehicleClassOf(id);
  const mesh =
    cls === 'golf' ? buildGolf() : buildNewFlyerBus(id === 'bus_hybrid');
  mesh.name = spec.name;
  return new Vehicle(spec, mesh);
}
