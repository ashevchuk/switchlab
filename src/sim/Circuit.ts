import type { Component, NetMap, Pin, Point, Wire } from './types.js';
import { UnionFind } from './UnionFind.js';

/** Names that always resolve to the same global net, regardless of wiring topology. */
export const GLOBAL_NET_NAMES = new Set(['VCC', 'GND']);

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

/**
 * A single, global, monotonically-increasing counter bumped by every
 * structural mutation to *any* Circuit anywhere in the app — top-level or
 * a ChipDef's own internals (chip defs are edited in place, "dive in and
 * press E," not copied — see ChipLibrary's own doc comment). One shared
 * counter rather than a per-Circuit version because a chip instance's
 * flattened expansion depends on its ChipDef's circuit too, transitively,
 * for however many levels deep the hierarchy goes; tracking that
 * dependency graph precisely would cost more to maintain than it would
 * ever save. Global and coarse trades a few redundant re-flattens during
 * *active* editing (touching one circuit invalidates every other circuit's
 * own cache too, even unrelated ones) for a guarantee that is never wrong
 * — see hierarchy.ts's flatten() for the caching this exists to support.
 */
let structureVersion = 0;
export function bumpStructureVersion(): void {
  structureVersion += 1;
}
export function currentStructureVersion(): number {
  return structureVersion;
}

/**
 * Fast-forwards the shared id counter past whatever numeric suffix `id`
 * ends in, if it's higher than what's already been handed out. Every
 * loader (serialize.ts's deserializeCircuit/deserializeProject) calls this
 * for every id it reads, so that anything the user creates *after* loading
 * saved data can never collide with an id that data already uses — ids are
 * a flat, prefix-agnostic monotonic counter (`t1`, `src2`, `chipdef3`, ...),
 * so a plain trailing-digits match is enough regardless of prefix.
 */
export function noteUsedId(id: string): void {
  const match = /(\d+)$/.exec(id);
  if (!match) return;
  const n = Number(match[1]);
  if (n > idCounter) idCounter = n;
}

/**
 * A flat (non-hierarchical) netlist: components + wires between their pins.
 * Hierarchy (folding a sub-circuit into a reusable chip) is a later layer
 * that composes several Circuits — this class only models one flat level.
 */
export class Circuit {
  readonly components = new Map<string, Component>();
  readonly wires = new Map<string, Wire>();
  private netsCache: { version: number; result: NetMap } | undefined;
  /** Nested beginBatch/endBatch depth — defer structure-version bumps while > 0. */
  private batchDepth = 0;

  /**
   * Defer bumpStructureVersion across many addComponent/addWire calls.
   * endBatch bumps once when the outermost batch closes. Safe for builders
   * that do not read flatten/computeNets caches mid-construction.
   */
  beginBatch(): void {
    this.batchDepth += 1;
  }

  endBatch(): void {
    if (this.batchDepth <= 0) return;
    this.batchDepth -= 1;
    if (this.batchDepth === 0) bumpStructureVersion();
  }

  addComponent(c: Component): void {
    this.components.set(c.id, c);
    if (this.batchDepth === 0) bumpStructureVersion();
  }

  /** Insert an already-built Component verbatim, no version bump — the
   * addRawWire() of components, for the identical reason: flatten()'s own
   * output circuit is built entirely out of these (see addRawWire's own
   * doc comment) and must not invalidate its own cache entry while still
   * being assembled. Never call this for anything a user's own edit
   * created — that always goes through addComponent(). */
  addRawComponent(c: Component): void {
    this.components.set(c.id, c);
  }

  /**
   * Translates a component (and every one of its pins) by the same
   * (dx, dy) — dragging a component in the editor. Every pin's position is
   * a fixed offset from its owner's `pos` set once at creation time (see
   * `LAYOUT` in library.ts), so sliding both by the identical delta keeps
   * that offset exactly right without needing to know what it was.
   * Wires reference pins by id, not position, so they follow automatically
   * — except any waypoints already on them, which are independent points
   * in world space and deliberately don't move with either endpoint.
   */
  moveComponent(id: string, dx: number, dy: number): void {
    const c = this.components.get(id);
    if (!c) return;
    c.pos = { x: c.pos.x + dx, y: c.pos.y + dy };
    for (const p of Object.values(c.pins) as Pin[]) {
      p.pos = { x: p.pos.x + dx, y: p.pos.y + dy };
    }
    bumpStructureVersion(); // pos alone never changes flatten()'s own output, but see its own doc comment on why this bumps anyway
  }

  removeComponent(id: string): void {
    this.components.delete(id);
    for (const w of [...this.wires.values()]) {
      if (w.a.startsWith(`${id}:`) || w.b.startsWith(`${id}:`)) {
        this.wires.delete(w.id);
      }
    }
    bumpStructureVersion();
  }

  addWire(a: string, b: string, waypoints?: Point[], bundleId?: string): Wire {
    const id = nextId('w');
    const w: Wire =
      waypoints !== undefined && waypoints.length > 0 ? { id, a, b, waypoints } : { id, a, b };
    if (bundleId) w.bundleId = bundleId;
    this.wires.set(id, w);
    if (this.batchDepth === 0) bumpStructureVersion();
    return w;
  }

