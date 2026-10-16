import { Chess, type Color, type Move, type Square } from 'chess.js'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { DrawBrushes, DrawShape } from 'chessground/draw'
import type { Key } from 'chessground/types'
import {
  type Blunder,
  checkBlunder,
  findThreat,
  type Insight,
  LAYERS,
  LEVELS,
  type Level,
  staticOverlay,
  threatOverlay,
} from './assist'
import { Engine } from './engine'
import { type Msg, Net } from './net'
import { clientId, loadGame, loadLayers, type Result, type SavedGame, saveGame, saveLayers } from './store'
import { other } from './vision'

const COLOR_NAME: Record<Color, string> = { w: 'White', b: 'Black' }
const cgColor = (c: Color) => (c === 'w' ? 'white' : 'black')

const BRUSHES = {
  threat: { key: 'th', color: '#e11d48', opacity: 0.9, lineWidth: 13 },
  attack: { key: 'at', color: '#f59e0b', opacity: 0.85, lineWidth: 8 },
  pin: { key: 'pn', color: '#8b5cf6', opacity: 0.55, lineWidth: 5 },
  refute: { key: 'rf', color: '#e11d48', opacity: 0.95, lineWidth: 13 },
} as unknown as DrawBrushes

let assistEngine: Engine | null = null
const getAssistEngine = () => (assistEngine ??= new Engine({ Hash: 32 }))

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function replay(moves: string[]): Chess {
  const chess = new Chess()
  for (const uci of moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  return chess
}

function isLegalExtension(base: string[], candidate: string[]): boolean {
  if (candidate.length <= base.length || base.some((m, i) => candidate[i] !== m)) return false
  try {
    replay(candidate)
    return true
  } catch {
    return false
  }
}

function detectResult(chess: Chess): Result | undefined {
  if (chess.isCheckmate()) return { winner: other(chess.turn()), reason: 'checkmate' }
  if (chess.isStalemate()) return { reason: 'stalemate' }
  if (chess.isInsufficientMaterial()) return { reason: 'insufficient material' }
  if (chess.isThreefoldRepetition()) return { reason: 'threefold repetition' }
  if (chess.isDrawByFiftyMoves()) return { reason: 'fifty-move rule' }
  return undefined
}

const levelName = (l: Level) => LEVELS[l].name

/** Mounts the game screen for game `id`. Returns a cleanup function. */
export function mountGame(root: HTMLElement, id: string): () => void {
  const me = clientId()
  let game: SavedGame =
    loadGame(id) ??
    // Opened an invite link: we're a guest until the host tells us otherwise.
    {
      id,
      mode: 'online',
      role: 'guest',
      myColor: 'b',
      config: { levels: { w: 0, b: 0 }, shields: 0 },
      moves: [],
      shieldsUsed: { w: 0, b: 0 },
      round: 0,
      synced: false,
    }
  let chess = replay(game.moves)
  let orientation: Color = game.myColor
  let busy = false
  let layers = loadLayers()
  let token = 0
  let insights: Insight[] = []
  let thinking = false
  let drawState: 'none' | 'sent' | 'received' = 'none'
  let rematchState: 'none' | 'sent' | 'received' = 'none'
  let notice = ''
  const peerRole = new Map<string, 'host' | 'guest' | 'spectator'>()
  let botEngine: Engine | null = null
  let net: Net | null = null

  // ---------- layout ----------
  root.innerHTML = ''
  const wrap = el('div', 'game')
  const boardCol = el('div', 'board-col')
  const topBar = el('div', 'player-bar')
  const boardWrap = el('div', 'board-wrap')
  const boardEl = el('div', 'board')
  const modal = el('div', 'modal')
  modal.hidden = true
  const bottomBar = el('div', 'player-bar')
  boardWrap.append(boardEl, modal)
  boardCol.append(topBar, boardWrap, bottomBar)

  const panel = el('aside', 'panel')
  const statusEl = el('div', 'status')
  const inviteEl = el('div', 'invite')
  const visionEl = el('section', 'vision')
  const movesEl = el('section', 'moves')
  const actionsEl = el('div', 'actions')
  panel.append(statusEl, inviteEl, visionEl, movesEl, actionsEl)
  wrap.append(boardCol, panel)
  root.append(wrap)

  const cg: Api = Chessground(boardEl, {
    orientation: cgColor(orientation),
    coordinates: true,
    animation: { enabled: true, duration: 180 },
    premovable: { enabled: false },
    movable: { free: false, showDests: true, events: { after: (o, d) => void onUserMove(o as Square, d as Square) } },
    drawable: { enabled: true, brushes: BRUSHES },
    highlight: { lastMove: true, check: true },
  })

  // ---------- helpers ----------
  const save = () => saveGame(game)
  const canPlay = () => game.role === 'host' || game.role === 'guest' || game.role === 'local'
  const opponentOnline = () => {
    const want = game.role === 'host' ? 'guest' : 'host'
    return [...peerRole.values()].includes(want)
  }

  /** Whose assistance is shown: yours, or the side to move in pass & play. */
  function viewer(): Color | null {
    if (game.mode === 'local') return chess.turn()
    if (game.role === 'spectator') return null
    return game.myColor
  }

  function myTurn(): boolean {
    if (game.result || busy || !game.synced || !canPlay()) return false
    if (game.mode === 'local') return true
    if (game.mode === 'online' && !opponentOnline() && game.moves.length === 0 && game.role === 'host') return false
    return chess.turn() === game.myColor
  }

  function dests(): Map<Key, Key[]> {
    const map = new Map<Key, Key[]>()
    for (const m of chess.moves({ verbose: true })) {
      map.set(m.from, [...(map.get(m.from) ?? []), m.to])
    }
    return map
  }

  function lastMove(): Move | undefined {
    const h = chess.history({ verbose: true })
    return h[h.length - 1]
  }

  function shieldsLeft(c: Color): number {
    return game.config.levels[c] === 3 ? Math.max(0, game.config.shields - game.shieldsUsed[c]) : 0
  }

  // ---------- moves ----------
  async function askPromotion(color: Color): Promise<string> {
    const pieces: [string, string][] = [['q', '♛ Queen'], ['r', '♜ Rook'], ['b', '♝ Bishop'], ['n', '♞ Knight']]
    return showModal(
      'Promote to',
      '',
      pieces.map(([p, name]) => ({ id: p, label: name, cls: `promo promo-${color}${p}` })),
    )
  }

  async function onUserMove(from: Square, to: Square) {
    const candidates = chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to)
    if (candidates.length === 0) return refresh()
    let uci = from + to
    if (candidates[0].promotion) uci += await askPromotion(chess.turn())
    const mover = chess.turn()
    if (shieldsLeft(mover) > 0) {
      busy = true
      thinking = true
      refresh()
      const before = chess.fen()
      const after = new Chess(before)
      after.move({ from, to, promotion: uci[4] })
      const blunder = await checkBlunder(getAssistEngine(), before, after.fen())
      thinking = false
      busy = false
      if (blunder) {
        game.shieldsUsed[mover]++
        save()
        renderStatus()
        renderBars()
        const choice = await showGuardian(blunder, mover)
        if (choice === 'back') return refresh()
      }
    }
    commit(uci, false)
  }

  function commit(uci: string, fromPeer: boolean) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    } catch {
      console.warn('illegal move', uci)
      return refresh()
    }
    game.moves.push(uci)
    game.result = detectResult(chess)
    drawState = 'none'
    notice = ''
    save()
    if (!fromPeer && net) net.send({ t: 'move', round: game.round, ply: game.moves.length - 1, uci })
    refresh()
  }

  async function botMove() {
    if (!botEngine) botEngine = new Engine({ 'Skill Level': game.config.botSkill ?? 5 })
    const fen = chess.fen()
    const ply = game.moves.length
    const [res] = await Promise.all([botEngine.analyse(fen, 'movetime 600'), new Promise((r) => setTimeout(r, 400))])
    if (game.moves.length !== ply || game.result || !res.bestmove) return
    commit(res.bestmove, true)
  }

  // ---------- modal ----------
  function showModal(title: string, body: string, buttons: { id: string; label: string; cls?: string }[]): Promise<string> {
    return new Promise((resolve) => {
      modal.innerHTML = ''
      const box = el('div', 'modal-box')
      box.append(el('h3', '', title))
      if (body) box.append(el('p', '', body))
      const row = el('div', 'modal-buttons')
      for (const b of buttons) {
        const btn = el('button', b.cls ?? '', b.label)
        btn.onclick = () => {
          modal.hidden = true
          resolve(b.id)
        }
        row.append(btn)
      }
      box.append(row)
      modal.append(box)
      modal.hidden = false
    })
  }

  async function showGuardian(b: Blunder, mover: Color): Promise<'back' | 'play'> {
    if (b.refutation) {
      cg.setAutoShapes([
        { orig: b.refutation.uci.slice(0, 2) as Key, dest: b.refutation.uci.slice(2, 4) as Key, brush: 'refute' },
      ])
    }
    const left = shieldsLeft(mover)
    const reply = b.refutation ? ` Their reply would be ${b.refutation.san}.` : ''
    const shields = left === 0 ? 'That was your last shield.' : `${left} shield${left === 1 ? '' : 's'} left.`
    const choice = await showModal('🛡 Guardian stopped that move', `${b.message}${reply} ${shields}`, [
      { id: 'back', label: 'Take it back', cls: 'primary' },
      { id: 'play', label: 'Play it anyway' },
    ])
    return choice as 'back' | 'play'
  }

  // ---------- assistance ----------
  async function updateAssistance() {
    const t = ++token
    const v = viewer()
    const level = v ? game.config.levels[v] : 0
    if (!v || level === 0) {
      insights = []
      applyOverlay([], new Map())
      renderVision()
      return
    }
    const lm = lastMove()
    const overlay = staticOverlay({
      fen: chess.fen(),
      viewer: v,
      level,
      layers,
      lastMove: lm && lm.color !== v ? { before: lm.before, from: lm.from, to: lm.to, flags: lm.flags } : undefined,
    })
    insights = overlay.insights
    applyOverlay(overlay.shapes, overlay.squares)
    renderVision()
    if (level >= 2 && layers.has('threat') && chess.turn() === v && !game.result) {
      const threat = await findThreat(getAssistEngine(), chess.fen())
      if (t !== token || !threat) return
      const extra = threatOverlay(threat)
      insights = [...extra.insights, ...insights]
      const same = (a: DrawShape, b: DrawShape) => a.orig === b.orig && a.dest === b.dest
      const rest = overlay.shapes.filter((s) => !extra.shapes.some((x) => same(s, x)))
      applyOverlay([...extra.shapes, ...rest], overlay.squares)
      renderVision()
    }
  }

  function applyOverlay(shapes: DrawShape[], squares: Map<Key, string>) {
    cg.setAutoShapes(shapes)
    cg.set({ highlight: { custom: squares } })
  }

  // ---------- rendering ----------
  function refresh() {
    const lm = lastMove()
    const canMove = myTurn()
    cg.set({
      fen: chess.fen(),
      orientation: cgColor(orientation),
      turnColor: cgColor(chess.turn()),
      lastMove: lm ? [lm.from, lm.to] : undefined,
      check: chess.isCheck(),
      movable: {
        color: canMove ? cgColor(chess.turn()) : undefined,
        dests: canMove ? dests() : new Map(),
      },
    })
    renderBars()
    renderStatus()
    renderInvite()
    renderMoves()
    renderActions()
    void updateAssistance()
    if (game.mode === 'bot' && !game.result && chess.turn() !== game.myColor) void botMove()
  }

  function renderBar(bar: HTMLElement, color: Color) {
    bar.innerHTML = ''
    const isMe = game.mode !== 'local' && game.role !== 'spectator' && color === game.myColor
    let who = COLOR_NAME[color]
    if (game.mode === 'bot') who = isMe ? 'You' : `Stockfish (skill ${game.config.botSkill})`
    else if (game.mode === 'online' && game.role !== 'spectator') who = isMe ? 'You' : 'Opponent'
    const name = el('span', 'who')
    name.append(el('span', `dot dot-${color}`), document.createTextNode(` ${who}`))
    if (game.mode === 'online' && !isMe && game.role !== 'spectator') {
      name.append(el('span', `conn ${opponentOnline() ? 'on' : 'off'}`, opponentOnline() ? 'online' : 'offline'))
    }
    if (chess.turn() === color && !game.result) name.append(el('span', 'to-move', 'to move'))
    const level = game.config.levels[color]
    const badge = el('span', `level level-${level}`, levelName(level))
    bar.append(name, badge)
    if (level === 3) {
      const left = shieldsLeft(color)
      const s = el('span', 'shields', '🛡'.repeat(left) + '·'.repeat(game.config.shields - left))
      s.title = `${left} of ${game.config.shields} Guardian shields left`
      bar.append(s)
    }
  }

  function renderBars() {
    renderBar(topBar, other(orientation))
    renderBar(bottomBar, orientation)
  }

  function renderStatus() {
    let text: string
    if (game.result) {
      const r = game.result
      text = r.winner ? `${COLOR_NAME[r.winner]} wins by ${r.reason}` : `Draw by ${r.reason}`
      if (game.mode !== 'local' && game.role !== 'spectator' && r.winner) text += r.winner === game.myColor ? ' 🎉' : ''
    } else if (!game.synced) {
      text = 'Connecting to the host… (peer-to-peer, can take a few seconds)'
    } else if (thinking) {
      text = '🛡 Guardian is checking your move…'
    } else if (game.mode === 'online' && game.role === 'host' && !opponentOnline() && game.moves.length === 0) {
      text = 'Waiting for your opponent to open the invite link.'
    } else if (game.mode === 'online' && game.role !== 'spectator' && !opponentOnline()) {
      text = 'Opponent disconnected. They can rejoin with the same link.'
    } else if (game.mode === 'local' || game.role === 'spectator') {
      text = `${COLOR_NAME[chess.turn()]} to move${chess.isCheck() ? ' (check)' : ''}`
    } else {
      text = chess.turn() === game.myColor ? `Your move${chess.isCheck() ? ' — you’re in check' : ''}` : 'Their move…'
    }
    statusEl.textContent = text
    if (notice) statusEl.append(el('div', 'notice', notice))
  }

  function renderInvite() {
    inviteEl.innerHTML = ''
    inviteEl.hidden = !(game.mode === 'online' && game.role === 'host' && game.moves.length === 0 && !game.result)
    if (inviteEl.hidden) return
    const link = location.href
    inviteEl.append(el('div', 'label', 'Invite link'))
    const row = el('div', 'invite-row')
    const input = el('input')
    input.value = link
    input.readOnly = true
    input.onclick = () => input.select()
    const copy = el('button', 'primary', 'Copy')
    copy.onclick = async () => {
      await navigator.clipboard.writeText(link)
      copy.textContent = 'Copied!'
    }
    row.append(input, copy)
    inviteEl.append(row)
  }

  function renderVision() {
    visionEl.innerHTML = ''
    const v = viewer()
    const level = v ? game.config.levels[v] : 0
    if (!v) {
      visionEl.append(el('h3', '', 'Spectating'), el('p', 'muted', 'Spectators don’t get assistance.'))
      return
    }
    const head = el('h3', '', game.mode === 'local' ? `${COLOR_NAME[v]}’s vision` : 'Your vision')
    head.append(el('span', `level level-${level}`, levelName(level)))
    visionEl.append(head)
    if (level === 0) {
      visionEl.append(el('p', 'muted', 'Unassisted: you’re on your own.'))
      return
    }
    const list = el('ul', 'insights')
    if (insights.length === 0) list.append(el('li', 'muted', 'Nothing urgent on the board.'))
    for (const i of insights.slice(0, 8)) list.append(el('li', `sev-${i.severity}`, i.text))
    visionEl.append(list)
    if (level === 3) {
      visionEl.append(el('p', 'muted small', `Guardian: ${shieldsLeft(v)} shield(s) left. It steps in when a move would throw the game away.`))
    }
    const toggles = el('details', 'layers')
    toggles.append(el('summary', '', 'Layers'))
    for (const l of LAYERS.filter((x) => x.level <= level)) {
      const label = el('label')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = layers.has(l.id)
      box.onchange = () => {
        if (box.checked) layers.add(l.id)
        else layers.delete(l.id)
        saveLayers(layers)
        void updateAssistance()
      }
      label.append(box, document.createTextNode(` ${l.label}`), el('span', `swatch swatch-${l.id}`))
      toggles.append(label)
    }
    toggles.open = localStorage.getItem('ac:layers-open') === '1'
    toggles.ontoggle = () => localStorage.setItem('ac:layers-open', toggles.open ? '1' : '0')
    visionEl.append(toggles)
  }

  function renderMoves() {
    movesEl.innerHTML = ''
    const hist = chess.history()
    const ol = el('ol', 'move-list')
    for (let i = 0; i < hist.length; i += 2) {
      const li = el('li')
      li.append(el('span', 'san', hist[i]), el('span', 'san', hist[i + 1] ?? ''))
      ol.append(li)
    }
    movesEl.append(ol)
    ol.scrollTop = ol.scrollHeight
  }

  function button(label: string, onClick: () => void, cls = '') {
    const b = el('button', cls, label)
    b.onclick = onClick
    actionsEl.append(b)
    return b
  }

  function renderActions() {
    actionsEl.innerHTML = ''
    button('Flip', () => {
      orientation = other(orientation)
      refresh()
    })
    const playing = !game.result && canPlay() && game.synced
    if (playing) {
      button('Resign', async () => {
        const c = await showModal('Resign?', '', [
          { id: 'yes', label: 'Resign', cls: 'danger' },
          { id: 'no', label: 'Keep playing' },
        ])
        if (c !== 'yes') return
        const loser = game.mode === 'local' ? chess.turn() : game.myColor
        game.result = { winner: other(loser), reason: 'resignation' }
        save()
        net?.send({ t: 'resign', round: game.round, color: loser })
        refresh()
      })
    }
    if (playing && game.mode === 'online') {
      if (drawState === 'received') {
        button('Accept draw', () => {
          game.result = { reason: 'agreement' }
          save()
          net?.send({ t: 'draw', round: game.round, action: 'accept' })
          drawState = 'none'
          refresh()
        }, 'primary')
        button('Decline', () => {
          net?.send({ t: 'draw', round: game.round, action: 'decline' })
          drawState = 'none'
          refresh()
        })
      } else {
        const b = button(drawState === 'sent' ? 'Draw offered' : 'Offer draw', () => {
          drawState = 'sent'
          net?.send({ t: 'draw', round: game.round, action: 'offer' })
          refresh()
        })
        b.disabled = drawState === 'sent' || !opponentOnline()
      }
    }
    if (game.result && canPlay()) {
      if (game.mode === 'online') {
        if (rematchState === 'received') button('Accept rematch', () => acceptRematch(), 'primary')
        else {
          const b = button(rematchState === 'sent' ? 'Rematch offered' : 'Rematch', () => {
            rematchState = 'sent'
            net?.send({ t: 'rematch', round: game.round, action: 'offer' })
            refresh()
          }, 'primary')
          b.disabled = rematchState === 'sent' || !opponentOnline()
        }
      } else {
        button('Play again', () => {
          game = { ...game, moves: [], result: undefined, shieldsUsed: { w: 0, b: 0 }, round: game.round + 1 }
          if (game.mode === 'bot') game.myColor = other(game.myColor)
          orientation = game.myColor
          chess = new Chess()
          save()
          refresh()
        }, 'primary')
      }
    }
    button('Copy PGN', async () => {
      chess.header('Event', 'Advanced Chess', 'White', `${levelName(game.config.levels.w)}`, 'Black', `${levelName(game.config.levels.b)}`)
      await navigator.clipboard.writeText(chess.pgn())
      notice = 'PGN copied to clipboard.'
      renderStatus()
    })
  }

  // ---------- networking ----------
  function adoptState(moves: string[], result: Result | null | undefined) {
    game.moves = moves
    game.result = result ?? undefined
    chess = replay(moves)
  }

  function resetForRematch(round: number, hostColor: Color) {
    game.round = round
    game.moves = []
    game.result = undefined
    game.shieldsUsed = { w: 0, b: 0 }
    game.myColor = game.role === 'guest' ? other(hostColor) : hostColor
    orientation = game.myColor
    chess = new Chess()
    drawState = 'none'
    rematchState = 'none'
  }

  function stateMsg(): Msg {
    return {
      t: 'state',
      hostClient: me,
      guestClient: game.guestClient ?? null,
      hostColor: game.myColor,
      config: game.config,
      round: game.round,
      moves: game.moves,
      result: game.result ?? null,
    }
  }

  function acceptRematch() {
    if (game.role === 'host') {
      resetForRematch(game.round + 1, other(game.myColor))
      save()
      net?.send(stateMsg())
    } else {
      net?.send({ t: 'rematch', round: game.round, action: 'accept' })
    }
    rematchState = 'none'
    refresh()
  }

  /** Is this peer the person I'm playing (or, for spectators, one of the players)? */
  function fromPlayer(peerId: string): boolean {
    const role = peerRole.get(peerId)
    if (game.role === 'host') return role === 'guest'
    if (game.role === 'guest') return role === 'host'
    return role === 'host' || role === 'guest'
  }

  function onMessage(msg: Msg, peerId: string) {
    switch (msg.t) {
      case 'hello': {
        if (game.role !== 'host') return
        if (!game.guestClient) game.guestClient = msg.client
        peerRole.set(peerId, msg.client === game.guestClient ? 'guest' : 'spectator')
        if (peerRole.get(peerId) === 'guest' && msg.round === game.round && isLegalExtension(game.moves, msg.moves)) {
          adoptState(msg.moves, detectResult(replay(msg.moves)))
        }
        save()
        net!.send(stateMsg(), peerId)
        break
      }
      case 'state': {
        if (game.role === 'host') return
        peerRole.set(peerId, 'host')
        if (msg.guestClient) {
          for (const [p, r] of peerRole) if (r === 'guest' && p !== peerId) peerRole.delete(p)
        }
        game.hostClient = msg.hostClient
        game.guestClient = msg.guestClient ?? undefined
        game.role = msg.guestClient === me ? 'guest' : 'spectator'
        game.config = msg.config
        if (msg.round !== game.round || !game.synced) {
          resetForRematch(msg.round, msg.hostColor)
          adoptState(msg.moves, msg.result)
        } else if (msg.moves.length >= game.moves.length) {
          adoptState(msg.moves, msg.result ?? game.result)
        }
        game.myColor = game.role === 'guest' ? other(msg.hostColor) : msg.hostColor
        if (!game.synced) orientation = game.myColor
        game.synced = true
        save()
        break
      }
      case 'move': {
        if (!fromPlayer(peerId) || msg.round !== game.round) return
        if (msg.ply === game.moves.length) {
          commit(msg.uci, true)
          return
        }
        if (msg.ply > game.moves.length && game.role !== 'host') {
          net!.send({ t: 'hello', client: me, round: game.round, moves: game.moves }, peerId)
        }
        return
      }
      case 'resign': {
        if (!fromPlayer(peerId) || msg.round !== game.round || game.result) return
        game.result = { winner: other(msg.color), reason: 'resignation' }
        save()
        break
      }
      case 'draw': {
        if (!fromPlayer(peerId) || msg.round !== game.round || game.result) return
        if (msg.action === 'offer') drawState = 'received'
        if (msg.action === 'decline') {
          drawState = 'none'
          notice = 'Draw offer declined.'
        }
        if (msg.action === 'accept') {
          game.result = { reason: 'agreement' }
          save()
        }
        break
      }
      case 'rematch': {
        if (!fromPlayer(peerId) || msg.round !== game.round) return
        if (msg.action === 'offer') rematchState = 'received'
        if (msg.action === 'accept' && game.role === 'host') return acceptRematch()
        break
      }
    }
    refresh()
  }

  if (game.mode === 'online') {
    net = new Net(id)
    net.onMessage = onMessage
    net.onPeerJoin = (peerId) => {
      if (game.role !== 'host') net!.send({ t: 'hello', client: me, round: game.round, moves: game.moves }, peerId)
    }
    net.onPeerLeave = (peerId) => {
      peerRole.delete(peerId)
      refresh()
    }
  }

  refresh()

  return () => {
    token++
    net?.leave()
    botEngine?.terminate()
    cg.destroy()
  }
}
