import type { Phase } from '../game/types';
import { loadServiceConfig, RoomConnection, type Transport } from '../net/room';
import { escapeHtml, fullscreen, isIOS, isStandalone, readSaved, save, removeSaved, WakeKeeper } from './helpers';
import { identitySvg, playerIdentity } from './player-identity';
import './identity.css';

interface ControllerStatus {
  phase: Phase; remaining: number; countdown: number; score: number; name: string; color: number;
  charge: number; cooldown: number; captain: boolean;
  players: { id: string; name: string; color: number; score: number; connected: boolean; bot?: boolean }[];
}
interface SavedPlayer { room: string; token: string; name: string; slot?: number; }
export function mountController(root: HTMLElement, roomCode: string): () => void {
  document.body.classList.add('controller-mode');
  let disposed = false;
  let connection: RoomConnection | undefined;
  let status: ControllerStatus | undefined;
  let joined = false;
  let armed = false;
  let accepted = false;
  let menuOpen = false;
  let x = 0, z = 0, action = false, cancel = false, seq = Date.now();
  let stickPointer: number | null = null, actionPointer: number | null = null;
  let stickCenter = { x: 0, y: 0 };
  let lastStatus = 0;
  let statusSignature = '';
  let transport: Transport = 'connecting';
  let vibrate = true;
  let lastVibrate = 0;
  let actionStarted = 0;
  let raf = 0;
  let forceJoinNew = false;
  const saved = readSaved<SavedPlayer>('bounce-riot-player');
  const initialRoom = (roomCode || (isStandalone() ? saved?.room : '') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
  root.innerHTML = `
    <main class="phone-page" id="join-view">
      <a href="#home" class="wordmark small" aria-label="Bounce Riot home">bounce<span>riot</span><i class="logo-dot"></i></a>
      <div class="join-hero"><div class="phone-mascot" aria-hidden="true"><i></i><i></i><b></b></div><p class="eyebrow">GOOD FRIENDS. BAD LANDINGS.</p><h1>Your phone.<br>Your superpower.</h1><p>Join the big screen. Make some waves.</p></div>
      <form id="join-form" class="join-form">
        <label for="room-code">Room code on the TV</label><input id="room-code" name="room" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="6" minlength="6" pattern="[A-Za-z0-9]{6}" placeholder="ABC123" value="${escapeHtml(initialRoom)}" required />
        <label for="player-name">What should we call you?</label><input id="player-name" name="name" autocomplete="nickname" maxlength="16" placeholder="Your name" value="${escapeHtml(saved?.name ?? '')}" required />
        <button class="button primary wide" type="submit" id="join-button">Grab a controller <span aria-hidden="true">↗</span></button>
        <p class="form-message" id="join-message" role="status" aria-live="polite"></p>
      </form>
      <p class="phone-fine">Same Wi-Fi is best. Keep the TV game open.<br>No account. No phone app.</p>
      <details class="install-help"><summary>Want a distraction-free controller?</summary><p>${isIOS() ? 'In Safari, tap Share, then Add to Home Screen. Open Bounce Riot from the new icon and enter the same room code.' : 'Tap Enter fullscreen after joining. You can also install this page from your browser menu.'} Calls and system gestures remain controlled by your phone.</p></details>
      <a class="text-link" href="#home">Use this screen as the TV instead</a>
    </main>
    <section class="joypad" id="joypad" aria-label="Bounce Riot controller" hidden>
      <header class="joy-header"><div class="player-badge"><span id="player-number">1</span><div><strong id="controller-name">Player</strong><small id="controller-connection">Connecting</small><small class="identity-chip" id="controller-identity"><i aria-hidden="true"></i><span id="controller-color-name">Picking a colour</span></small></div></div><div class="joy-score"><strong id="controller-score">0</strong><small>POINTS</small></div><button class="icon-button" id="controller-menu" aria-label="Controller menu"><span aria-hidden="true">☰</span></button></header>
      <div class="joy-phase"><span id="controller-phase">Waiting for the TV</span><strong id="controller-time">GET READY</strong></div>
      <div class="control-deck" id="control-deck">
        <div class="move-zone" id="move-zone" role="application" aria-label="Movement pad: drag to move" tabindex="0"><div class="stick-label">MOVE</div><div class="stick-ring"><span class="stick-cross cross-x"></span><span class="stick-cross cross-y"></span><div class="stick-knob" id="stick-knob"><span></span></div></div><p>DRAG ANYWHERE</p></div>
        <div class="action-zone"><div class="action-label">MAKE WAVES</div><button class="slam-button" id="slam-button" aria-label="Tap to hop. Hold and release to slam"><svg class="charge-ring" viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="74"/></svg><span class="slam-glyph" aria-hidden="true"><i></i><i></i><i></i></span><strong id="slam-word">SLAM</strong><small id="slam-hint">HOLD + RELEASE</small></button><p>TAP TO HOP</p></div>
      </div>
      <div class="joy-bottom"><span id="joy-tip">Eyes on the TV. Thumbs right here.</span><button class="captain-action" id="captain-action" hidden>Start the round</button><span class="wake-status" id="wake-status">Screen wake: best effort</span></div>
      <div class="controller-gate" id="controller-gate"><div class="gate-card"><span class="eyebrow">YOU'RE IN</span><h2 id="gate-title">Meet your controller.</h2>
        <div class="identity-reveal" id="identity-reveal" hidden>
          <div class="identity-preview" id="identity-preview"></div>
          <div class="identity-copy"><span class="identity-number" id="identity-number">PLAYER 1</span><strong class="identity-headline" id="identity-headline"></strong><span class="identity-nickname" id="identity-nickname"></span><span class="identity-color" id="identity-color"></span><span class="identity-look" id="identity-look"></span></div>
        </div>
        <p>Left thumb moves. Tap the big button to hop.<br>Hold, then let go to make a bigger wave.</p><button class="button primary wide" id="arm-controller">Enter fullscreen & play</button><p id="fullscreen-hint" class="small-copy">Keep your eyes on the TV.</p></div></div>
      <div class="controller-sheet" id="controller-sheet" hidden><div class="sheet-body"><p class="eyebrow">TAKE A BREATHER</p><h2>Controller menu</h2><button class="button primary wide" id="resume-controller">Back to the game</button><button class="button secondary wide" id="try-fullscreen">Enter fullscreen</button><button class="button secondary wide" id="captain-pause" hidden>Pause round</button><button class="button secondary wide" id="captain-lobby" hidden>Back to lobby</button><button class="button secondary wide" id="captain-add-bot" hidden>Add a practice bot</button><button class="button secondary wide" id="captain-remove-bot" hidden>Remove a practice bot</button><button class="button secondary wide" id="vibration-toggle" aria-pressed="true">Vibration: on</button><p id="ios-install-note" class="small-copy"></p><button class="button text wide" id="leave-controller">Leave room</button><button class="button text wide" id="exit-fullscreen">Exit fullscreen</button></div></div>
      <div class="reconnect-banner" id="reconnect-banner" role="status" hidden>Finding the TV again. Your place is saved.</div>
    </section>`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const joy = $('#joypad'), joinView = $('#join-view'), message = $('#join-message');
  const nameInput = $<HTMLInputElement>('#player-name'), roomInput = $<HTMLInputElement>('#room-code');
  const form = $<HTMLFormElement>('#join-form');
  const moveZone = $('#move-zone'), knob = $('#stick-knob'), slam = $<HTMLButtonElement>('#slam-button');
  const gate = $('#controller-gate'), sheet = $('#controller-sheet'), reconnect = $('#reconnect-banner');
  const phaseText = $('#controller-phase'), timeText = $('#controller-time');
  let identitySlotNow = -1;
  let identityName = '';
  function applyIdentity(slot: number, nickname: string) {
    const identity = playerIdentity(slot);
    identitySlotNow = identity.slot;
    identityName = nickname;
    joy.style.setProperty('--player-color', identity.color);
    $('#player-number').textContent = String(identity.number);
    $('#controller-color-name').textContent = `${identity.colorName.toUpperCase()} PLAYER`;
    $('#identity-preview').innerHTML = identitySvg(identity);
    $('#identity-number').textContent = `PLAYER ${identity.number}`;
    $('#identity-headline').textContent = `You're the ${identity.colorName.toLowerCase()} player.`;
    $('#identity-nickname').textContent = nickname;
    $('#identity-color').textContent = `${identity.colorName} mascot with the ${identity.accessoryLabel}.`;
    $('#identity-look').textContent = 'Look at the TV and find that mascot. The name above it is yours.';
    $('#identity-reveal').hidden = false;
  }
  if (saved && saved.room === initialRoom && typeof saved.slot === 'number') applyIdentity(saved.slot, saved.name ?? '');
  const wake = new WakeKeeper(active => { $('#wake-status').textContent = active ? 'SCREEN AWAKE' : 'WAKE LOCK UNAVAILABLE'; });
  function sendInput() {
    if (!joined || !connection) return;
    connection.send('host', { kind: 'input', seq: ++seq, x: armed ? x : 0, z: armed ? z : 0, action: armed && action, cancel: cancel || !armed });
    cancel = false;
  }
  function neutral() {
    x = z = 0; action = false; cancel = true;
    stickPointer = actionPointer = null;
    knob.style.transform = 'translate(0px,0px)';
    slam.classList.remove('charging');
    sendInput();
  }
  function haptic(pattern: number | number[]) {
    if (!vibrate || !armed || !navigator.vibrate || performance.now() - lastVibrate < 90) return;
    lastVibrate = performance.now(); navigator.vibrate(pattern);
  }
  async function arm() {
    const entered = await fullscreen(joy);
    if (disposed) return;
    accepted = true; armed = true; menuOpen = false;
    gate.hidden = true; sheet.hidden = true;
    document.body.classList.add('joy-active');
    void wake.acquire();
    if (!entered) {
      $('#joy-tip').textContent = isIOS() ? 'No browser bars: use Share > Add to Home Screen.' : 'Fullscreen unavailable. Controller still works here.';
    }
    sendInput();
  }
  function showMenu() {
    menuOpen = true; neutral(); armed = false; sheet.hidden = false;
    $('#captain-pause').hidden = !status?.captain || !['playing', 'paused', 'countdown'].includes(status.phase);
    $('#captain-pause').textContent = status?.phase === 'paused' ? 'Resume round' : 'Pause round';
    $('#captain-lobby').hidden = !status?.captain || status.phase === 'lobby';
    $('#captain-add-bot').hidden = !status?.captain || status.phase !== 'lobby';
    $('#captain-remove-bot').hidden = !status?.captain || status.phase !== 'lobby' || !status.players.some(p => p.bot);
  }
  function renderStatus(next: ControllerStatus) {
    status = next; lastStatus = performance.now();
    const identity = playerIdentity(Number(next.color));
    const nickname = next.name || nameInput.value;
    if (identity.slot !== identitySlotNow || nickname !== identityName) applyIdentity(identity.slot, nickname);
    $('#controller-name').textContent = nickname;
    $('#controller-score').textContent = String(next.score ?? 0);
    phaseText.textContent = next.phase === 'lobby' ? 'THE LOBBY' : next.phase === 'countdown' ? 'READY TO RUMBLE' : next.phase === 'results' ? 'ROUND COMPLETE' : next.phase === 'paused' ? 'TAKE A BREATHER' : 'BOUNCE RIOT';
    timeText.textContent = next.phase === 'countdown' ? String(Math.max(1, Math.ceil(next.countdown))) : next.phase === 'playing' ? `${Math.max(0, Math.ceil(next.remaining))}s` : next.phase === 'results' ? `${next.score} POINTS` : next.phase === 'paused' ? 'PAUSED' : 'GET READY';
    const activePlayers = next.players.filter(p => p.connected || p.bot).length;
    const signature = `${next.phase}|${next.captain}|${activePlayers}`;
    if (signature !== statusSignature) {
      statusSignature = signature;
      const captainButton = $('#captain-action');
      captainButton.hidden = !next.captain || !['lobby', 'results', 'paused'].includes(next.phase);
      captainButton.textContent = next.phase === 'results' ? 'One more round' : next.phase === 'paused' ? 'Resume round' : activePlayers < 2 ? 'Add a practice bot' : 'Start the round';
      $('#joy-tip').textContent = next.phase === 'lobby' ? (next.captain ? 'You are captain. Start when everyone is in.' : 'Your captain will start the round.') : next.phase === 'results' ? 'Shake it off. There is always the next round.' : 'Eyes on the TV. Thumbs right here.';
    }
    reconnect.hidden = true;
  }
  async function join(event: SubmitEvent) {
    event.preventDefault();
    const room = roomInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
    const name = nameInput.value.trim().slice(0, 16);
    if (room.length !== 6 || !name) return;
    $<HTMLButtonElement>('#join-button').disabled = true;
    message.textContent = 'Finding your room...'; message.classList.remove('error');
    connection?.disconnect();
    try {
      const config = await loadServiceConfig();
      if (disposed) return;
      connection = new RoomConnection(config, 'player', {
        onRoom: info => {
          if (disposed) return;
          joined = true;
          save('bounce-riot-player', { room: info.room, token: info.token, name, slot: info.slot });
          history.replaceState(null, '', `${location.pathname}${location.search}#join/${info.room}`);
          joinView.hidden = true; joy.hidden = false; message.textContent = '';
          applyIdentity(info.slot, name);
          $('#controller-name').textContent = name;
          // The seat number and colour now headline the reveal below, so the title stays a quiet lead-in.
          $('#gate-title').textContent = 'Meet your controller.';
          if (accepted && !menuOpen && document.visibilityState === 'visible') {
            if (isStandalone() || document.fullscreenElement || !joy.requestFullscreen) { armed = true; gate.hidden = true; }
            else { armed = false; gate.hidden = false; $('#arm-controller').textContent = 'Resume controller'; }
          }
          if (isIOS() && !isStandalone()) {
            $('#arm-controller').textContent = 'Play in this browser';
            $('#fullscreen-hint').textContent = 'For a full-screen iPhone controller: Share > Add to Home Screen, then reopen this room.';
          }
          connection?.send('host', { kind: 'hello' });
        },
        onPayload: (from, payload) => {
          if (from !== 'host') return;
          if (payload.kind === 'status') renderStatus(payload as unknown as ControllerStatus);
          else if (payload.kind === 'feedback') {
            const e = String(payload.event);
            haptic(e === 'ko' ? [45, 25, 45] : e === 'ride' ? [12, 15, 12] : e === 'slam' ? 25 : 12);
          }
        },
        onTransport: (_id, next) => { transport = next; $('#controller-connection').textContent = next === 'direct' ? 'DIRECT TO TV' : next === 'relay' ? 'CONNECTED VIA RELAY' : 'RECONNECTING'; },
        onConnection: connected => {
          if (joined && !connected && transport !== 'direct') { neutral(); reconnect.hidden = false; }
          if (connected) { message.textContent = ''; $<HTMLButtonElement>('#join-button').disabled = false; }
        },
        onRoster: (_roster, hostOnline) => { if (joined && !hostOnline && transport !== 'direct') { neutral(); reconnect.hidden = false; } },
        onError: (text, code) => {
          message.textContent = text; message.classList.add('error');
          $<HTMLButtonElement>('#join-button').disabled = false;
          if (/token|resume|auth/i.test(code + text)) { forceJoinNew = true; removeSaved('bounce-riot-player'); }
          if (joined) { reconnect.hidden = false; reconnect.textContent = text; }
        },
        onClosed: () => {
          neutral(); joined = false; armed = false;
          joy.hidden = true; joinView.hidden = false;
          $<HTMLButtonElement>('#join-button').disabled = false;
          removeSaved('bounce-riot-player'); forceJoinNew = true;
          message.textContent = 'This room has closed. Enter the new code on the TV.';
        },
      });
      const resumeToken = !forceJoinNew && saved?.room === room ? saved.token : undefined;
      connection.connect({ room, name, token: resumeToken });
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : 'Could not join. Please try again.';
      message.classList.add('error'); $<HTMLButtonElement>('#join-button').disabled = false;
    }
  }
  form.addEventListener('submit', join);
  roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); });
  function moveStick(event: PointerEvent) {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    const radius = Math.max(28, root.querySelector<HTMLElement>('.stick-ring')!.clientWidth * 0.44);
    const dx = event.clientX - stickCenter.x, dy = event.clientY - stickCenter.y;
    const length = Math.hypot(dx, dy), scale = length > radius ? radius / length : 1;
    x = Math.max(-1, Math.min(1, dx / radius)); z = Math.max(-1, Math.min(1, dy / radius));
    const mag = Math.hypot(x, z); if (mag > 1) { x /= mag; z /= mag; }
    if (mag < 0.06) { x = z = 0; }
    knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
  }
  moveZone.addEventListener('pointerdown', event => {
    if (!armed || stickPointer !== null) return;
    event.preventDefault(); stickPointer = event.pointerId;
    moveZone.setPointerCapture(event.pointerId);
    stickCenter = { x: event.clientX, y: event.clientY }; x = z = 0;
  });
  moveZone.addEventListener('pointermove', moveStick);
  moveZone.addEventListener('pointerup', event => {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null; x = z = 0; knob.style.transform = 'translate(0px,0px)'; sendInput();
  });
  moveZone.addEventListener('pointercancel', neutral);
  moveZone.addEventListener('lostpointercapture', () => { if (stickPointer !== null) { stickPointer = null; x = z = 0; knob.style.transform = 'translate(0px,0px)'; sendInput(); } });
  slam.addEventListener('pointerdown', event => {
    if (!armed || actionPointer !== null) return;
    event.preventDefault(); actionPointer = event.pointerId; slam.setPointerCapture(event.pointerId);
    action = true; actionStarted = performance.now(); slam.classList.add('charging'); haptic(8); sendInput();
  });
  slam.addEventListener('pointerup', event => {
    if (event.pointerId !== actionPointer) return;
    event.preventDefault(); actionPointer = null; action = false; slam.classList.remove('charging'); sendInput();
  });
  slam.addEventListener('pointercancel', neutral);
  slam.addEventListener('lostpointercapture', () => { if (actionPointer !== null) neutral(); });
  $('#arm-controller').addEventListener('click', () => void arm());
  $('#controller-menu').addEventListener('click', showMenu);
  $('#resume-controller').addEventListener('click', () => void arm());
  $('#try-fullscreen').addEventListener('click', () => void arm());
  $('#captain-action').addEventListener('click', () => {
    if (status?.captain) connection?.send('host', { kind: 'command', command: status.phase === 'lobby' && status.players.filter(p => p.connected || p.bot).length < 2 ? 'addbot' : status.phase === 'results' ? 'rematch' : status.phase === 'paused' ? 'resume' : 'start' });
  });
  $('#captain-pause').addEventListener('click', () => { if (status?.captain) connection?.send('host', { kind: 'command', command: status.phase === 'paused' ? 'resume' : 'pause' }); void arm(); });
  $('#captain-lobby').addEventListener('click', () => { if (status?.captain) connection?.send('host', { kind: 'command', command: 'lobby' }); void arm(); });
  $('#captain-add-bot').addEventListener('click', () => { if (status?.captain) connection?.send('host', { kind: 'command', command: 'addbot' }); void arm(); });
  $('#captain-remove-bot').addEventListener('click', () => { if (status?.captain) connection?.send('host', { kind: 'command', command: 'removebot' }); void arm(); });
  $('#vibration-toggle').addEventListener('click', () => { vibrate = !vibrate; $('#vibration-toggle').textContent = `Vibration: ${vibrate ? 'on' : 'off'}`; $('#vibration-toggle').setAttribute('aria-pressed', String(vibrate)); });
  $('#leave-controller').addEventListener('click', () => {
    neutral(); connection?.disconnect(true); joined = false; armed = false; removeSaved('bounce-riot-player');
    void document.exitFullscreen?.().catch(() => {}); location.hash = 'join';
  });
  $('#exit-fullscreen').addEventListener('click', () => {
    neutral(); armed = false; menuOpen = false; sheet.hidden = true; gate.hidden = false;
    document.body.classList.remove('joy-active'); void document.exitFullscreen?.().catch(() => {});
    $('#gate-title').textContent = 'Controller paused.'; $('#arm-controller').textContent = 'Return to controller';
  });
  $('#ios-install-note').textContent = isIOS() && !isStandalone() ? 'iPhone fullscreen: Share > Add to Home Screen. Open the icon, then rejoin this room. Your player slot is saved in this browser.' : 'Calls and system navigation are controlled by your phone. Return here to reconnect.';
  const visibility = () => {
    if (document.visibilityState === 'hidden') { neutral(); armed = false; }
    else if (joined && accepted) {
      gate.hidden = false; $('#gate-title').textContent = 'Welcome back.'; $('#arm-controller').textContent = 'Resume controller';
      connection?.send('host', { kind: 'hello' });
    }
  };
  const fullscreenChange = () => {
    if (!document.fullscreenElement && accepted && !isStandalone() && !menuOpen) {
      neutral(); armed = false; gate.hidden = false;
      $('#gate-title').textContent = 'Controller paused.'; $('#arm-controller').textContent = 'Return to fullscreen';
    }
  };
  const preventGesture = (event: Event) => { if (armed && joy.contains(event.target as Node)) event.preventDefault(); };
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('fullscreenchange', fullscreenChange);
  joy.addEventListener('contextmenu', preventGesture);
  joy.addEventListener('touchmove', preventGesture, { passive: false });
  joy.addEventListener('gesturestart', preventGesture);
  const inputTimer = setInterval(() => {
    if (joined && document.visibilityState === 'visible') sendInput();
    if (joined && lastStatus > 0 && performance.now() - lastStatus > 5000) reconnect.hidden = false;
  }, 50);
  function frame() {
    if (disposed) return;
    const progress = action && armed ? Math.min(1, Math.max(0, (performance.now() - actionStarted - 180) / 850)) : 0;
    slam.style.setProperty('--charge', String(progress));
    $('#slam-word').textContent = progress > 0.12 ? (progress >= 1 ? 'LET GO!' : 'CHARGE') : 'SLAM';
    $('#slam-hint').textContent = progress > 0.12 ? 'RELEASE TO MAKE A WAVE' : 'HOLD + RELEASE';
    const cooling = (status?.cooldown ?? 0) > 0.1 && !action;
    slam.classList.toggle('cooling', cooling);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return () => {
    disposed = true; neutral(); connection?.disconnect(); wake.dispose();
    clearInterval(inputTimer); cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', visibility); document.removeEventListener('fullscreenchange', fullscreenChange);
    document.body.classList.remove('controller-mode', 'joy-active');
  };
}
