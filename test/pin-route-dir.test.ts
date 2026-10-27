import { describe, expect, it } from 'vitest';
import alu8 from '../examples/lab-alu8.json';
import { deserializeProject } from '../src/sim/serialize.js';
import { Editor } from '../src/ui/Editor.js';
import { pathOverlapLength, pinRouteDir, wirePolyline } from '../src/ui/geometry.js';

describe('package pin exit direction', () => {
  it('leaves a tall chip horizontally from every pin, including those near its top corner', () => {
    const { topCircuit } = deserializeProject(structuredClone(alu8) as Parameters<typeof deserializeProject>[0]);
    const chip = [...topCircuit.components.values()].find((c) => c.kind === 'chip')!;
    const pins = topCircuit.allPins().filter((p) => p.componentId === chip.id);
    expect(pins.length).toBeGreaterThan(8);
    for (const p of pins) {
      expect(pinRouteDir(p.pos, chip), `${p.name} on a tall chip`).toBe(p.pos.x < chip.pos.x ? 'W' : 'E');
    }
  });

  it('tidying the ALU8 lab leaves no different-net wires running on each other', () => {
    const { topCircuit, library } = deserializeProject(structuredClone(alu8) as Parameters<typeof deserializeProject>[0]);
    const editor = new Editor(topCircuit, library);
    editor.tidyAllWires(false);
    const nets = topCircuit.computeNets();
    const wires = [...topCircuit.wires.values()];
    const paths = wires.map((w) => wirePolyline(topCircuit, w)!);
    let overlap = 0;
    wires.forEach((w, i) => {
      const others = wires.flatMap((o, j) => (j !== i && nets.netOf.get(o.a) !== nets.netOf.get(w.a) ? [paths[j]!] : []));
      overlap += pathOverlapLength(paths[i]!, others);
    });
    expect(overlap).toBe(0);
  });
});
