export interface OsmNode {
  lat: number;
  lon: number;
}

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: OsmNode[];
}

export interface OverpassResult {
  ways: OsmWay[];
  buildings: OsmWay[];
  source: string;
}

const HIGHWAY_FILTER =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

function buildQuery(south: number, west: number, north: number, east: number): string {
  // Highways + building footprints for immersion (capped by tile size).
  return `
[out:json][timeout:28];
(
  way["highway"~"^(${HIGHWAY_FILTER})$"](${south},${west},${north},${east});
  way["building"](${south},${west},${north},${east});
);
out geom;
`.trim();
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  '/api/overpass',
  '/api/overpass-kumi',
];

let lastRequestAt = 0;
const MIN_GAP_MS = 900;

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastRequestAt));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export class OverpassClient {
  private memoryCache = new Map<string, { ways: OsmWay[]; buildings: OsmWay[] }>();

  getCached(key: string): { ways: OsmWay[]; buildings: OsmWay[] } | undefined {
    return this.memoryCache.get(key);
  }

  setCached(key: string, data: { ways: OsmWay[]; buildings: OsmWay[] }): void {
    this.memoryCache.set(key, data);
  }

  async fetchTile(
    key: string,
    south: number,
    west: number,
    north: number,
    east: number,
  ): Promise<OverpassResult> {
    const cached = this.memoryCache.get(key);
    if (cached) return { ...cached, source: 'memory' };

    const query = buildQuery(south, west, north, east);
    let lastError: unknown;

    for (const endpoint of ENDPOINTS) {
      try {
        await waitForSlot();
        const parsed = await this.postQuery(endpoint, query);
        this.memoryCache.set(key, parsed);
        return { ...parsed, source: endpoint };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async postQuery(
    endpoint: string,
    query: string,
  ): Promise<{ ways: OsmWay[]; buildings: OsmWay[] }> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
      },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!res.ok) {
      throw new Error(`Overpass ${res.status} from ${endpoint}`);
    }

    const data = (await res.json()) as {
      elements?: Array<{
        type: string;
        id: number;
        tags?: Record<string, string>;
        geometry?: OsmNode[];
      }>;
    };

    const ways: OsmWay[] = [];
    const buildings: OsmWay[] = [];
    for (const el of data.elements ?? []) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const tags = el.tags ?? {};
      const item: OsmWay = { id: el.id, tags, geometry: el.geometry };
      if (tags.highway) ways.push(item);
      else if (tags.building) buildings.push(item);
    }
    // Cap buildings per tile for mid-laptop perf
    if (buildings.length > 220) {
      buildings.length = 220;
    }
    return { ways, buildings };
  }
}
