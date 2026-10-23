export interface CitySpawn {
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  /** Approximate heading in degrees (0 = north, clockwise) for spawn facing. */
  headingDeg: number;
}

/** North American cities with dense OSM road coverage. */
export const CITIES: CitySpawn[] = [
  {
    id: 'sf',
    name: 'San Francisco',
    region: 'California, USA',
    lat: 37.7749,
    lon: -122.4194,
    headingDeg: 90,
  },
  {
    id: 'chicago',
    name: 'Chicago',
    region: 'Illinois, USA',
    lat: 41.8781,
    lon: -87.6298,
    headingDeg: 0,
  },
  {
    id: 'nyc',
    name: 'New York City',
    region: 'New York, USA',
    lat: 40.758,
    lon: -73.9855,
    headingDeg: 180,
  },
  {
    id: 'toronto',
    name: 'Toronto',
    region: 'Ontario, Canada',
    lat: 43.6532,
    lon: -79.3832,
    headingDeg: 90,
  },
  {
    // King St W @ University Ave, Waterloo — dense grid near UW / uptown
    id: 'kw',
    name: 'Kitchener–Waterloo',
    region: 'Ontario, Canada',
    lat: 43.4728,
    lon: -80.5235,
    headingDeg: 90,
  },
];

export function getCityById(id: string): CitySpawn {
  const city = CITIES.find((c) => c.id === id);
  if (!city) throw new Error(`Unknown city: ${id}`);
  return city;
}

/**
 * v1.3.6: places for the HUD name at a ?spawn= override. Several anchors for
 * the big municipalities so a point is named by the place it is in, not the
 * biggest city within 60 km (1.3.5 showed "Toronto" in Hamilton).
 */
const PLACES: Array<{ name: string; region: string; pts: Array<[number, number]> }> = [
  { name: 'Toronto', region: 'Ontario, Canada', pts: [[43.6532, -79.3832], [43.6205, -79.5132], [43.7615, -79.4111], [43.7731, -79.2578], [43.6426, -79.4746], [43.6955, -79.5300]] },
  { name: 'Mississauga', region: 'Ontario, Canada', pts: [[43.589, -79.6441], [43.5513, -79.5857], [43.5462, -79.6631]] },
  { name: 'Oakville', region: 'Ontario, Canada', pts: [[43.4675, -79.6877], [43.4392, -79.7197]] },
  { name: 'Burlington', region: 'Ontario, Canada', pts: [[43.3255, -79.799], [43.3601, -79.8143], [43.3807, -79.7781]] },
  { name: 'Hamilton', region: 'Ontario, Canada', pts: [[43.2557, -79.8711], [43.2665, -79.84], [43.2899, -79.7867], [43.2178, -79.765], [43.2354, -79.9441], [43.2735, -79.8085]] },
  { name: 'Kitchener', region: 'Ontario, Canada', pts: [[43.4516, -80.4925], [43.4194, -80.4426]] },
  { name: 'Waterloo', region: 'Ontario, Canada', pts: [[43.4643, -80.5204], [43.4723, -80.5449], [43.4898, -80.5345]] },
  { name: 'Cambridge', region: 'Ontario, Canada', pts: [[43.3616, -80.3144]] },
  { name: 'Guelph', region: 'Ontario, Canada', pts: [[43.5448, -80.2482]] },
  { name: 'Brampton', region: 'Ontario, Canada', pts: [[43.7315, -79.7624]] },
  { name: 'Vaughan', region: 'Ontario, Canada', pts: [[43.8361, -79.4983]] },
  { name: 'Markham', region: 'Ontario, Canada', pts: [[43.8561, -79.337]] },
  { name: 'Pickering', region: 'Ontario, Canada', pts: [[43.8384, -79.0868]] },
  { name: 'Milton', region: 'Ontario, Canada', pts: [[43.5183, -79.8774]] },
  { name: 'Grimsby', region: 'Ontario, Canada', pts: [[43.2001, -79.5663]] },
];

/** Nearest place (gazetteer, then the city presets) within 25 km, else null. */
export function nearestPlace(lat: number, lon: number): { name: string; region: string } | null {
  const k = Math.cos((lat * Math.PI) / 180);
  const km = (a: number, b: number) => Math.hypot(a - lat, (b - lon) * k) * 111.32;
  let best: { name: string; region: string } | null = null;
  let bd = Infinity;
  for (const p of PLACES)
    for (const [a, b] of p.pts) {
      const d = km(a, b);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
  for (const c of CITIES) {
    const d = km(c.lat, c.lon);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best && bd < 25 ? { name: best.name, region: best.region } : null;
}
