// Deterministic unit-scale check: node scripts/checks/p2-heat.mjs
// Uses the production functions, bundled by Vite's esbuild dependency.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const dir = await mkdtemp(join(tmpdir(), 'nig-heat-'));
try {
  const bundle = await build({ entryPoints: ['src/game/physics/tyreHeat.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const modulePath = join(dir, 'heat.mjs');
  await writeFile(modulePath, bundle.outputFiles[0].text);
  const {heatParamsForCompound: params, stepTyreTemp: step} = await import(pathToFileURL(modulePath).href);
  const result = (() => {
    const run = (seconds, start, power, speed, id='sport', hz=120) => {
      let temp = start;
      for(let i=0;i<seconds*hz;i++) temp=step(temp,1/hz,power,speed,4000,params(id));
      return +temp.toFixed(3);
    };
    // 7 kW/wheel: e.g. 3.5 kN tyre force dissipated at 2 m/s combined slip.
    // Burnout 70 kW: same force at 20 m/s wheelspin, 2 m/s road speed.
    return {
      cold5: run(5,22,7000,25), hard60: run(60,22,7000,25), hard300: run(300,22,7000,25),
      warmBurnout10: run(10,88,70000,2), coldBurnout10: run(10,22,70000,2),
      coast30: run(30,88,0,30), stationary30: run(30,88,0,0),
      allSeason60: run(60,22,7000,25,'all_season'), winter60: run(60,22,7000,25,'winter'),
      slick60: run(60,22,7000,25,'slick_hard'), hard60at60Hz: run(60,22,7000,25,'sport',60),
    };
  })();
  assert(result.cold5 < 50);
  assert(result.hard60 > 70 && result.hard60 < 105);
  assert(result.hard300 > 75 && result.hard300 < 116);
  assert(result.warmBurnout10 > 88 && result.warmBurnout10 < 130);
  assert(result.coldBurnout10 < 70);
  assert(result.coast30 < result.stationary30 && result.coast30 < 70);
  assert(result.winter60 < result.allSeason60 && result.allSeason60 < result.hard60 && result.hard60 < result.slick60);
  assert(Math.abs(result.hard60-result.hard60at60Hz)<0.01);
  console.log('PASS heat', JSON.stringify(result));
} finally { await rm(dir, { recursive: true, force: true }); }
