import * as THREE from 'three';
import { Vehicle, VEHICLE_SPECS, type VehicleId } from './Vehicle';

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

  // Lower body
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.55, 3.9), bodyMat);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);

  // Hatch cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.55, 2.1), bodyMat);
  cabin.position.set(0, 1.05, -0.15);
  cabin.castShadow = true;
  g.add(cabin);

  // Windows
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 0.08), glassMat);
  windshield.position.set(0, 1.1, 0.95);
  windshield.rotation.x = -0.35;
  g.add(windshield);

  const roofGlass = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 1.4), glassMat);
  roofGlass.position.set(0, 1.34, -0.1);
  g.add(roofGlass);

  // Bumpers
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.25, 0.25), dark);
  bumperF.position.set(0, 0.35, 2.05);
  g.add(bumperF);
  const bumperR = bumperF.clone();
  bumperR.position.z = -2.05;
  g.add(bumperR);

  // Headlights
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

  // Wheels
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

function buildBus(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xf5c542,
    metalness: 0.2,
    roughness: 0.55,
  });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x7ec8e8,
    metalness: 0.15,
    roughness: 0.2,
    transparent: true,
    opacity: 0.7,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.6, 11.5), bodyMat);
  body.position.y = 1.55;
  body.castShadow = true;
  g.add(body);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.52, 0.35, 11.52), stripeMat);
  stripe.position.y = 1.1;
  g.add(stripe);

  // Front windshield
  const wind = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 0.08), glassMat);
  wind.position.set(0, 2.0, 5.7);
  g.add(wind);

  // Side windows row
  for (let i = 0; i < 5; i++) {
    const z = 4.2 - i * 2.0;
    const wL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 1.4), glassMat);
    wL.position.set(-1.26, 2.05, z);
    g.add(wL);
    const wR = wL.clone();
    wR.position.x = 1.26;
    g.add(wR);
  }

  // Destination board
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.35, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x111111 }),
  );
  board.position.set(0, 2.85, 5.72);
  g.add(board);

  const wr = 0.48;
  const ww = 0.3;
  const positions: Array<[number, number, number]> = [
    [-1.15, wr, 3.8],
    [1.15, wr, 3.8],
    [-1.15, wr, 0.2],
    [1.15, wr, 0.2],
    [-1.15, wr, -3.6],
    [1.15, wr, -3.6],
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
  const mesh = id === 'golf' ? buildGolf() : buildBus();
  mesh.name = spec.name;
  return new Vehicle(spec, mesh);
}
