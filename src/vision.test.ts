import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { controlMap, hangingPieces, loosePieces, newAttacks, pins, seeGain } from './vision'

describe('seeGain / hangingPieces', () => {
  it('knight attacked by a pawn hangs even though it is defended', () => {
    const fen = 'rnbqkb1r/pppppppp/5n2/4P3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2'
    expect(seeGain(fen, 'f6', 'w')).toBe(2)
    expect(hangingPieces(fen, 'b').map((h) => h.square)).toEqual(['f6'])
  })

  it('an equal trade is not hanging', () => {
    // Nc3 and Nd5 attack each other; both defended by pawns.
    const fen = '4k3/8/4p3/3n4/8/2N5/1P6/4K3 w - - 0 1'
    expect(seeGain(fen, 'd5', 'w')).toBe(0)
    expect(seeGain(fen, 'c3', 'b')).toBe(0)
  })

  it('an undefended piece attacked by anything hangs', () => {
    const fen = '4k3/8/8/3b4/8/8/3Q4/4K3 b - - 0 1'
    expect(hangingPieces(fen, 'b')).toEqual([{ square: 'd5', type: 'b', color: 'b', loss: 3 }])
  })

  it('counts x-ray defenders behind a battery', () => {
    // Doubled white rooks vs Re5 defended by Re8: Rxe5 Rxe5 Rxe5 nets a rook.
    const fen = '4r1k1/8/8/4r3/8/8/4R3/4R1K1 w - - 0 1'
    expect(seeGain(fen, 'e5', 'w')).toBe(5)
  })

  it('a pinned piece cannot start the capture', () => {
    // Ba5 pins Nc3 to Ke1; the undefended rook on d5 is "attacked" by the knight but safe.
    const fen = '6k1/8/8/b2r4/8/2N5/8/4K3 b - - 0 1'
    expect(seeGain(fen, 'd5', 'w')).toBe(0)
  })

  it('a king cannot capture a defended piece', () => {
    const fen = '6k1/8/8/8/8/8/3b4/4K3 w - - 0 1'
    expect(seeGain(fen, 'd2', 'w')).toBe(3)
    const defended = '6k1/8/8/8/8/1n6/3b4/4K3 w - - 0 1' // Nb3 defends d2
    expect(seeGain(defended, 'd2', 'w')).toBe(0)
  })
})

describe('loosePieces', () => {
  it('finds undefended minor pieces and ignores pawns and kings', () => {
    const fen = '4k3/8/8/3b4/8/2N5/1P1P4/4K3 w - - 0 1'
    expect(loosePieces(fen, 'b').map((p) => p.square)).toEqual(['d5'])
    expect(loosePieces(fen, 'w').map((p) => p.square)).toEqual([])
  })
})

describe('pins', () => {
  it('detects absolute pins', () => {
    const fen = '4k3/8/8/b7/8/2N5/8/4K3 w - - 0 1'
    expect(pins(fen, 'w')).toEqual([{ pinned: 'c3', by: 'a5', to: 'e1', absolute: true }])
  })

  it('detects relative pins only when the piece behind is worth more', () => {
    const toQueen = '4k3/8/8/b7/8/2N5/3Q4/4K3 w - - 0 1'
    expect(pins(toQueen, 'w')).toEqual([{ pinned: 'c3', by: 'a5', to: 'd2', absolute: false }])
    const toPawn = '4k3/8/8/b7/8/2N5/3P4/K7 w - - 0 1'
    expect(pins(toPawn, 'w')).toEqual([])
  })

  it('ignores relative pins that cost nothing', () => {
    // Qg5 "pins" the d2 pawn to the defended Bc1: noise, not a pin worth showing.
    const fen = 'r1b1kbnr/pppp1ppp/8/4N1q1/2BnP3/8/PPPP1PPP/RNBQK2R w KQkq - 2 5'
    expect(pins(fen, 'w')).toEqual([])
    // Bb5 pinning Nc6 to an undefended rook e8 is real.
    expect(pins('4r1k1/8/2n5/1B6/8/8/8/6K1 b - - 0 1', 'b')).toEqual([{ pinned: 'c6', by: 'b5', to: 'e8', absolute: false }])
  })
})

describe('newAttacks', () => {
  it('reports nothing when the move attacks nothing new', () => {
    const game = new Chess('4k3/8/8/8/2n5/8/8/R3K3 b - - 0 1')
    const before = game.fen()
    const move = game.move('Nb6')
    expect(newAttacks(before, game.fen(), move, 'w')).toEqual([])
  })

  it('finds a knight fork', () => {
    const game = new Chess('4k3/8/8/8/8/8/3n3Q/R3K3 b - - 0 1')
    const before = game.fen()
    const move = game.move('Nf3+')
    expect(newAttacks(before, game.fen(), move, 'w')).toEqual(
      expect.arrayContaining([
        { from: 'f3', to: 'e1' },
        { from: 'f3', to: 'h2' },
      ]),
    )
  })

  it('does not re-report an attack the moving piece already had', () => {
    // Rook slides along the a-file and still attacks the knight on a1... from a new square.
    const game = new Chess('r3k3/8/8/8/8/8/8/N3K3 b - - 0 1')
    const before = game.fen()
    const move = game.move('Ra5')
    expect(newAttacks(before, game.fen(), move, 'w')).toEqual([])
  })

  it('detects discovered attacks', () => {
    // Bishop b7 sits behind the knight on d5, aimed at the rook on h1.
    const game = new Chess('4k3/1b6/8/3n4/8/8/8/K6R b - - 0 1')
    const before = game.fen()
    const move = game.move('Nc3')
    expect(newAttacks(before, game.fen(), move, 'w')).toContainEqual({ from: 'b7', to: 'h1' })
  })
})

describe('controlMap', () => {
  it('nets attackers per square', () => {
    const map = controlMap('4k3/8/8/8/8/8/8/R3K3 w - - 0 1')
    expect(map.get('a5')).toBe(1)
    expect(map.get('d8')).toBe(-1)
  })
})
