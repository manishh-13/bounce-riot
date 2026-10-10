# Contributing

Use Node.js 22 or newer. Run `npm ci`, `npm test`, `npm run build` and `npm run test:e2e` before sending a change. Do not add credentials, player-session captures, generated deployment output or private infrastructure identifiers to commits.

## Useful boundaries
- `src/game`: deterministic fixed-step game rules. No DOM or network dependencies.
- `src/render`: visual interpretation of game state. It does not change scores or physics.
- `src/net`: connection lifecycle and validated controller input.
- `src/ui`: TV screens and touch controller.
- `server`: room membership and authenticated signaling/relay.
- `infra`: reproducible server deployment.

Keep the phone bundle independent of the 3D engine. Test quick taps, multi-touch, cancelled touches and browser backgrounding, not only mouse clicks. A visual change should be checked at 1280x720 and a small phone viewport in both orientations.

Gameplay tuning should be accompanied by simulation tests and real group playtesting when possible. Do not solve unreadable gameplay by adding more screen shake. Prefer predictable consequences, fast recovery and visible player identity.

The public live service is a small hobby deployment. Use a local room service for automated load and abuse tests.
