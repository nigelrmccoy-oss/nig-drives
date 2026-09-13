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
