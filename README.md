# Advanced Chess

Live at **https://chess.gayle.dev**

Chess with a little help. Nothing tells you what to play. You just get enough board sense to stop you hanging your queen.

Full engine assistance ("centaur chess") makes games boring: every game is a draw and the human mostly gets in the way. This
project tries the opposite. Assistance helps you **see** the position the way a strong player does, and it never
suggests moves.

## Assistance levels

Each side gets its own level, so a stronger player can give a handicap.

| Level | What you get |
| --- | --- |
| **Unassisted** | Plain chess. |
| **Seatbelt** | Your hanging pieces glow red. Arrows show what the opponent's last move attacks, including discovered attacks and forks. |
| **GM Vision** | Seatbelt, plus the opponent's **threat** (what they'd play if you passed, via Stockfish), hanging and loose pieces on both sides, pins, and an optional control heatmap. |
| **Guardian** | GM Vision, plus a blunder guard. If a move drops your winning chances past the blunder threshold or allows mate, Guardian stops it and shows the refutation. Each intervention costs a shield, and you only get a few per game, so you can't use it to probe for good moves. |

"Hanging" uses static exchange evaluation: the piece is lost to the cheapest sequence of captures and recaptures,
x-ray batteries count, and pinned attackers can't capture first.

## Modes

- **Play a friend**: peer-to-peer. Create a game and send the link.
- **Practice vs Stockfish**: the bot gets no assistance.
- **Pass & play**: two people, one screen.

## Architecture: no server

- Static site (Vite + TypeScript), served as static assets by a Cloudflare Worker at chess.gayle.dev (`wrangler.jsonc`).
- Stockfish 19 (lite, single-threaded WASM) runs in a Web Worker in each browser.
- Online play uses [Trystero](https://github.com/dmotz/trystero). Peers find each other through public Nostr relays,
  which handle signaling only. Moves then travel over a direct WebRTC data channel. The room creator is authoritative for
  game settings. Games persist in `localStorage`, so a refresh or a dropped connection resyncs.
- Each browser computes its own assistance, so fair play is on the honor system. Only STUN is configured, so a small
  share of strict networks (symmetric NAT) can't connect without adding a TURN server.

## Development

```sh
npm install
npm run dev     # local dev server
npm test        # vision unit tests
npm run build   # static build in dist/
npm run deploy  # build + wrangler deploy; needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

Code map: `src/vision.ts` (static board analysis), `src/assist.ts` (levels, threats, Guardian), `src/engine.ts` (UCI
worker wrapper), `src/net.ts` (P2P), `src/game.ts` (game screen), `src/home.ts`.