  /** Insert an already-built Wire verbatim, keeping its id. Used by
   * hierarchy.ts's flatten(), which computes stable namespaced wire ids
   * itself while cloning a chip instance's internals. Deliberately does
   * NOT bump the structure version the way addWire() does: the *output*
   * Circuit flatten() builds this into is a cached, throwaway result, not
   * a circuit a user edits — bumping here would invalidate flatten()'s own
   * cache entry the instant it finished computing it. */
  addRawWire(w: Wire): void {
    this.wires.set(w.id, w);
  }

  removeWire(id: string): void {
    this.wires.delete(id);
    bumpStructureVersion();
  }

  /** Pin ids are `<componentId>:<name>`, so the owner is found directly; the name may be stale after a port rename, hence the scan of its own pins. */
  findPin(pinId: string): Pin | undefined {
    const owner = this.components.get(pinId.slice(0, pinId.indexOf(':')));
    return (owner && (Object.values(owner.pins) as Pin[]).find((p) => p.id === pinId)) ?? this.allPins().find((p) => p.id === pinId);
  }

  allPins(): Pin[] {
    const pins: Pin[] = [];
    for (const c of this.components.values()) {
      pins.push(...Object.values(c.pins));
    }
    return pins;
  }

  /**
   * Resolve which pins share an electrical net.
   *
   * Two pins are on the same net if:
   *  - a wire directly connects them, or
   *  - they both belong to power sources / labels with the same reserved
   *    global name ("VCC", "GND"), or
   *  - they both belong to `label` components with the same name (a
   *    same-named label ties nets together without drawing a wire, mirroring
   *    the reference simulator's "Label (net)" primitive), or
   *  - a closed `switch` / `buspass` pole merges its two pins (pass topology).
   */
  computeNets(): NetMap {
    // Same shared structure-version cache flatten() uses (see hierarchy.ts)
    // — kept per-instance here rather than in a module-level WeakMap since
    // the method already has a natural cache key sitting right there in
    // `this`. Safe for a genuinely mutable, user-edited Circuit (any
    // addComponent/addWire/etc bumps the shared counter, invalidating this)
    // and free for flatten()'s own cached, never-mutated-after-construction
    // output — a second call for the *same* flattened Circuit object
    // (extremely common: main.ts's frame() and every test's tick() both
    // call flatten() then computeNets() every single tick) hits this cache
    // outright, since nothing bumped the counter in between.
    const version = currentStructureVersion();
    if (this.netsCache && this.netsCache.version === version) return this.netsCache.result;

    const uf = new UnionFind();
    const pins = this.allPins();
    for (const p of pins) uf.find(p.id); // register every pin, even isolated ones

    for (const w of this.wires.values()) uf.union(w.a, w.b);

    // Named ties: global VCC/GND rails, and same-named labels.
    const byName = new Map<string, string[]>();
    for (const c of this.components.values()) {
      let name: string | undefined;
      let pinId: string | undefined;
      if (c.kind === 'source') {
        name = c.value === 1 ? 'VCC' : 'GND';
        pinId = c.pins.out.id;
      } else if (c.kind === 'label') {
        name = GLOBAL_NET_NAMES.has(c.name) ? c.name : `label:${c.name}`;
        pinId = c.pins.net.id;
      }
      if (name && pinId) {
        const list = byName.get(name);
        if (list) list.push(pinId);
        else byName.set(name, [pinId]);
      }
    }
    for (const list of byName.values()) {
      for (let i = 1; i < list.length; i++) {
        uf.union(list[0] as string, list[i] as string);
      }
    }

    // Pass switches: closed poles merge a↔b (topology, not drivers).
    for (const c of this.components.values()) {
      if (c.kind === 'switch' && c.closed) {
        uf.union(c.pins.in.id, c.pins.out.id);
      } else if (c.kind === 'buspass') {
        for (let i = 0; i < c.bitWidth; i++) {
          if (((c.closed >> i) & 1) === 0) continue;
          const a = c.pins[`a${i}`];
          const b = c.pins[`b${i}`];
          if (a && b) uf.union(a.id, b.id);
        }
      }
    }

    const groups = uf.groups();
    // Map UF root → preferred net name in O(|byName|), not O(|groups|×|byName|).
    // Z80 place/fold hits ~12k groups × ~1k labels otherwise (~1.3s of fold).
    const rootToName = new Map<string, string>();
    for (const [name, list] of byName) {
      if (list.length > 0) rootToName.set(uf.find(list[0] as string), name);
    }
    const netOf = new Map<string, string>();
    const pinsOf = new Map<string, string[]>();
    for (const [root, members] of groups) {
      // Prefer a stable, readable net id: a global/named net keeps its name.
      const netId = rootToName.get(root) ?? root;
      pinsOf.set(netId, members);
      for (const m of members) netOf.set(m, netId);
    }

    const result: NetMap = { netOf, pinsOf };
    this.netsCache = { version, result };
    return result;
  }
}
