/**
 * Z80-native command monitor ROM — real opcodes at RAM 0x000.
 * Typed on the TTY canvas (not the host Cmd box): H / M / W / G.
 *
 * Memory: code @ 0000, line buffer @ 0xD00 (32 B), stack @ 0xDFF. The framebuffer
 * and keyboard registers follow the machine's I/O layout: 12-bit RAM has FB @ 0xE00 and
 * KEY_* @ 0xF00, 64K RAM has FB @ 0xF000 and KEY_* @ 0xF100. Keep user programs at ≥ 0x200.
 *
 * Assembled once at module load via the mini assembler.
 */

import { assemble } from './assembler.js';
import { MACHINE_ADDR_BITS, softIoLayoutForAddrBits, softIoLayoutForRam, type SoftIoLayout } from './memoryMap.js';

/** LINEBUF base — keep in sync with COMMAND_ROM_SOURCE. */
export const CMD_LINEBUF = 0xd00;
export const CMD_STACK = 0xdff;

/**
 * Listing (high level):
 *   cold: SP=DFF, FB cursor, print '>'
 *   main: read line into D00 (echo + BS), dispatch H/M/W/G, loop
 *   H — help string to FB
 *   M aaaa [nn] — hex dump (default 8, max 16)
 *   W aaaa bb.. — poke bytes
 *   G aaaa — JP aaaa
 */
const COMMAND_ROM_BODY = `
; Z80 command monitor — origin 0
cold:
  LD SP,0xDFF
  LD HL,FB_BASE
  CALL put_prompt
main:
  CALL read_line
  CALL do_cmd
  JR main

put_prompt:
  LD A,'>'
  CALL putch
  LD A,' '
  CALL putch
  RET

; ---- keyboard / line edit ----
; Out: LINEBUF filled, NUL-terminated; HL = FB cursor
read_line:
  LD DE,0xD00
  XOR A
  LD (DE),A
rl_poll:
  LD A,(KEY_STATUS)
  CP 1
  JR NZ,rl_poll
  LD A,(KEY_DATA)
  LD B,A
  XOR A
  LD (KEY_STATUS),A
  LD A,B
  CP 0x0D
  JR Z,rl_cr
  CP 0x08
  JR Z,rl_bs
  ; printable → buf + FB (cap 31)
  PUSH HL
  LD HL,0xD00
  LD A,E
  SUB L
  CP 31
  POP HL
  JR NC,rl_poll
  LD A,B
  LD (DE),A
  INC DE
  XOR A
  LD (DE),A
  LD A,B
  CALL putch
  JR rl_poll
rl_bs:
  LD A,E
  CP 0x00
  JR NZ,rl_bs_do
  LD A,D
  CP 0x0D
  JR Z,rl_poll
rl_bs_do:
  DEC DE
  XOR A
  LD (DE),A
  CALL backspace_fb
  JR rl_poll
rl_cr:
  CALL newline
  RET

; ---- dispatch ----
do_cmd:
  LD DE,0xD00
  CALL skip_sp
  LD A,(DE)
  OR A
  RET Z
  CALL upcase
  INC DE
  CP 'H'
  JP Z,cmd_h
  CP 'M'
  JP Z,cmd_m
  CP 'W'
  JP Z,cmd_w
  CP 'G'
  JP Z,cmd_g
  LD A,'?'
  CALL putch
  CALL newline
  CALL put_prompt
  RET

cmd_h:
  LD DE,help_msg
  CALL puts
  CALL put_prompt
  RET

cmd_m:
  CALL skip_sp
  CALL parse_hex16
  JP C,cmd_err
  PUSH HL
  CALL skip_sp
  LD A,(DE)
  OR A
  JR Z,cmd_m_def
  CALL parse_hex16
  JP C,cmd_m_bad
  LD A,L
  JR cmd_m_len
cmd_m_def:
  LD A,8
cmd_m_len:
  CP 17
  JR C,cmd_m_ok
  LD A,16
cmd_m_ok:
  LD B,A
  POP HL
  ; print addr:
  PUSH BC
  PUSH HL
  LD A,H
  CALL put_hex
  LD A,L
  CALL put_hex
  LD A,':'
  CALL putch
  LD A,' '
  CALL putch
  POP HL
  POP BC
cmd_m_loop:
  LD A,B
  OR A
  JR Z,cmd_m_done
  LD A,(HL)
  CALL put_hex
  LD A,' '
  CALL putch
  INC HL
  DEC B
  JR cmd_m_loop
cmd_m_done:
  CALL newline
  CALL put_prompt
  RET
cmd_m_bad:
  POP HL
cmd_err:
  LD A,'!'
  CALL putch
  CALL newline
  CALL put_prompt
  RET

cmd_w:
  CALL skip_sp
  CALL parse_hex16
  JP C,cmd_err
  ; HL = dest
cmd_w_loop:
  CALL skip_sp
  LD A,(DE)
  OR A
  JR Z,cmd_w_done
  PUSH HL
  CALL parse_hex8
  JP C,cmd_w_fail
  LD A,L
  POP HL
  LD (HL),A
  INC HL
  JR cmd_w_loop
cmd_w_fail:
  POP HL
  JP cmd_err
cmd_w_done:
  CALL put_prompt
  RET

cmd_g:
  CALL skip_sp
  CALL parse_hex16
  JP C,cmd_err
  JP (HL)

; ---- parse ----
; DE→text; out HL=value, DE advanced; C=1 on error
parse_hex16:
  LD HL,0
  LD B,0
ph16_loop:
  LD A,(DE)
  CALL is_hex
  JR C,ph16_end
  INC DE
  INC B
  CALL hex_val
  ; HL = HL*16 + A
  PUSH AF
  ADD HL,HL
  ADD HL,HL
  ADD HL,HL
  ADD HL,HL
  POP AF
  LD C,A
  LD A,L
  ADD A,C
  LD L,A
  JR NC,ph16_loop
  INC H
  JR ph16_loop
ph16_end:
  LD A,B
  OR A
  JR NZ,ph16_ok
  SCF
  RET
ph16_ok:
  OR A
  RET

; 1–2 hex digits → L (H cleared). C on error
parse_hex8:
  CALL parse_hex16
  RET C
  LD A,H
  OR A
  JR Z,ph8_ok
  SCF
  RET
ph8_ok:
  OR A
  RET

skip_sp:
  LD A,(DE)
  CP ' '
  RET NZ
  INC DE
  JR skip_sp

upcase:
  CP 'a'
  RET C
  CP 0x7B
  RET NC
  SUB 32
  RET

; A char → C clear if hex; else C set (does not convert value)
is_hex:
  CALL upcase
  CP '0'
  RET C
  CP 0x3A
  JR C,is_hex_ok
  CP 'A'
  RET C
  CP 0x47
  JR C,is_hex_ok
  SCF
  RET
is_hex_ok:
  OR A
  RET

; A ascii hex → A value 0..15 (caller checked)
hex_val:
  CALL upcase
  CP 'A'
  JR NC,hex_val_af
  SUB '0'
  RET
hex_val_af:
  SUB 'A'
  ADD A,10
  RET

; ---- FB output ----
; A char → (HL)+, wrap at the end of the framebuffer
putch:
  LD (HL),A
  INC HL
  LD A,H
  CP FB_END_HI
  RET C
  LD HL,FB_BASE
  RET

newline:
  LD A,L
  AND 0xE0
  ADD A,0x20
  LD L,A
  JR NC,nl_ok
  INC H
nl_ok:
  LD A,H
  CP FB_END_HI
  RET C
  LD HL,FB_BASE
  RET

backspace_fb:
  LD A,L
  CP 0
  JR NZ,bs_do
  LD A,H
  CP FB_BASE_HI
  RET Z
bs_do:
  DEC HL
  LD (HL),0x20
  RET

puts:
  LD A,(DE)
  OR A
  RET Z
  CALL putch
  INC DE
  JR puts

put_hex:
  PUSH AF
  RRCA
  RRCA
  RRCA
  RRCA
  CALL put_nib
  POP AF
put_nib:
  AND 0x0F
  CP 10
  JR C,put_nib_d
  ADD A,55
  JR putch
put_nib_d:
  ADD A,48
  JR putch

help_msg:
  DB "H M addr [n]  W addr bb..  G addr",0
`;

