# Bounce Riot build contract

## Product
A bright, toy-sports 3D trampoline arena brawler for friends looking at one TV. Phones become two-thumb controllers through a QR code. No account or phone install. An offline practice game with keyboard and bots must work even without networking. The public release is a playable first version, not a claim of validated market demand.

## Simulation API
Export ARENAS: Record<ArenaId,ArenaConfig> and class GameSimulation from src/game/simulation.ts.
- constructor(options?: GameOptions)
- readonly state: GameState (mutable internal state is fine, read-only reference for renderer)
- setPlayers(specs: PlayerSpec[]): void, lobby roster and disconnect status; preserve state for existing players during a round, cap 8
- start(): void (3-second countdown, resets round scoring)
- step(dt: number, inputs?: Record<string,Input>): void (fixed stepping handled inside or clamp dt; documented)
- pause(): void and resume(): void
- reset(): void (back to lobby)
- setOptions(options: GameOptions): void (lobby/results only)
Simulation world coordinates: X horizontal on TV, Z towards viewer; floor Y=0, character center ~0.55 above player.y. Camera looks from positive Z and positive Y. Input x,z is world horizontal; no rotating camera. Arena circular radius about 7.1. GameSimulation must be deterministic with seed.

## Renderer API
Export class ArenaScene from src/render/scene.ts.
- constructor(container: HTMLElement, options?: { reducedMotion?: boolean; quality?: 'auto'|'low'|'high' })
- render(state: GameState, dt: number): void (application handles requestAnimationFrame)
- resize(): void
- dispose(): void
- setMatchView(active: boolean): void (selects the fixed lobby or match framing)
- setHomeView(active: boolean): void (moves the diorama beside the compact title menu)
- setQuality(quality: 'auto'|'low'|'high'): void
No DOM/UI or networking dependencies. Three.js available. Dispose listeners, GPU resources. For menu state show arena beautifully without needing live game. Characters procedural but sculpted, no primitive placeholder vibe. Use events with unique IDs without reprocessing. Label names can use CSS2DRenderer or canvas sprite but avoid massive textures per frame. Render a physical spring floor with animated traveling waves that visually match simulation. Camera fixed, full arena visible, no gameplay zoom. Distinct characters with expressive visual poses, visible direction/charge, shadows, a wooden stage rim, stitched canvas and a slim floating base on animated cove water. Batched rocks, palms and a jetty stay outside the playing field. No sky, clouds or foam pit. Separate fixed title/lobby/match framing keeps the whole board visible without crowding the menu or HUD. Correct lighting/sRGB, anti-aliasing with capped DPR, affordable for TV. Reduced motion disables shake/confetti excess, no flashes.

## Room service protocol
All messages JSON over websocket, maximum 16KB. Node.js Lambda handler and local ws server should share a tested hub. Server assigns identities and verifies permissions. Never trust client-provided from/role/slot.
Client messages:
- {action:'create'} creates room. Response {type:'created',room,token,roster:[],hostOnline:true}
- {action:'resume',room,token} host reclaims room. Response same created, existing roster. Old host connection invalidated.
- {action:'join',room,name,token?} phone join or resume. Response {type:'joined',room,token,id,slot,roster,hostOnline}. A valid resume token retains the seat/name. An invalid supplied token must NOT steal a seat.
- {action:'signal',to:'host'|playerId,data:{description?,candidate?}} forwards {type:'signal',from:'host'|playerId,data}. Host can target player, player only host.
- {action:'relay',to:'host'|playerId|'all',data:object} forwards {type:'relay',from:serverAssignedId,data}. Only host can broadcast.
- {action:'ping',at:number} -> {type:'pong',at:number}
- {action:'leave'} explicitly leaves; {action:'close'} host closes room; {action:'kick',id} host removes phone.
- {action:'roster'} returns current roster.
Server notifications:
- {type:'roster',roster:[{id,name,slot,connected}],hostOnline:boolean}
- {type:'host-offline'} / {type:'room-closed'}
- {type:'error',code,message}
Room codes six uppercase nonambiguous characters. Store only token hashes, expire rooms after 2h, cap 8 players, allow reconnection, sanitize names 16 chars, rate-limit abuse and cap relay payload. Roster changes notify all members. Not all disconnects mean permanent leave. Invalid/stale connections cannot send. Local ws server default port4382 provides /health. AWS: APIGateway WebSocket, one Lambda Node22+, on-demand DynamoDB with TTL, least privilege IAM, throttling, log retention, no logs containing payloads or tokens. Infrastructure is deployed explicitly with the deployment script. No TURN server needed for release: WebRTC first, authenticated websocket relay fallback.

## Peer payload protocol (TV authoritative)
Player -> host: {kind:'hello'}, {kind:'input',seq,x,z,action}, {kind:'command',command:'start'|'rematch'|'pause'|'resume'|'lobby'}.
Host -> player: {kind:'status',phase,remaining,countdown,score,name,color,charge,cooldown,captain,players:[{id,name,color,score,connected,bot}],message?}, {kind:'feedback',event:'hit'|'slam'|'ko'|'ride'|'respawn'}.
First connected human is captain; only captain commands accepted. Input normalized and finite; monotonically increasing sequence, heartbeat repeated 20Hz, stale >600ms reset to neutral. Local keyboard: WASD/arrows and Space. Press Q jump alternate only if implemented deliberately. Controller supports pointercancel and visibilitychange neutralization; wake lock best effort; reconnection with same slot. Do not claim offline LAN mode: lobby discovery/signaling requires internet in public build.

## Tests and deployment
Vitest simulation and backend validation tests. Playwright actual host+phones, QR join, movement/action, captain start, reconnect, maximum roster, round end/rematch, responsive layouts, console errors. Local / public transport tests. GitHub Pages relative assets; public endpoint configuration is not a secret. Never commit credentials, tokens, device identifiers, internal data or logs. CI unit/build and browser test before pages deployment. Author manishh-13 <manishh-13@users.noreply.github.com>.
