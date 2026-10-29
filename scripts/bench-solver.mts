/**
 * Solver benchmark and behaviour guard.
 *
 *   npm run bench:solver                      run every scenario and print timings
 *   npm run bench:solver -- --scenario tiny-cpu --ticks 300
 *   npm run bench:solver -- --out results.json
 *   npm run bench:solver -- --write-golden    record the current solver's behaviour
 *   npm run bench:solver -- --check           compare behaviour against the golden file
 *
 * Timings depend on the machine; the digests (`chain`, `finalDigest`, `trace`)
 * do not, so a replacement solver is compared on those.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, behaviourOf, runScenario, type BenchResult } from './lib/solverBench.js';

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'solver-golden.json');

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(name);

const only = argValue('--scenario');
const ticksArg = argValue('--ticks');
const selected = SCENARIOS.filter((s) => !only || only === 'all' || s.name === only);
if (selected.length === 0) {
  console.error(`unknown scenario "${only}"; available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const results: BenchResult[] = [];
for (const scenario of selected) {
  console.log(`\n== ${scenario.name}: ${scenario.description}`);
  const result = runScenario(scenario, ticksArg ? Number(ticksArg) : scenario.defaultTicks);
  results.push(result);
  console.log(`nets ${result.nets}, build ${result.buildMs} ms, flatten ${result.flattenMs} ms over ${result.ticks} ticks`);
  console.log(`step ms/tick: mean ${result.stepMs.mean}, median ${result.stepMs.median}, p90 ${result.stepMs.p90} (total ${result.stepMs.total} ms)`);
  console.log(`iterations/tick: mean ${result.iterations.mean}, max ${result.iterations.max}, hit the cap on ${result.iterations.capped} ticks`);
  console.log(`nets changed/tick: median ${result.changed.median}, p90 ${result.changed.p90}, max ${result.changed.max}`);
  console.log(`behaviour: chain ${result.chain}, final ${result.finalDigest}, trace ${result.trace.slice(0, 6).join(' | ')}${result.trace.length > 6 ? ' …' : ''}`);
}

const outPath = argValue('--out');
if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');

if (flag('--write-golden')) {
  const golden: Record<string, ReturnType<typeof behaviourOf>> = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) : {};
  for (const r of results) golden[r.scenario] = behaviourOf(r);
  writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
  console.log(`\nwrote ${GOLDEN_PATH}`);
}

if (flag('--check')) {
  const golden: Record<string, ReturnType<typeof behaviourOf>> = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  let failed = false;
  for (const r of results) {
    const want = golden[r.scenario];
    const got = behaviourOf(r);
    const same = want !== undefined && JSON.stringify(want) === JSON.stringify(got);
    console.log(`${same ? 'MATCH ' : 'DIFFER'} ${r.scenario}${same ? '' : ` (golden ${want?.ticks} ticks, chain ${want?.chain}; got ${got.ticks} ticks, chain ${got.chain})`}`);
    if (!same) failed = true;
  }
  if (failed) process.exit(1);
}
{ const stats = (await import('../src/sim/solver.js')).shadowOrderedStats; if (stats.compared + stats.skipped > 0) console.log('SHADOW-ORDERED', JSON.stringify(stats)); }
