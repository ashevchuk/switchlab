import { describe, expect, it } from 'vitest';
import { fixtureRibbonRails, listFixtures, loadFixture, runFixture } from '../src/harness.js';
import { assignRibbonRails, escapePoint, routeEscapeChannel, simplifyOrthoPath } from '../src/route.js';
import { pathHitsObstacles, pathOverlapLength } from '../src/score.js';
import type { Point } from '../src/types.js';

/** H×V crossings between two orthogonal polylines (interior only). */
function crossings(p: Point[], q: Point[]): number {
  let n = 0;
  for (let i = 0; i < p.length - 1; i++) {
    for (let j = 0; j < q.length - 1; j++) {
      const [a0, a1, b0, b1] = [p[i]!, p[i + 1]!, q[j]!, q[j + 1]!];
      const aH = Math.abs(a0.y - a1.y) < 0.5;
      const bH = Math.abs(b0.y - b1.y) < 0.5;
      if (aH === bH) continue;
      const [h0, h1, v0, v1] = aH ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
      const x = v0.x;
      const y = h0.y;
      if (x <= Math.min(h0.x, h1.x) + 0.5 || x >= Math.max(h0.x, h1.x) - 0.5) continue;
      if (y <= Math.min(v0.y, v1.y) + 0.5 || y >= Math.max(v0.y, v1.y) - 0.5) continue;
      n++;
    }
  }
  return n;
}

function railOf(path: Point[]): number | undefined {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) > 0.5) return a.x;
  }
  return undefined;
}

