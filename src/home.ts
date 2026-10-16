import type { Color } from 'chess.js'
import { LEVELS, type Level } from './assist'
import { type Mode, newId, type SavedGame, saveGame } from './store'

const BOT_LEVELS = [
  { skill: 0, label: 'Beginner' },
  { skill: 4, label: 'Casual' },
  { skill: 8, label: 'Club' },
  { skill: 14, label: 'Strong' },
  { skill: 20, label: 'Full strength' },
]

function levelOptions(selected: Level): string {
  return LEVELS.map((l) => `<option value="${l.id}"${l.id === selected ? ' selected' : ''}>${l.name}</option>`).join('')
}

function recentGames(): SavedGame[] {
  const out: SavedGame[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (!k.startsWith('ac:game:')) continue
    const g = JSON.parse(localStorage.getItem(k)!) as SavedGame
    if (!g.result && g.moves.length > 0) out.push(g)
  }
  return out.slice(0, 6)
}

const MODE_LABEL: Record<Mode, string> = { online: 'Online', bot: 'vs Stockfish', local: 'Pass & play' }

export function mountHome(root: HTMLElement): () => void {
  root.innerHTML = `
  <div class="home">
    <header class="hero">
      <h1>Advanced Chess</h1>
      <p class="tagline">Chess with a little help. No engine telling you what to play. Just enough board sense to stop you hanging your queen.</p>
    </header>

    <section class="levels">
      ${LEVELS.map(
        (l) => `<div class="level-card"><div class="level level-${l.id}">${l.name}</div><p>${l.blurb}</p></div>`,
      ).join('')}
    </section>

    <section class="modes">
      <form class="mode-card" id="online">
        <h2>Play a friend</h2>
        <p class="muted">Peer-to-peer in the browser. Send the link, and the game connects directly between your browsers.</p>
        <label>Your color <select name="color"><option value="w">White</option><option value="b">Black</option><option value="r" selected>Random</option></select></label>
        <label>Your assistance <select name="me">${levelOptions(2)}</select></label>
        <label>Their assistance <select name="them">${levelOptions(2)}</select></label>
        <label class="shields-row">Guardian shields <input name="shields" type="number" min="1" max="10" value="3"></label>
        <button class="primary">Create game</button>
      </form>

      <form class="mode-card" id="bot">
        <h2>Practice vs Stockfish</h2>
        <p class="muted">Try the assistance levels against a computer opponent. The bot gets no help.</p>
        <label>Bot strength <select name="skill">${BOT_LEVELS.map((b) => `<option value="${b.skill}"${b.skill === 4 ? ' selected' : ''}>${b.label}</option>`).join('')}</select></label>
        <label>Your color <select name="color"><option value="w" selected>White</option><option value="b">Black</option><option value="r">Random</option></select></label>
        <label>Your assistance <select name="me">${levelOptions(2)}</select></label>
        <label class="shields-row">Guardian shields <input name="shields" type="number" min="1" max="10" value="3"></label>
        <button class="primary">Start</button>
      </form>

      <form class="mode-card" id="local">
        <h2>Pass &amp; play</h2>
        <p class="muted">Two people, one screen. Each side sees its own assistance on its turn.</p>
        <label>White’s assistance <select name="w">${levelOptions(1)}</select></label>
        <label>Black’s assistance <select name="b">${levelOptions(1)}</select></label>
        <label class="shields-row">Guardian shields <input name="shields" type="number" min="1" max="10" value="3"></label>
        <button class="primary">Start</button>
      </form>
    </section>

    <section class="recent" hidden>
      <h2>Unfinished games</h2>
      <ul></ul>
    </section>

    <footer class="about">
      <h2>How it works</h2>
      <p>Assistance helps you <em>see</em> and never tells you what to play. Static vision (hanging pieces, attacks, pins, control) is computed instantly from the board. Threats and the Guardian use Stockfish, which runs in your browser. Different levels per side make a handicap: a strong player can go unassisted against a friend on GM Vision.</p>
      <p>There's no server. Online games find each other through public Nostr relays and then talk directly over WebRTC. Each browser computes its own assistance, so this is an honor system, the same as any casual game. A few strict corporate or mobile networks can block direct connections.</p>
    </footer>
  </div>`

  const form = (id: string) => root.querySelector<HTMLFormElement>(`#${id}`)!
  const val = (f: HTMLFormElement, name: string) => (f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value
  const pickColor = (v: string): Color => (v === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : (v as Color))

  // Only show the shields input when someone actually has Guardian.
  for (const f of root.querySelectorAll<HTMLFormElement>('form.mode-card')) {
    const sync = () => {
      const selects = [...f.querySelectorAll<HTMLSelectElement>('select')].filter((s) => s.name !== 'color' && s.name !== 'skill')
      f.querySelector<HTMLElement>('.shields-row')!.hidden = !selects.some((s) => s.value === '3')
    }
    f.addEventListener('change', sync)
    sync()
  }

  function start(game: Omit<SavedGame, 'id' | 'moves' | 'shieldsUsed' | 'round' | 'synced'>) {
    const id = newId()
    saveGame({ ...game, id, moves: [], shieldsUsed: { w: 0, b: 0 }, round: 0, synced: true })
    location.hash = `#/play/${id}`
  }

  form('online').onsubmit = (e) => {
    e.preventDefault()
    const f = form('online')
    const myColor = pickColor(val(f, 'color'))
    const mine = Number(val(f, 'me')) as Level
    const theirs = Number(val(f, 'them')) as Level
    start({
      mode: 'online',
      role: 'host',
      myColor,
      config: {
        levels: myColor === 'w' ? { w: mine, b: theirs } : { w: theirs, b: mine },
        shields: Number(val(f, 'shields')),
      },
    })
  }

  form('bot').onsubmit = (e) => {
    e.preventDefault()
    const f = form('bot')
    const myColor = pickColor(val(f, 'color'))
    const mine = Number(val(f, 'me')) as Level
    start({
      mode: 'bot',
      role: 'local',
      myColor,
      config: {
        levels: myColor === 'w' ? { w: mine, b: 0 } : { w: 0, b: mine },
        shields: Number(val(f, 'shields')),
        botSkill: Number(val(f, 'skill')),
      },
    })
  }

  form('local').onsubmit = (e) => {
    e.preventDefault()
    const f = form('local')
    start({
      mode: 'local',
      role: 'local',
      myColor: 'w',
      config: {
        levels: { w: Number(val(f, 'w')) as Level, b: Number(val(f, 'b')) as Level },
        shields: Number(val(f, 'shields')),
      },
    })
  }

  const recent = recentGames()
  if (recent.length) {
    const section = root.querySelector<HTMLElement>('.recent')!
    section.hidden = false
    const ul = section.querySelector('ul')!
    for (const g of recent) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = `#/play/${g.id}`
      a.textContent = `${MODE_LABEL[g.mode]} · move ${Math.ceil(g.moves.length / 2)}`
      li.append(a)
      ul.append(li)
    }
  }

  return () => {}
}
