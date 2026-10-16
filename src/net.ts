// Serverless peer-to-peer link. Trystero finds the other player through public
// Nostr relays (signaling only), then all game traffic flows over a direct
// WebRTC data channel. Nothing to host.
import { joinRoom, type Room } from 'trystero'
import type { Color } from 'chess.js'
import type { GameConfig, Result } from './store'

const APP_ID = 'advanced-chess.aarongayle.github.io/v1'

export type Msg =
  | { t: 'hello'; client: string; round: number; moves: string[] }
  | {
      t: 'state'
      hostClient: string
      guestClient: string | null
      hostColor: Color
      config: GameConfig
      round: number
      moves: string[]
      result: Result | null
    }
  | { t: 'move'; round: number; ply: number; uci: string }
  | { t: 'resign'; round: number; color: Color }
  | { t: 'draw'; round: number; action: 'offer' | 'accept' | 'decline' }
  | { t: 'rematch'; round: number; action: 'offer' | 'accept' }

export class Net {
  private room: Room
  private action
  onMessage: (msg: Msg, peerId: string) => void = () => {}
  onPeerJoin: (peerId: string) => void = () => {}
  onPeerLeave: (peerId: string) => void = () => {}

  constructor(roomId: string) {
    this.room = joinRoom({ appId: APP_ID, password: roomId }, roomId)
    this.action = this.room.makeAction<Msg>('msg')
    this.action.onMessage = (msg, { peerId }) => this.onMessage(msg, peerId)
    this.room.onPeerJoin = (id) => this.onPeerJoin(id)
    this.room.onPeerLeave = (id) => this.onPeerLeave(id)
  }

  send(msg: Msg, peerId?: string) {
    void this.action.send(msg, peerId ? { target: peerId } : undefined).catch((e) => console.warn('send failed', e))
  }

  peers(): string[] {
    return Object.keys(this.room.getPeers())
  }

  leave() {
    void this.room.leave()
  }
}
