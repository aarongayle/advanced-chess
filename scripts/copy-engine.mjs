// Copies the single-threaded Stockfish build into public/ so it can be served
// statically (GitHub Pages can't send the headers multi-threaded builds need).
import { copyFileSync, mkdirSync } from 'node:fs'

const src = 'node_modules/stockfish/bin'
const dest = 'public/engine'
mkdirSync(dest, { recursive: true })
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  copyFileSync(`${src}/${f}`, `${dest}/${f}`)
}
copyFileSync('node_modules/stockfish/Copying.txt', `${dest}/COPYING.txt`)
