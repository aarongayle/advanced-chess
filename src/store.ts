// Games live in localStorage so a refresh (or a dropped connection) doesn't lose them.
import type { Color } from 'chess.js'
import type { Layer, Level } from './assist'
import { LAYERS } from './assist'

export type Mode = 'online' | 'bot' | 'local'
export type Role = 'host' | 'guest' | 'spectator' | 'local'

export type GameConfig = {
  levels: Record<Color, Level>
  /** Guardian interventions per player per game. */
  shields: number
  /** Stockfish "Skill Level" (0-20) for practice games. */
  botSkill?: number
}

export type Result = {
  winner?: Color
  reason: string
}

export interface SavedGame {
  id: string
  mode: Mode
  role: Role
  /** The color at the bottom of the board / the local player's color. */
  myColor: Color
  config: GameConfig
  /** UCI moves from the start position. */
  moves: string[]
  result?: Result
  shieldsUsed: Record<Color, number>
  /** Increments on each rematch so stale messages from an old game are ignored. */
  round: number
  hostClient?: string
  guestClient?: string
  /** False for a guest until the host's state has arrived. */
  synced: boolean
}

const key = (id: string) => `ac:game:${id}`

export function loadGame(id: string): SavedGame | null {
  const raw = localStorage.getItem(key(id))
  return raw ? (JSON.parse(raw) as SavedGame) : null
}

export function saveGame(game: SavedGame) {
  localStorage.setItem(key(game.id), JSON.stringify(game))
}

export function newId(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** Stable per-browser id, so a reconnecting player is recognised as the same person. */
export function clientId(): string {
  let id = localStorage.getItem('ac:client')
  if (!id) {
    id = newId(16)
    localStorage.setItem('ac:client', id)
  }
  return id
}

export function loadLayers(): Set<Layer> {
  const raw = localStorage.getItem('ac:layers')
  if (raw) return new Set(JSON.parse(raw) as Layer[])
  return new Set(LAYERS.filter((l) => l.defaultOn).map((l) => l.id))
}

export function saveLayers(layers: Set<Layer>) {
  localStorage.setItem('ac:layers', JSON.stringify([...layers]))
}
