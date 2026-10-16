// Thin UCI wrapper around the single-threaded Stockfish WASM build, run in a
// Web Worker. Jobs are queued so callers can just `await engine.analyse(fen)`.

export interface Analysis {
  /** Centipawns from the side to move's point of view (mates mapped to ±100000). */
  cp: number
  /** Moves to mate (positive = side to move mates), if any. */
  mate?: number
  bestmove?: string
  pv: string[]
}

interface Job {
  fen: string
  go: string
  resolve: (a: Analysis) => void
}

const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`

export const MATE_CP = 100000

/** Lichess-style winning chances in [-1, 1]. */
export function winningChances(cp: number): number {
  const clamped = Math.max(-1000, Math.min(1000, cp))
  return 2 / (1 + Math.exp(-0.00368208 * clamped)) - 1
}

export class Engine {
  private worker: Worker
  private queue: Job[] = []
  private current: Job | null = null
  private last: Analysis = { cp: 0, pv: [] }
  private ready: Promise<void>
  private cache = new Map<string, Analysis>()

  constructor(options: Record<string, string | number> = {}) {
    this.worker = new Worker(ENGINE_URL)
    let onReady!: () => void
    this.ready = new Promise((r) => (onReady = r))
    this.worker.onmessage = (e: MessageEvent<string>) => this.onLine(String(e.data), onReady)
    this.send('uci')
    for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`)
    this.send('isready')
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd)
  }

  private onLine(line: string, onReady: () => void) {
    if (line === 'readyok') return onReady()
    if (!this.current) return
    if (line.startsWith('info') && line.includes(' score ') && !line.includes(' multipv 2')) {
      const m = line.match(/ score (cp|mate) (-?\d+)/)
      if (!m) return
      const n = Number(m[2])
      const pv = line.match(/ pv (.*)$/)?.[1].split(' ') ?? []
      if (m[1] === 'cp') this.last = { cp: n, pv }
      // "mate 0" means the side to move is already mated.
      else if (n === 0) this.last = { cp: -MATE_CP, mate: 0, pv: [] }
      else this.last = { cp: n > 0 ? MATE_CP - n : -MATE_CP - n, mate: n, pv }
    } else if (line.startsWith('bestmove')) {
      const best = line.split(' ')[1]
      const result: Analysis = { ...this.last, bestmove: best && best !== '(none)' ? best : undefined }
      const job = this.current
      this.current = null
      this.cache.set(`${job.fen}|${job.go}`, result)
      job.resolve(result)
      this.pump()
    }
  }

  private pump() {
    if (this.current || this.queue.length === 0) return
    const job = this.queue.shift()!
    this.current = job
    this.last = { cp: 0, pv: [] }
    this.send(`position fen ${job.fen}`)
    this.send(`go ${job.go}`)
  }

  /** Evaluate a position. `go` is the UCI search limit, e.g. "depth 14" or "movetime 500". */
  async analyse(fen: string, go = 'depth 14'): Promise<Analysis> {
    const cached = this.cache.get(`${fen}|${go}`)
    if (cached) return cached
    await this.ready
    return new Promise((resolve) => {
      this.queue.push({ fen, go, resolve })
      this.pump()
    })
  }

  setOption(name: string, value: string | number) {
    this.send(`setoption name ${name} value ${value}`)
  }

  terminate() {
    this.worker.terminate()
  }
}
