# Bounce Riot: first-release game design

## The promise
A shared-screen trampoline brawler for friends in the same room. Open the game on a TV or computer, scan with phones, and start fighting without accounts or gamepads. The room needs internet for discovery; direct peer connections are attempted for input. A relay keeps compatible browsers connected when a direct route cannot be established.

This is a playable first release. It is not evidence that the game has achieved product-market fit, eight-person living-room readability, or compatibility with every smart TV.

## The moment worth building
A player charges a ground slam. A visible ripple travels through the trampoline. A rival hops onto that ripple, gains height, and returns with a slam of their own. The attack becomes an opportunity for the opponent. Friends can see why a reversal happened.

## Design pillars
- Readable physical consequences: waves have an origin and player colour, charge is visible, knockouts have attribution.
- Simple inputs with decisions: movement plus one action; choose timing and position rather than memorize combos.
- Everybody keeps playing: score rounds, short protected respawns, no permanent elimination.
- The TV is the focus: the controller needs thumbs, not constant visual attention.

## Core controls
| Action | Phone | Computer practice |
| --- | --- | --- |
| Move | Drag on the left movement pad | WASD or arrow keys |
| Hop | Tap and release the large action button | Tap Space |
| Charged slam | Hold the action button, then release | Hold and release Space |
| Menu | Top-right controller menu | Pause button or P |

A slam is charged before a short leap and landing. The travelling annular wave applies knockback to grounded opponents. An airborne opponent in the appropriate height window rides the wave for a lift. Holding to charge reduces movement speed. Cooldown prevents constant full-power spam.

Touch cancellation, leaving the tab, stale input, and menu opening cancel the charge without releasing an attack. A separate browser request tries to keep the screen awake. Fullscreen requires a user gesture and remains subject to operating-system controls.

## Match loop
1. Host opens a room. TV displays a QR code and six-character code.
2. Players join with a short nickname. The first connected human is captain.
3. Host chooses an arena and round duration, optionally adds practice bots.
4. Captain or host starts. A three-second countdown prepares the group.
5. Players score knockouts until time expires. Falls cause a short respawn, not elimination.
6. Results show points, knockouts and waves ridden. Rematch keeps the same room and controllers.

Target player count: 2 to 8 total participants, including bots. One human plus bots is supported. Physical eight-phone playtesting remains a release-validation task, not a claim established by automated clients.

## Arenas
- Springyard: the baseline trampoline, the cleanest place to learn movement and wave timing.
- Moonbounce: lower gravity changes airtime and wave-riding opportunities.
- Aftershock: the arena produces timed neutral shockwaves, adding a clearly signposted environmental threat.

These are variations of one core arena system, not three unrelated minigames. The initial build deliberately avoids full cloth simulation, complex ragdoll grabs, destructible buildings and free camera control.

## Presentation
Warm cream background, pine-coloured UI, saturated coral primary accents and a deeper mint trampoline fabric. The game should feel like an authored toy-sports diorama. Directional lighting and a subtle material-level silhouette treatment give the characters definition without a separate outline pass. Player rings have a dark keyline, names are larger and unlit, and eight-player scores use a compact two-row TV layout. One fixed camera keeps the whole arena visible. Player numbers and names supplement colour.

Sound effects are original Web Audio synthesis. They only begin after a user gesture. Screen shake and decorative effects are restrained; reduced-motion preferences reduce nonessential motion. Low graphics mode is available for weaker TV devices. The TV colour pass preserves the simulation, particle caps, geometry and draw-call counts in the fixed render fixtures; it does not establish equal frame time on physical TVs. Wave crests use stronger colour rather than extra bloom or full-screen flashes.

## Scoring and fairness
The implementation and its tests are the authority on constants. The player-facing rule is +2 for a credited knockout and a one-point penalty for an unassisted fall, with scores never below zero. Ties are resolved by knockouts, then fewer falls; an exact tie is shared. Protected respawn time prevents instant chain knockouts. Attribution has a bounded window so a much later self-fall does not award an old attacker.

## Phone experience
The controller uses real Pointer Events with independent pointer capture for each thumb. Its active surface disables scroll, text selection, long-press callouts and browser touch gestures inside the controller. Safe-area insets keep controls clear of notches. Portrait and landscape both work.

Android Chrome can request fullscreen. iPhone users can launch from Add to Home Screen to remove browser chrome; a normal Safari tab cannot be guaranteed immersive fullscreen. The app never claims it can block incoming calls, notifications, home gestures, browser exits or battery-saving policy.

Leaving fullscreen pauses controller input and shows a deliberate resume action. The captain can start, pause and rematch without touching the TV remote. Rejoining uses a stored token to recover the same slot when the room still exists.

## Engineering choices
- TypeScript plus Three.js for the screen, HTML/CSS for the controller.
- Fixed-step simulation owned by the screen, independent of renderer frame rate.
- WebRTC data channel first, WebSocket room-service relay fallback.
- Static frontend on GitHub Pages. Self-hostable serverless room service or local Node server.
- No camera, microphone, tilt permission, player account or advertising integration.
- PWA shell caching supports reopening practice after a successful prior load. Creating/joining an online room still needs connectivity.

## Validation before adding content
Watch real groups, particularly mixed gaming experience. Record time to join, whether they identify their character, whether wave counterplay is discoverable, spontaneous rematches and whether hosts return without prompting. Compare 4, 6 and 8 players. If eight-player waves cannot remain readable, reduce the supported count rather than hiding the problem behind effects.

Benchmark frame time and touch-to-visible-response on the intended physical TV. Simulated mobile browsers and software-rendered Chrome do not prove real TV or iPhone performance.
