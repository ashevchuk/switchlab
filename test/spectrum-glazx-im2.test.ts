import { describe, expect, it } from 'vitest';
import { SpectrumEngine } from '../src/machine/spectrum/engine.js';
import { decodeSpectrumGame, findSpectrumGame } from '../src/machine/spectrum/gamesData.js';
import { spectrumBasicAcceptsKeys } from '../src/machine/spectrum/ready.js';

function run(eng: SpectrumEngine, n: number) {
  for (let i = 0; i < n; i++) eng.tickFrame(false);
}
function pulse(eng: SpectrumEngine, k: string) {
  eng.setKey(k, true); run(eng, 5); eng.setKey(k, false); run(eng, 3);
}
function typeLoad(eng: SpectrumEngine) {
  eng.ula.clearKeys(); run(eng, 2);
  pulse(eng, 'J');
  eng.setKey('Sym', true); run(eng, 2); pulse(eng, 'P'); eng.setKey('Sym', false); run(eng, 3);
  eng.setKey('Sym', true); run(eng, 2); pulse(eng, 'P'); eng.setKey('Sym', false); run(eng, 3);
  pulse(eng, 'Enter');
}

describe('GLAZX IM2 gameplay', () => {
  it('does not freeze at HALT PC=b3cd after starting a match', () => {
    const eng = new SpectrumEngine();
    eng.mountTap(decodeSpectrumGame(findSpectrumGame('glazx')!), true);
    eng.running = true;
    for (let i = 0; i < 1200; i++) {
      eng.tickFrame(false);
      if (spectrumBasicAcceptsKeys(eng.cpu, '48')) break;
    }
    typeLoad(eng);
    for (let i = 0; i < 4000; i++) {
      eng.tickFrame(false);
      if (eng.tape && eng.tape.remaining === 0 && eng.tape.pos >= eng.tape.blocks.length) break;
    }
    // Navigate into gameplay (same path that previously stuck)
    eng.setKey('Space', true); run(eng, 40); eng.setKey('Space', false); run(eng, 20);
    for (const k of ['Enter', '0', '1']) {
      pulse(eng, k);
      run(eng, 40);
    }
    expect(eng.cpu.im).toBe(2);
    // Previously: 300 frames stuck at b3cd HALT with irqPending
    const pcs = new Set<number>();
    let haltStuck = 0;
    for (let i = 0; i < 120; i++) {
      eng.tickFrame(false);
      const pc = eng.cpu.pc & 0xffff;
      pcs.add(pc);
      if (pc === 0xb3cd && eng.cpu.halted) haltStuck++;
    }
    expect(haltStuck).toBeLessThan(100);
    expect(pcs.size).toBeGreaterThan(1);
    expect(eng.softError).toBeNull();
  }, 60_000);
});
