import 'chessground/assets/chessground.base.css'
import 'chessground/assets/chessground.brown.css'
import 'chessground/assets/chessground.cburnett.css'
import './style.css'
import { mountGame } from './game'
import { mountHome } from './home'

const root = document.getElementById('app')!
let cleanup: () => void = () => {}

function route() {
  cleanup()
  const play = location.hash.match(/^#\/play\/([a-z0-9]+)$/)
  cleanup = play ? mountGame(root, play[1]) : mountHome(root)
  window.scrollTo(0, 0)
}

window.addEventListener('hashchange', route)
route()
