// Static board "vision": the stuff a strong player sees at a glance without
// calculating. None of this uses the engine; it only describes the position
// (what is attacked, what is loose, what is pinned), never what to play.
import { Chess, SQUARES, type Color, type PieceSymbol, type Square } from 'chess.js'

export const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w')

/** The same position with the other side to move (a "pass"). */
export function nullMoveFen(fen: string): string {
  const parts = fen.split(' ')
  parts[1] = parts[1] === 'w' ? 'b' : 'w'
  parts[3] = '-'
  return parts.join(' ')
}

function load(fen: string): Chess {
  return new Chess(fen, { skipValidation: true })
}

/**
 * Static exchange on `sq`: how much material `side` wins by starting a capture
 * sequence there, with both sides always recapturing with their cheapest piece
 * and free to stop. Mutates `board`. `firstFrom` restricts the opening capture
 * (used to drop captures that would be illegal because of a pin).
 */
function exchange(board: Chess, sq: Square, side: Color, firstFrom?: Set<Square>): number {
  const target = board.get(sq)
  if (!target) return 0
  let attackers = board.attackers(sq, side)
  if (firstFrom) attackers = attackers.filter((a) => firstFrom.has(a))
  if (attackers.length === 0) return 0
  attackers.sort((a, b) => VALUE[board.get(a)!.type] - VALUE[board.get(b)!.type])
  const from = attackers[0]
  const piece = board.get(from)!
  // A king can't capture onto a defended square.
  if (piece.type === 'k' && board.attackers(sq, other(side)).length > 0) return 0
  board.remove(from)
  board.remove(sq)
  board.put({ type: piece.type, color: side }, sq)
  return Math.max(0, VALUE[target.type] - exchange(board, sq, other(side)))
}

/** Squares from which `side` can legally capture on `sq` right now (as if it were their move). */
function legalCaptureOrigins(fen: string, sq: Square, side: Color): Set<Square> {
  const board = load(fen)
  const asMover = board.turn() === side ? board : load(nullMoveFen(fen))
  const origins = asMover
    .moves({ verbose: true })
    .filter((m) => m.to === sq && m.captured)
    .map((m) => m.from)
  return new Set(origins)
}

/** Material `attacker` wins by capturing on `sq` (0 if the piece there is safe). */
export function seeGain(fen: string, sq: Square, attacker: Color): number {
  return exchange(load(fen), sq, attacker, legalCaptureOrigins(fen, sq, attacker))
}

export interface PieceRef {
  square: Square
  type: PieceSymbol
  color: Color
}

function piecesOf(board: Chess, color: Color): PieceRef[] {
  const out: PieceRef[] = []
  for (const row of board.board()) {
    for (const p of row) if (p && p.color === color) out.push({ square: p.square, type: p.type, color: p.color })
  }
  return out
}

export interface Hanging extends PieceRef {
  /** Material the opponent nets by taking it. */
  loss: number
}

/** Pieces of `color` that the opponent can win material from by capturing. */
export function hangingPieces(fen: string, color: Color): Hanging[] {
  const board = load(fen)
  return piecesOf(board, color)
    .filter((p) => p.type !== 'k')
    .map((p) => ({ ...p, loss: seeGain(fen, p.square, other(color)) }))
    .filter((p) => p.loss > 0)
    .sort((a, b) => b.loss - a.loss)
}

/** Non-pawn pieces of `color` with no defenders ("loose pieces drop off"). */
export function loosePieces(fen: string, color: Color): PieceRef[] {
  const board = load(fen)
  return piecesOf(board, color).filter(
    (p) => p.type !== 'k' && p.type !== 'p' && board.attackers(p.square, color).length === 0,
  )
}

export interface Pin {
  pinned: Square
  by: Square
  /** The piece behind the pinned one. */
  to: Square
  /** Pinned to the king, so it can't legally move off the line. */
  absolute: boolean
}

const FILES = 'abcdefgh'
const sqAt = (f: number, r: number) => `${FILES[f]}${r + 1}` as Square
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]]

/**
 * Pins against `color`'s pieces. Relative pins only count when they'd actually
 * cost material: a non-pawn screening something more valuable that the pinner
 * could win (worth more than the pinner, or undefended).
 */
export function pins(fen: string, color: Color): Pin[] {
  const board = load(fen)
  const out: Pin[] = []
  for (const slider of piecesOf(board, other(color))) {
    const dirs =
      slider.type === 'r' ? ROOK_DIRS : slider.type === 'b' ? BISHOP_DIRS : slider.type === 'q' ? [...ROOK_DIRS, ...BISHOP_DIRS] : []
    for (const [df, dr] of dirs) {
      let f = FILES.indexOf(slider.square[0]) + df
      let r = Number(slider.square[1]) - 1 + dr
      const hits: PieceRef[] = []
      while (f >= 0 && f < 8 && r >= 0 && r < 8 && hits.length < 2) {
        const p = board.get(sqAt(f, r))
        if (p) hits.push({ square: sqAt(f, r), type: p.type, color: p.color })
        f += df
        r += dr
      }
      if (hits.length < 2) continue
      const [front, back] = hits
      if (front.color !== color || back.color !== color || front.type === 'k') continue
      const absolute = back.type === 'k'
      const costly =
        front.type !== 'p' &&
        VALUE[back.type] > VALUE[front.type] &&
        (VALUE[back.type] > VALUE[slider.type] || board.attackers(back.square, color).length === 0)
      if (absolute || costly) {
        out.push({ pinned: front.square, by: slider.square, to: back.square, absolute })
      }
    }
  }
  return out
}

export interface Attack {
  from: Square
  to: Square
}

/**
 * Attacks on `victim`'s pieces that didn't exist before the opponent's last move,
 * including discovered attacks. `move` is the move that turned `beforeFen` into `afterFen`.
 */
export function newAttacks(
  beforeFen: string,
  afterFen: string,
  move: { from: Square; to: Square; flags?: string },
  victim: Color,
): Attack[] {
  const before = load(beforeFen)
  const after = load(afterFen)
  const attacker = other(victim)
  // Where each attacking piece from `before` ended up.
  const moved = new Map<Square, Square>([[move.from, move.to]])
  if (move.flags?.includes('k') || move.flags?.includes('q')) {
    const rank = attacker === 'w' ? '1' : '8'
    const kingside = move.flags.includes('k')
    moved.set(`${kingside ? 'h' : 'a'}${rank}` as Square, `${kingside ? 'f' : 'd'}${rank}` as Square)
  }
  const out: Attack[] = []
  for (const p of piecesOf(after, victim)) {
    const was = new Set(before.attackers(p.square, attacker).map((s) => moved.get(s) ?? s))
    for (const from of after.attackers(p.square, attacker)) {
      if (!was.has(from)) out.push({ from, to: p.square })
    }
  }
  return out
}

/** Per square: (white attackers) - (black attackers). */
export function controlMap(fen: string): Map<Square, number> {
  const board = load(fen)
  const out = new Map<Square, number>()
  for (const sq of SQUARES) {
    const net = board.attackers(sq, 'w').length - board.attackers(sq, 'b').length
    if (net !== 0) out.set(sq, net)
  }
  return out
}
