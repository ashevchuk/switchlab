/**
 * Guided digital-lab curriculum ladder — ordered example ids with Next/Prev.
 */

export type LabCurriculumStep = {
  id: string;
  title: string;
  blurb: string;
  /** Optional checklist shown after the example loads. */
  checklist?: string[];
};

/** Ordered Soft Lab walkthrough from CMOS basics through contention + instruments. */
export const LAB_CURRICULUM: LabCurriculumStep[] = [
  {
    id: 'cmos-inverter',
    title: 'CMOS inverter',
    blurb: 'Single P+N stack — the transistor foundation.',
  },
  {
    id: 'd-latch',
    title: 'D latch',
    blurb: 'Transparent latch from gates — memory without Soft Lab.',
  },
  {
    id: 'lab-counter-7seg',
    title: 'Counter + 7-seg',
    blurb: 'COUNTER4 → BCD_7SEG with Soft Lab opaque eval.',
    checklist: [
      'Run Soft Lab on — counter should tick the display.',
      'Toggle Soft Lab off briefly to expand into transistors.',
      'Arm the analyzer on clk / q if you want edges.',
    ],
  },
  {
    id: 'lab-buf8-oe',
    title: 'Octal buffer (OE)',
    blurb: 'BUF8 tri-state drive — OE gates the bus.',
  },
  {
    id: 'lab-adder4',
    title: '4-bit adder',
    blurb: 'Build toward an ALU — ADDER4 sum/carry path.',
    checklist: [
      'Drive a[3:0] and b[3:0] from switches or hex bus switches.',
      'Watch sum and cout change combinatorially.',
      'Next step folds this into ALU4 ops.',
    ],
  },
  {
    id: 'lab-alu4',
    title: '4-bit ALU',
    blurb: 'Nibble ALU checklist — Soft Lab combinatorial.',
    checklist: [
      'Set op bits for ADD, then SUB / AND / OR.',
      'Confirm result hex matches hand math for a few vectors.',
      'Inspector → Force transistor expand to see gate flatten.',
      'Optional: poke Soft Lab off and compare settle time.',
    ],
  },
  {
    id: 'lab-alu8',
    title: '8-bit ALU',
    blurb: 'ALU8 byte datapath.',
  },
  {
    id: 'lab-soft-ram',
    title: 'Soft RAM 16×8',
    blurb: 'SOFT_RAM16 behavioral memory — Soft Lab only shell.',
    checklist: [
      'Write addr/data, pulse we, read back on q.',
      'Soft Lab must stay on — this chip has no transistor body.',
      'Use Watch / bus probe on the data bus.',
    ],
  },
  {
    id: 'lab-contend-bus',
    title: 'Bus contention',
    blurb: 'Two BUF8 on one bus — OE fight → contended nets.',
    checklist: [
      'Enable both OE drivers — status should show contended > 0.',
      'Click contended status to jump to the hot net.',
      'Drop one OE — contention clears.',
    ],
  },
  {
    id: 'lab-mini-cpu',
    title: 'Mini nibble CPU',
    blurb: 'PC + Soft RAM + ALU4 + ACC — Soft Lab datapath finale.',
    checklist: [
      'Pulse WE to write the hex prog switch into Soft RAM at PC.',
      'OE on reads RAM onto the ALU B nibble; WE ACC loads ALU→ACC.',
      'Watch PC / ACC bus probes while the clock runs.',
      'Inspector Soft Lab → Diff soft vs silicon on COUNTER/REG.',
    ],
  },
  {
    id: 'tiny-cpu-blink',
    title: 'Tiny CPU blinker',
    blurb: 'A CPU folded into one chip: PC, IR, ACC, ALU and FSM run a program from RAM.',
    checklist: [
      'Release RESET — the OUT0 LED blinks and the bus probe flips 0x00 / 0x01.',
      'Double-click the RAM, tick Follow PC and watch the disassembly track the program counter.',
      'Assemble loop: LDI 3 / OUT / LDI 0 / OUT / JMP loop — the bus now flips 0x00 / 0x03.',
      'Double-click TinyCPU to dive in: PC, IR, ACC, ALU, FSM, OUT and Control are separate chips.',
    ],
  },
  {
    id: 'lab-analyzer',
    title: 'Logic analyzer',
    blurb: 'Arm the LA, set trigger, export VCD/PNG.',
    checklist: [
      'Arm, capture a few edges, place dual cursors.',
      'Export VCD or PNG from the analyzer toolbar.',
    ],
  },
];
export function labCurriculumIndex(id: string): number {
  return LAB_CURRICULUM.findIndex((s) => s.id === id);
}

export function labCurriculumStep(index: number): LabCurriculumStep | null {
  if (index < 0 || index >= LAB_CURRICULUM.length) return null;
  return LAB_CURRICULUM[index]!;
}