describe('escape-channel stand', () => {
  it('escapePoint walks clear of a body along exit dir', () => {
    const box = { minX: 0, minY: 0, maxX: 80, maxY: 100 };
    const esc = escapePoint({ x: 80, y: 50 }, 'E', [box], 10, 2);
    expect(esc.x).toBeGreaterThanOrEqual(100);
    expect(esc.y).toBe(50);
  });

  it('simplifyOrthoPath drops colinear mids', () => {
    expect(
      simplifyOrthoPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
  });

  for (const name of listFixtures()) {
    it(`fixture ${name}: no body hits + ceilings`, () => {
      const fixture = loadFixture(name);
      const results = runFixture(fixture);
      expect(results.length).toBe(fixture.nets.length);

      for (let i = 0; i < results.length; i++) {
        const net = fixture.nets[i]!;
        const r = results[i]!;
        expect(r.hits, `${net.id} hits body`).toBe(false);
        expect(pathHitsObstacles(r.path, net.obstacles ?? fixture.obstacles)).toBe(false);
        if (net.maxBends != null) {
          expect(r.bends, `${net.id} bends`).toBeLessThanOrEqual(net.maxBends);
        }
        if (net.maxLength != null) {
          expect(r.length, `${net.id} length`).toBeLessThanOrEqual(net.maxLength);
        }
      }
    });
  }

  it('ribbon-4 trunks do not stack on the same Y', () => {
    const fixture = loadFixture('ribbon-4');
    const results = runFixture(fixture);
    const horizYs = new Set<number>();
    for (const r of results) {
      // Main span Y: longest horizontal segment.
      let bestY = r.path[0]!.y;
      let bestLen = 0;
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i]!;
        const b = r.path[i + 1]!;
        if (Math.abs(a.y - b.y) < 0.5) {
          const len = Math.abs(a.x - b.x);
          if (len > bestLen) {
            bestLen = len;
            bestY = a.y;
          }
        }
      }
      expect(horizYs.has(bestY), `stacked trunk at y=${bestY}`).toBe(false);
      horizYs.add(bestY);
    }
    // Also: pairwise overlap of full paths should be ~0.
    for (let i = 1; i < results.length; i++) {
      const prior = results.slice(0, i).map((r) => r.path);
      expect(pathOverlapLength(results[i]!.path, prior)).toBe(0);
    }
  });

  it('around-body skirts the package (not a through-L)', () => {
    const fixture = loadFixture('around-body');
    const [r] = runFixture(fixture);
    expect(r!.hits).toBe(false);
    expect(r!.bends).toBeGreaterThanOrEqual(2);
    // Must leave the blocked mid-band at y=100 for some vertical run.
    const ys = new Set(r!.path.map((p) => p.y));
    expect([...ys].some((y) => y !== 100)).toBe(true);
  });

  it('fanout-spine: the same-net branch rides the trunk and splits near its destination', () => {
    const fixture = loadFixture('fanout-spine');
    const [trunk, branch] = runFixture(fixture);
    expect(trunk!.bends).toBe(0);
    expect(branch!.bends).toBe(2);
    // Shared spine ≥ 200 of the 220 px trunk (jog just before the chip edge).
    expect(pathOverlapLength(branch!.path, [trunk!.path])).toBeGreaterThanOrEqual(200);
    // Without the same-net tag the branch would jog around the gap centre.
    const untagged = structuredClone(fixture);
    for (const n of untagged.nets) delete n.net;
    const [, plain] = runFixture(untagged);
    expect(pathOverlapLength(plain!.path, [trunk!.path])).toBeLessThan(150);
  });

  it('ribbon-shifted: rails nest so no two wires cross or merge', () => {
    const fixture = loadFixture('ribbon-shifted');
    const results = runFixture(fixture);
    const rails = results.map((r) => railOf(r.path));
    // Top wire nearest the destination, one contiguous lane per wire.
    expect(rails).toEqual([220, 210, 200, 190]);
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i]!;
        const b = results[j]!;
        expect(crossings(a.path, b.path), `${a.id} crosses ${b.id}`).toBe(0);
        expect(pathOverlapLength(a.path, [b.path]), `${a.id} overlaps ${b.id}`).toBe(0);
      }
    }
  });

  it('ribbon-tight: wires with disjoint spans pair up on the two clear lanes', () => {
    const fixture = loadFixture('ribbon-tight');
    const assigned = fixtureRibbonRails(fixture, 10);
    expect([...assigned.values()].sort()).toEqual([100, 100, 90, 90]);
    const results = runFixture(fixture);
    for (const r of results) {
      expect(railOf(r.path), `${r.id} rail`).toBe(assigned.get(r.id));
      expect(r.bends).toBe(2);
    }
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i]!;
        const b = results[j]!;
        expect(crossings(a.path, b.path), `${a.id} crosses ${b.id}`).toBe(0);
        expect(pathOverlapLength(a.path, [b.path]), `${a.id} overlaps ${b.id}`).toBe(0);
      }
    }
  });

  it('assignRibbonRails: converging fan-in nests from both sides and braids fall back to pin order', () => {
    // Top wires go down, bottom wires go up: the inner wire's source row
    // would cut the outer wire's vertical, so outer wires take the lanes
    // nearest the destination and inner wires the lanes nearest the source.
    const fanIn = assignRibbonRails(
      [
        { id: 't1', src: 20, dst: 80 },
        { id: 't2', src: 40, dst: 90 },
        { id: 'b2', src: 160, dst: 110 },
        { id: 'b1', src: 180, dst: 120 },
      ],
      100,
      300,
    );
    expect(fanIn.get('t2')!).toBeLessThan(fanIn.get('t1')!);
    expect(fanIn.get('b2')!).toBeLessThan(fanIn.get('b1')!);
    // Lanes are distinct and sit clear of the source pins.
    const lanes = [...fanIn.values()];
    expect(new Set(lanes).size).toBe(4);
    for (const l of lanes) expect(l - 100).toBeGreaterThan(25);
    // A true braid (pins swapped) has no crossing-free order; still one lane each.
    const braid = assignRibbonRails(
      [
        { id: 'p', src: 20, dst: 60 },
        { id: 'q', src: 60, dst: 20 },
      ],
      100,
      300,
    );
    expect(new Set(braid.values()).size).toBe(2);
  });

  it('perf: 50 random clear pairs under 2ms average', () => {
    const obstacles = [
      { minX: 100, minY: 100, maxX: 200, maxY: 200 },
      { minX: 300, minY: 150, maxX: 400, maxY: 280 },
    ];
    const n = 50;
    const averageMs = () => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const y = 40 + (i % 10) * 10;
        routeEscapeChannel({
          from: { x: 40, y },
          to: { x: 460, y: y + ((i % 3) - 1) * 20 },
          startDir: 'E',
          endDir: 'W',
          obstacles,
        });
      }
      return (performance.now() - t0) / n;
    };
    // The first pass pays for JIT warm-up and a busy test worker can stall any single pass;
    // the best of several passes measures the router itself.
    const avg = Math.min(averageMs(), averageMs(), averageMs(), averageMs());
    expect(avg).toBeLessThan(2);
  });
});