function commandRomSource(layout: SoftIoLayout): string {
  const hex = (n: number): string => `0x${n.toString(16).toUpperCase()}`;
  return [
    `EQU FB_BASE,${hex(layout.fbBase)}`,
    `EQU FB_BASE_HI,${hex(layout.fbBase >> 8)}`,
    `EQU FB_END_HI,${hex(layout.fbEnd >> 8)}`,
    `EQU KEY_STATUS,${hex(layout.keyStatus)}`,
    `EQU KEY_DATA,${hex(layout.keyData)}`,
    COMMAND_ROM_BODY,
  ].join('\n');
}

/** The 12-bit machine's source; kept as the reference listing. */
export const COMMAND_ROM_SOURCE = commandRomSource(softIoLayoutForAddrBits(MACHINE_ADDR_BITS));

function buildCommandRom(layout: SoftIoLayout): Uint8Array {
  const r = assemble(commandRomSource(layout), 0);
  if (!r.ok) {
    throw new Error(`command ROM assemble failed:\n${r.errors.join('\n')}`);
  }
  if (r.bytes.length === 0) throw new Error('command ROM empty');
  if (r.bytes.length > CMD_LINEBUF) {
    throw new Error(`command ROM too large (${r.bytes.length} > ${CMD_LINEBUF})`);
  }
  return r.bytes;
}

export const COMMAND_ROM_BYTES = buildCommandRom(softIoLayoutForAddrBits(MACHINE_ADDR_BITS));

const imageByAddrBits = new Map<number, Uint8Array>();

/** The command ROM for a machine with this many address bits (12 = 4K map, 16 = 64K map). */
export function commandRomFor(addrBits: number): Uint8Array {
  const layout = softIoLayoutForAddrBits(addrBits);
  let image = imageByAddrBits.get(layout.addrBits);
  if (!image) {
    image = layout.addrBits === MACHINE_ADDR_BITS ? COMMAND_ROM_BYTES : buildCommandRom(layout);
    imageByAddrBits.set(layout.addrBits, image);
  }
  return image;
}

export function commandRomHexPrompt(addrBits: number = MACHINE_ADDR_BITS): string {
  return [...commandRomFor(addrBits)].map((b) => b.toString(16).padStart(2, '0')).join(',');
}

export function loadCommandRom(bytes: Uint8Array): void {
  const image = commandRomFor(softIoLayoutForRam(bytes).addrBits);
  if (bytes.length < image.length) {
    throw new RangeError(`RAM too small for command ROM (${bytes.length} < ${image.length})`);
  }
  bytes.set(image, 0);
}
