// Turns raw vision/engine output into what a player at a given assistance
// level actually gets to see. The rule: help people *see* the position, never
// tell them what to play.
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js'
import type { DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import { type Analysis, type Engine, winningChances } from './engine'
import { controlMap, hangingPieces, loosePieces, newAttacks, nullMoveFen, other, pins } from './vision'

export type Level = 0 | 1 | 2 | 3

export const LEVELS: { id: Level; name: string; blurb: string }[] = [
  { id: 0, name: 'Unassisted', blurb: 'Plain chess.' },
  {
    id: 1,
    name: 'Seatbelt',
    blurb: 'Your hanging pieces glow red, and arrows show what the opponent’s last move attacks.',
  },
  {
    id: 2,
    name: 'GM Vision',
    blurb:
      'Seatbelt, plus the opponent’s threat (what they’d do if you passed), hanging and loose pieces on both sides, pins, and an optional control heatmap.',
  },
  {
    id: 3,
    name: 'Guardian',
    blurb: 'GM Vision, plus a blunder guard that stops a game-losing move. It has a limited number of shields per game.',
  },
]

export type Layer = 'hanging' | 'attacks' | 'threat' | 'targets' | 'loose' | 'pins' | 'heatmap'

export const LAYERS: { id: Layer; label: string; level: Level; defaultOn: boolean }[] = [
  { id: 'hanging', label: 'My hanging pieces', level: 1, defaultOn: true },
  { id: 'attacks', label: 'New attacks', level: 1, defaultOn: true },
  { id: 'threat', label: 'Opponent’s threat', level: 2, defaultOn: true },
  { id: 'targets', label: 'Their hanging pieces', level: 2, defaultOn: true },
  { id: 'loose', label: 'Loose pieces', level: 2, defaultOn: true },
  { id: 'pins', label: 'Pins', level: 2, defaultOn: true },
  { id: 'heatmap', label: 'Control heatmap', level: 2, defaultOn: false },
]

export interface Insight {
  severity: 'high' | 'med' | 'low'
  text: string
}

export interface Overlay {
  shapes: DrawShape[]
  squares: Map<Key, string>
  insights: Insight[]
}

export const NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

/** Engine search used for threats and the blunder guard (shared so results are cached). */
export const ASSIST_GO = 'depth 14'

export function uciToSan(fen: string, uci: string): string {
  try {
    const board = new Chess(fen, { skipValidation: true })
    return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
  } catch {
    return uci
  }
}

function addClass(map: Map<Key, string>, sq: Square, cls: string) {
  map.set(sq, map.has(sq) ? `${map.get(sq)} ${cls}` : cls)
}

export interface StaticInput {
  fen: string
  viewer: Color
  level: Level
  layers: Set<Layer>
  /** The last move, if it was the opponent's. */
  lastMove?: { before: string; from: Square; to: Square; flags: string }
}

/** Everything that can be shown instantly, without the engine. */
export function staticOverlay({ fen, viewer, level, layers, lastMove }: StaticInput): Overlay {
  const out: Overlay = { shapes: [], squares: new Map(), insights: [] }
  if (level === 0) return out
  const on = (l: Layer) => layers.has(l) && LAYERS.find((x) => x.id === l)!.level <= level
  const them = other(viewer)
  const board = new Chess(fen, { skipValidation: true })
  const mine = hangingPieces(fen, viewer)
  const hangingSet = new Set(mine.map((h) => h.square))

  if (on('hanging')) {
    for (const h of mine) {
      addClass(out.squares, h.square, 'as-hang')
      out.insights.push({ severity: 'high', text: `Your ${NAMES[h.type]} on ${h.square} is hanging (−${h.loss})` })
    }
  }

  if (on('attacks') && lastMove) {
    const attacks = newAttacks(lastMove.before, fen, lastMove, viewer).filter((a) => {
      const t = board.get(a.to)!.type
      return t !== 'p' || hangingSet.has(a.to)
    })
    const byAttacker = new Map<Square, Square[]>()
    for (const a of attacks) {
      byAttacker.set(a.from, [...(byAttacker.get(a.from) ?? []), a.to])
      out.shapes.push({ orig: a.from, dest: a.to, brush: 'attack' })
    }
    for (const [from, targets] of byAttacker) {
      const fork = targets.length > 1
      // A lone attack on something already flagged as hanging is said once, above.
      if (!fork && on('hanging') && hangingSet.has(targets[0])) continue
      const attacker = NAMES[board.get(from)!.type]
      const names = targets.map((t) => `${NAMES[board.get(t)!.type]} (${t})`)
      out.insights.push({
        severity: fork || targets.some((t) => hangingSet.has(t) || board.get(t)!.type === 'k') ? 'high' : 'med',
        text: `${fork ? 'Fork! ' : ''}Their ${attacker} on ${from} now attacks your ${names.join(' and ')}`,
      })
    }
  }

  if (on('targets')) {
    for (const h of hangingPieces(fen, them)) {
      addClass(out.squares, h.square, 'as-target')
      out.insights.push({ severity: 'med', text: `Their ${NAMES[h.type]} on ${h.square} is hanging (+${h.loss})` })
    }
  }

  if (on('loose')) {
    for (const p of loosePieces(fen, viewer)) {
      if (hangingSet.has(p.square)) continue
      addClass(out.squares, p.square, 'as-loose')
    }
    for (const p of loosePieces(fen, them)) addClass(out.squares, p.square, 'as-loose-them')
  }

  if (on('pins')) {
    for (const color of [viewer, them]) {
      const seen = new Set<Square>()
      // Absolute pins first, so a piece pinned two ways is described by the one that matters.
      for (const pin of pins(fen, color).sort((a, b) => Number(b.absolute) - Number(a.absolute))) {
        if (seen.has(pin.pinned)) continue
        seen.add(pin.pinned)
        addClass(out.squares, pin.pinned, 'as-pinned')
        out.shapes.push({ orig: pin.by, dest: pin.to, brush: 'pin' })
        const whose = color === viewer ? 'Your' : 'Their'
        const piece = NAMES[board.get(pin.pinned)!.type]
        const behind = NAMES[board.get(pin.to)!.type]
        out.insights.push({
          severity: color === viewer ? 'med' : 'low',
          text: `${whose} ${piece} on ${pin.pinned} is pinned to the ${behind}${pin.absolute && piece !== 'pawn' ? ' (can’t move)' : ''}`,
        })
      }
    }
  }

  if (on('heatmap')) {
    for (const [sq, net] of controlMap(fen)) {
      const forMe = viewer === 'w' ? net : -net
      const strength = Math.min(3, Math.abs(forMe))
      addClass(out.squares, sq, `ctl-${forMe > 0 ? 'me' : 'them'}${strength}`)
    }
  }

  const rank = { high: 0, med: 1, low: 2 }
  out.insights.sort((a, b) => rank[a.severity] - rank[b.severity])
  return out
}

export interface Threat {
  uci: string
  san: string
  mate?: number
  /** Drop in the viewer's winning chances (-1..1 scale) if they ignore it. */
  swing: number
  /** What it captures, if anything. */
  captures?: PieceSymbol
}

/**
 * What the opponent would do if the viewer passed. Only reported when it
 * actually matters, so a quiet position shows no arrow.
 */
export async function findThreat(engine: Engine, fen: string): Promise<Threat | null> {
  const board = new Chess(fen)
  if (board.isCheck() || board.isGameOver()) return null
  const nullFen = nullMoveFen(fen)
  const [now, passed] = await Promise.all([engine.analyse(fen, ASSIST_GO), engine.analyse(nullFen, ASSIST_GO)])
  if (!passed.bestmove) return null
  const swing = winningChances(passed.cp) - winningChances(-now.cp)
  const mate = passed.mate && passed.mate > 0 ? passed.mate : undefined
  if (!mate && swing < 0.15) return null
  const captures = board.get(passed.bestmove.slice(2, 4) as Square)?.type
  return { uci: passed.bestmove, san: uciToSan(nullFen, passed.bestmove), mate, swing, captures }
}

export function threatOverlay(t: Threat): Overlay {
  const what = t.mate
    ? `mate in ${t.mate}`
    : `${t.captures ? `takes your ${NAMES[t.captures]}, ` : ''}${t.swing >= 0.5 ? 'decisive' : t.swing >= 0.3 ? 'serious' : 'worth watching'}`
  return {
    shapes: [{ orig: t.uci.slice(0, 2) as Key, dest: t.uci.slice(2, 4) as Key, brush: 'threat' }],
    squares: new Map(),
    insights: [{ severity: 'high', text: `Threat: they want ${t.san} (${what})` }],
  }
}

export interface Blunder {
  message: string
  refutation?: { uci: string; san: string }
}

/** Rough win probability (0-100) for a score from the side to move's view. */
const winPct = (cp: number) => Math.round(((winningChances(cp) + 1) / 2) * 100)

function describeLoss(before: Analysis, after: Analysis, afterBoard: Chess): string {
  if (after.mate && after.mate > 0) return `This allows mate in ${after.mate}.`
  if (afterBoard.isDraw() || (afterBoard.isGameOver() && !afterBoard.isCheckmate())) return 'This throws away a winning position into a draw.'
  if (before.mate && before.mate > 0) return 'This lets a forced mate slip away.'
  return `Your winning chances drop from about ${winPct(before.cp)}% to ${winPct(-after.cp)}%.`
}

/** Returns a description if playing fenBefore → fenAfter is a blunder (lichess threshold), else null. */
export async function checkBlunder(engine: Engine, fenBefore: string, fenAfter: string): Promise<Blunder | null> {
  const afterBoard = new Chess(fenAfter)
  if (afterBoard.isCheckmate()) return null
  const before = await engine.analyse(fenBefore, ASSIST_GO)
  const after: Analysis = afterBoard.isGameOver() ? { cp: 0, pv: [] } : await engine.analyse(fenAfter, ASSIST_GO)
  const loss = winningChances(before.cp) - winningChances(-after.cp)
  const allowsMate = after.mate !== undefined && after.mate > 0 && !(before.mate !== undefined && before.mate < 0)
  if (loss < 0.3 && !allowsMate) return null
  return {
    message: describeLoss(before, after, afterBoard),
    refutation: after.bestmove ? { uci: after.bestmove, san: uciToSan(fenAfter, after.bestmove) } : undefined,
  }
}
