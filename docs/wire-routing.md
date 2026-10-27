# Wire routing algorithms (stand / future rewrite)

Status: **stand + tidy/commit integration**. Production tidy/commit/ribbon use
`router: 'channel'` (escape → A\*). Rubber-band draw still uses the L/Z pattern
catalog. Run `npm run test:routing` and `npx vitest run test/route-channel.test.ts`.

Goal for the stand: pin→pin orthogonal routes that

1. leave each pin along its natural exit direction,
2. avoid component body AABBs,
3. prefer few bends and short total length,
4. never introduce 45° segments,
5. play well with explicit waypoints and T-junction nodes.

---

## Current pipeline (what ships today)

```
raw polyline (pin → waypoints → pin)
        │
        ▼
routeWirePoints()
  ├─ pinExitDir(start/end) from body center
  ├─ per segment: routeSegmentSmart()
  │     ├─ collectPatternCandidates()  // L / Z / exit stubs
  │     ├─ pickBestPath(score)
  │     └─ if still hits bodies → routeAStar() on GRID
  └─ simplifyOrthoPath()
```

| Piece | Role |
|-------|------|
| `pinExitDir` | Unit axis away from component center through the pin |
| `orthogonalPoints` / HV·VH | Single-corner L between two points |
| `collectPatternCandidates` | Catalog of L/Z + escape stubs for start/end dirs |
| `pickBestPath` | Score length, bends, obstacle penetration |
| `routeAStar` | Coarse grid maze; null if window too big / blocked |
| `simplifyOrthoPath` | Drop colinear / duplicate verts |
| `routingObstacles` | Body AABBs for the active circuit |
| `findWireCrossings` | Cosmetic H×V solder dots (not topology) |

**Pain points observed in lab tutorials**

- Stub catalog often wins over A* even when a cleaner maze path exists.
- Obstacles are axis-aligned boxes only — no “channel” preference between chips.
- Multi-waypoint wires only smart-route first/last legs; middle stays crude L.
- Commit-time auto-tidy can fight manual bends the user just placed.

---

## Stand algorithms (`stands/wire-routing`)

Headless harness: pins + AABBs in, polyline out, golden fixtures, SVG dump.

```bash
npm run test:routing
npx vite-node stands/wire-routing/src/dump.ts ribbon-4 --out /tmp/ribbon.svg
```

### A. Pattern-first with hard obstacle veto (small change)

1. Generate the same L/Z/stub catalog.
2. **Reject** any candidate that intersects an obstacle interior (not merely score higher).
3. If none remain → A*.
4. If A* fails → longest clear stub + L to the other pin.

Acceptance: no segment midpoint inside a body AABB.

### B. Escape-then-channel (implemented in stand)

1. **Escape:** from each pin, walk `exitDir` until clear (+ min stub). Skip forced stub when the target lies against the exit dir.
2. **Channel A\*** on GRID from escape(start) to escape(end):
   - length = 1 per step
   - bend (direction change) = 2.5
   - occupied trunk (fanout) = 6
3. **Simplify** colinear / overshoot verts; attach pin stubs.

State is `(cell, incomingDir)`. Fixtures: `face-to-face`, `around-body`, `ribbon-4`, `junction-tee`.

### B.1 Pin escape lanes (post-drag artifacts)

Dragging a chip drops the waypoints of half-attached wires, so mouseup re-runs
`tidySelectedWires` and every route is rebuilt from scratch. Two rules keep that
rebuild from producing the stubs and stair-steps users reported:

- **Candidate shapes follow the pin axes, not the span aspect.** A pin firing
  E/W always starts the route horizontally, so a vertical jog on (or beside) its
  own column is never proposed — that jog is the "stair right after the pin".
  Facing pairs get one rail (`from → (railX, from.y) → (railX, to.y) → to`),
  perpendicular pairs get a single corner.
- **Its own package is an obstacle for the maze.** Endpoint bodies are excluded
  from `obstacles` so pin stubs can leave them; they are passed separately as
  `hostObstacles` and block the channel A\*, which otherwise tunnelled through a
  chip to reach a pin from the wrong side.

Both the shape candidates and the maze result are ranked by one metric
(`scorePath`): bends, length, jogs inside a pin's clearance (graded, so a
congested gap degrades to the next lane instead of a multi-bend detour),
long runs hugging a pin column, backtracking, and colinear overlap with
already-routed wires. Rails come from up to four free channels around the gap
centre, so fan-ins spread instead of stacking.

Regression cover: `test/route-drag-tidy.test.ts` (move COUNTER4 in
`examples/lab-counter-7seg.json`, then tidy) and
`npx vite-node stands/wire-routing/src/dragRepro.ts <example.json> <NAME> <dx> <dy>`
for an ad-hoc dump of every wire on the moved part.

### C. Visibility / rectilinear visibility graph

Later: inflate obstacles, Steiner at corners, shortest ortho path. Use when grid A\* is too coarse/slow.

### D. Incremental / local repair (editor UX)

On drag: re-route only affected segments; keep explicit waypoints.

---

## Exit criteria before merging back to geometry.ts

- [x] Fixture suite: zero body intersections (`npm run test:routing`)
- [x] Latch + counter + BUF8 fixtures from real examples
- [x] Facing exits ≤ 3 bends (`face-to-face`)
- [ ] Explicit mid-waypoints preserved under tidy of other legs
- [x] Drop-in behind `routeWirePoints` for tidy/commit/ribbon (`router: 'channel'`)
- [x] Perf: &lt; 2 ms/route stand microbench

Drawing: pin→pin without bends uses the channel router both for the rubber-band
preview and for the commit (`Editor.routeNewWire`), so the committed wire is the
path that was shown. With bends, each leg is pattern-routed between the clicked
points and the result is stored as corners. A free (non-pin) cursor end stays on
the pattern catalog.

Manual editing: `src/ui/wireEdit.ts` slides a leg or moves a corner on the drawn
orthogonal path, splitting the pin-adjacent legs into a short pin stub plus a
movable vertex so the pin exit direction survives. Edited wires get
`Wire.manual`; implicit tidies keep them while the stored path is orthogonal and
clear of foreign bodies, explicit tidy of the wire clears the flag.

## Pin exit direction

`pinRouteDir` derives the direction a wire leaves a pin. Chips, RAM and ROM have pins
only on their left and right stacks, so the direction is taken from the pin's side of
the body. Inferring it from the pin's offset aspect (`pinExitDir`) sends the top and
bottom pins of a tall package out vertically along the pin column, which makes a bus
into that package arrive on top of itself (ALU8 inputs overlapped: 2464 units before,
0 after).

Routed paths are expanded to orthogonal legs the way the renderer draws them and then
passed through `cleanRoute`: doubling back on a line is dropped and a jog shorter than
half a grid between parallel legs is collapsed, only when the result stays clear of
bodies and does not run along other wires more than before. Pins off the grid leave
slanted legs in the channel router's output, which is what produced those jogs.
`lab-mini-cpu` places COUNTER4 inside SOFT_RAM16; the two body hits that remain there come
from the layout, not from the router.
