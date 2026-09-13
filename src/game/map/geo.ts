/** Local ENU-ish projection: X east, Y up, Z north (meters from origin). */

const EARTH_RADIUS_M = 6378137;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export function metersPerDegreeLat(): number {
  return (Math.PI / 180) * EARTH_RADIUS_M;
}

export function metersPerDegreeLon(lat: number): number {
  return (Math.PI / 180) * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180);
}

export class GeoOrigin {
  readonly lat: number;
  readonly lon: number;
  readonly mPerDegLat: number;
  readonly mPerDegLon: number;

  constructor(lat: number, lon: number) {
    this.lat = lat;
    this.lon = lon;
    this.mPerDegLat = metersPerDegreeLat();
    this.mPerDegLon = metersPerDegreeLon(lat);
  }

  toLocal(lat: number, lon: number): Vec2 {
    return {
      x: (lon - this.lon) * this.mPerDegLon,
      z: (lat - this.lat) * this.mPerDegLat,
    };
  }

  toLatLon(x: number, z: number): LatLon {
    return {
      lon: this.lon + x / this.mPerDegLon,
      lat: this.lat + z / this.mPerDegLat,
    };
  }
}

/** Tile size in degrees (~1.1 km at mid latitudes). */
export const TILE_DEG = 0.01;

export function tileKey(tx: number, ty: number): string {
  return `${tx},${ty}`;
}

export function latLonToTile(lat: number, lon: number): { tx: number; ty: number } {
  return {
    tx: Math.floor(lon / TILE_DEG),
    ty: Math.floor(lat / TILE_DEG),
  };
}

export function tileBounds(tx: number, ty: number): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  return {
    west: tx * TILE_DEG,
    south: ty * TILE_DEG,
    east: (tx + 1) * TILE_DEG,
    north: (ty + 1) * TILE_DEG,
  };
}
