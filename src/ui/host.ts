import QRCode from 'qrcode';
import { GameSimulation, ARENAS } from '../game/simulation';
import { PLAYER_COLORS, type ArenaId, type Input, type PlayerSpec } from '../game/types';
import { ArenaScene } from '../render/scene';
import { loadServiceConfig, RoomConnection, type Member } from '../net/room';
import { GameAudio } from './audio';
import { identitySvg, playerIdentity } from './player-identity';
import { InputBuffer } from '../net/input-buffer';
import { escapeHtml, fullscreen, readSaved, save, removeSaved, WakeKeeper, enableRemoteNavigation } from './helpers';

interface StoredHost { room: string; token: string; }
const BOT_NAMES = ['Peaches', 'Mochi', 'Pickle', 'Waffles', 'Noodle', 'Tater', 'Sprout', 'Bubbles'];
export function mountHost(root: HTMLElement, practiceImmediately = false): () => void {
  document.body.classList.add('host-mode');
  let disposed = false, home = true, practice = false, help = false;
  let connection: RoomConnection | undefined;
  let roster: Member[] = [], bots = 3, keyboard = false, room = '';
  let currentPhase = '', lastScore = '', lastStatus = 0, lastEvent = 0;
  let lastTime = performance.now(), frames = 0, frameClock = 0, fps = 60, accumulator = 0;
  let feedback = '', feedbackUntil = 0, connectionHealthy = false;
  let joinNoticeUntil = 0;
  let raf = 0, quality: 'auto' | 'low' | 'high' = readSaved<'auto' | 'low' | 'high'>('bounce-riot-quality') ?? 'auto';
  let roundLength = 90, arena: ArenaId = 'springyard';
  const remoteInputs = new InputBuffer();
  const keys = new Set<string>();
  let localCancel = false;
  const sim = new GameSimulation({ duration: roundLength, arena, seed: 1729 });
  const demo = new GameSimulation({ duration: 120, seed: 25 });
  demo.setPlayers(BOT_NAMES.slice(0, 4).map((name, i) => ({ id: `demo-${i}`, name, color: i, bot: true, connected: true })));
  demo.start();
  root.innerHTML = `
    <main class="host-shell">
      <div class="arena-view" id="arena-view" aria-label="3D trampoline arena"></div>
      <header class="host-header"><a class="wordmark" href="#home" aria-label="Bounce Riot home">bounce<span>riot</span><i class="logo-dot"></i></a><div class="header-right"><span class="tiny-label">THE LIVING ROOM IS THE ARENA</span><button class="icon-button" id="sound-toggle" aria-label="Toggle game sound" aria-pressed="true">SOUND ON</button><button class="icon-button" id="fullscreen-button" aria-label="Fullscreen">FULLSCREEN ↗</button></div></header>
      <section class="home-panel" id="home-panel">
        <div class="edition"><span class="live-dot"></span> THE COUCH COMPETITION CLUB <span>VOL. 01</span></div>
        <h1>Good friends.<br><em>Bad landings.</em></h1>
        <p class="hero-copy">A trampoline. Your friends. Absolutely no mercy.<br>Make waves with your phone as the controller.</p>
        <div class="hero-actions"><button class="button primary jumbo" id="host-button">Host a party <span aria-hidden="true">↗</span></button><button class="button secondary" id="practice-button">Try it with bots</button></div>
        <a class="join-link" href="#join">Got a room code? <strong>Join on your phone ↗</strong></a>
        <div class="home-facts"><span><b>2 to 8</b> FRIENDS</span><span><b>90</b> SECONDS</span><span><b>0</b> CONTROLLERS TO BUY</span></div>
      </section>
      <div class="hero-sticker" id="hero-sticker"><span>THE FLOOR</span><strong>FIGHTS<br>BACK.</strong><i aria-hidden="true">↘</i></div>
      <div class="scene-caption" id="scene-caption"><span class="caption-line"></span> SPRINGYARD <span>HOLD. RELEASE. RIOT.</span></div>
      <section class="lobby-panel" id="lobby-panel" hidden>
        <p class="eyebrow" id="lobby-eyebrow">INVITE THE ROOM</p><h1 id="lobby-title">The more,<br>the messier.</h1>
        <div class="room-card" id="room-card"><canvas id="qr-code" aria-label="Scan to join this room"></canvas><div><span class="tiny-label">SCAN WITH YOUR PHONE</span><strong class="room-code" id="room-code-display">...</strong><a id="join-room-link" target="_blank" rel="noopener">Or open the join page ↗</a></div></div>
        <p class="room-status" id="room-status" role="status">Opening a room...</p>
        <div class="lobby-roster" id="lobby-roster" aria-label="Players in room"></div>
        <div class="lobby-options"><label>Arena<select id="arena-select"><option value="springyard">Springyard</option><option value="moonbounce">Moonbounce</option><option value="aftershock">Aftershock</option></select></label><label>Round<select id="duration-select"><option value="30">30 seconds</option><option value="60">60 seconds</option><option value="90" selected>90 seconds</option><option value="120">120 seconds</option></select></label></div>
        <div class="bot-controls"><span><b id="bot-count">3</b> practice bots</span><div><button id="remove-bot" class="round-button" aria-label="Remove a bot">−</button><button id="add-bot" class="round-button" aria-label="Add a bot">+</button></div><button class="text-button" id="keyboard-toggle">Add keyboard player</button></div>
        <button class="button primary wide" id="start-button" disabled>Waiting for a player</button>
        <div class="lobby-footer"><button class="text-button" id="how-button">How to play</button><button class="text-button" id="close-room-button">Back home</button></div>
      </section>
      <div class="join-announcement" id="join-announcement" role="status" hidden></div>
      <section class="play-hud" id="play-hud" hidden aria-label="Match scoreboard"><div class="score-strip" id="score-strip"></div><div class="match-clock"><span id="round-label">ROUND 1</span><strong id="match-time">90</strong><small>SECONDS</small></div></section>
      <div class="round-callout" id="round-callout" hidden aria-live="polite"><span id="callout-kicker">READY TO MAKE WAVES?</span><strong id="callout-text">3</strong></div>
      <div class="match-bottom" id="match-bottom" hidden><div><span id="match-room">PRACTICE ROUND</span><small id="match-controls">WASD / ARROWS TO MOVE · TAP SPACE TO HOP · HOLD + RELEASE TO SLAM</small></div><button class="button compact secondary" id="pause-button">Pause</button></div>
      <div class="event-toast" id="event-toast" hidden></div>
      <section class="result-panel" id="result-panel" hidden><p class="eyebrow">THAT WAS PERSONAL</p><h1 id="winner-name">Nice waves.</h1><p id="winner-subtitle">Same friends. One more round.</p><ol class="results-list" id="results-list"></ol><div class="result-actions"><button class="button primary" id="rematch-button">One more round ↗</button><button class="button secondary" id="lobby-button">Back to lobby</button></div></section>
      <section class="pause-panel" id="pause-panel" hidden><p class="eyebrow">TAKE A BREATHER</p><h1>Riot on hold.</h1><p>Your friends can wait a second.</p><button class="button primary wide" id="resume-button">Back to the brawl</button><button class="button secondary wide" id="pause-lobby-button">Back to lobby</button></section>
      <section class="help-panel" id="help-panel" hidden><p class="eyebrow">A LITTLE FRIENDLY ADVICE</p><h1>Make waves.<br>Not excuses.</h1><div class="how-row"><b>01</b><div><h3>Move with your left thumb.</h3><p>Stay away from the edge. The lagoon is not your friend.</p></div></div><div class="how-row"><b>02</b><div><h3>Hold. Release. Slam.</h3><p>Charge the big button, then let go. Bigger charge, bigger wave. You move slower while charging.</p></div></div><div class="how-row"><b>03</b><div><h3>Tap to hop over a wave.</h3><p>Catch it in the air for a boost. Turn their attack into your next move.</p></div></div><p class="scoring-note">Knock someone out: +2 points. Fall on your own: −1 point (never below zero). Everyone respawns. Most points wins.</p><button class="button primary wide" id="help-close">Got it. Let's bounce.</button></section>
      <footer class="host-footer" id="host-footer"><span>MADE FOR PEOPLE IN THE SAME ROOM.</span><div><button class="text-button" id="quality-toggle">GRAPHICS: AUTO</button><button class="text-button" id="about-toggle">ABOUT & PRIVACY</button><span id="fps-counter"></span></div></footer>
      <section class="about-panel" id="about-panel" hidden><h2>A small game. A big room.</h2><p>Bounce Riot is a free, open-source party game by Manish. Your TV runs the game. Your phone sends the moves.</p><p>Room joining needs internet. Direct connections are attempted first; encrypted WebSocket relay is the fallback. Room access expires after two hours; temporary database records are then removed asynchronously. No ads, accounts, analytics or microphone/camera access.</p><p>Current Chrome-based browsers are recommended. Android TV hardware varies. Use Low graphics if needed. Calls and system gestures cannot be blocked by a webpage.</p><a class="text-link" href="https://github.com/manishh-13/bounce-riot" target="_blank" rel="noopener">Source code and setup ↗</a><button class="button primary wide" id="about-close">Back to the good times</button></section>
      <p class="global-notice" id="global-notice" role="status" hidden></p>
    </main>`;
  root.inert = true;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const sceneContainer = $('#arena-view');
  let scene: ArenaScene;
  try { scene = new ArenaScene(sceneContainer, { quality, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }); }
  catch (error) { throw new Error(`WebGL could not start: ${error instanceof Error ? error.message : error}`); }
  const audio = new GameAudio();
  audio.enabled = readSaved<boolean>('bounce-riot-sound') ?? true;
  const wake = new WakeKeeper();
  const stopNavigation = enableRemoteNavigation(root, () => { if (!home && sim.state.phase === 'playing') sim.pause(); });
  function setNotice(text: string) { $('#global-notice').textContent = text; $('#global-notice').hidden = !text; }
  function playerSpecs(): PlayerSpec[] {
    const specs: PlayerSpec[] = roster.map(m => ({ id: m.id, name: m.name, color: m.slot, connected: m.connected }));
    const colors = new Set(specs.map(p => p.color));
    const nextColor = () => { const c = [...Array(8).keys()].find(c => !colors.has(c)) ?? 0; colors.add(c); return c; };
    if (keyboard && specs.length < 8) specs.push({ id: 'keyboard', name: 'You', color: nextColor(), connected: true });
    const botSlots = Math.min(bots, 8 - specs.length);
    for (let i = 0; i < botSlots; i++) specs.push({ id: `bot-${i}`, name: BOT_NAMES[i], color: nextColor(), bot: true, connected: true });
    return specs;
  }
  function syncPlayers() { sim.setPlayers(playerSpecs()); renderRoster(); sendStatuses(); }
  function captainId() { return roster.find(m => m.connected)?.id; }
  function renderRoster() {
    const players = sim.state.players;
    $('#lobby-roster').innerHTML = players.map(p => `<div class="roster-player ${p.connected === false ? 'disconnected' : ''}" style="--player-color:${PLAYER_COLORS[p.color % 8]}"><span class="roster-avatar" aria-hidden="true">${identitySvg(playerIdentity(p.color))}</span><div><strong>${escapeHtml(p.name)}</strong><small>${p.color + 1} · ${playerIdentity(p.color).colorName.toUpperCase()} · ${p.bot ? 'BOT' : p.id === 'keyboard' ? 'KEYBOARD' : p.connected === false ? 'OFFLINE' : p.id === captainId() ? 'CAPTAIN' : 'READY'}</small></div>${!p.bot && p.id !== 'keyboard' ? `<button class="kick-button" data-kick="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)}">×</button>` : ''}</div>`).join('') + (players.length === 0 ? '<div class="empty-roster">Your friends will appear here.<br>Scan the QR code to grab a controller.</div>' : '');
    $('#lobby-roster').querySelectorAll<HTMLButtonElement>('[data-kick]').forEach(button => button.addEventListener('click', () => connection?.kick(button.dataset.kick!)));
    const humans = players.filter(p => !p.bot && p.connected !== false).length;
    const activePlayers = players.filter(p => p.bot || p.connected !== false).length;
    const canStart = activePlayers >= 2 && humans >= 1;
    $<HTMLButtonElement>('#start-button').disabled = !canStart;
    $('#start-button').textContent = canStart ? `Let's bounce · ${players.length} players ↗` : humans === 0 ? 'Waiting for a player' : 'Add a friend or a bot';
    $('#bot-count').textContent = String(players.filter(p => p.bot).length);
    $<HTMLButtonElement>('#add-bot').disabled = players.length >= 8;
    $<HTMLButtonElement>('#remove-bot').disabled = bots === 0;
    $('#keyboard-toggle').textContent = keyboard ? 'Remove keyboard player' : 'Add keyboard player';
    $<HTMLButtonElement>('#keyboard-toggle').disabled = !keyboard && roster.length >= 8;
  }
  function setHome(value: boolean) {
    home = value; root.classList.toggle('in-game', !value);
    $('#home-panel').hidden = !value; $('#hero-sticker').hidden = !value; $('#scene-caption').hidden = !value;
    $('#host-footer').hidden = !value; root.classList.toggle('lobby', !value && sim.state.phase === 'lobby');
    currentPhase = ''; renderPhase(); scene.resize();
  }
  async function startHosting(reuse = true) {
    practice = false; keyboard = false; roster = []; bots = 0; sim.reset(); syncPlayers(); setHome(false);
    $('#room-card').hidden = false; $('#lobby-title').innerHTML = 'The more,<br>the messier.'; $('#lobby-eyebrow').textContent = 'INVITE THE ROOM';
    $('#room-code-display').textContent = '...'; $('#room-status').textContent = 'Opening a room...'; setNotice('');
    void audio.unlock(); void wake.acquire();
    try {
      const config = await loadServiceConfig(); if (disposed) return;
      connection?.disconnect();
      connection = new RoomConnection(config, 'host', {
        onRoom: info => {
          if (disposed) return;
          room = info.room; save('bounce-riot-host', { room: info.room, token: info.token });
          $('#room-code-display').textContent = room;
          const url = new URL(location.href); url.hash = `join/${room}`;
          $('#join-room-link').setAttribute('href', url.href);
          void QRCode.toCanvas($<HTMLCanvasElement>('#qr-code'), url.href, { width: 180, margin: 1, color: { dark: '#223e36', light: '#fffaf0' }, errorCorrectionLevel: 'M' });
          $('#room-status').textContent = 'Same Wi-Fi is best. Scan to join, no phone app.';
          $('#match-room').textContent = `ROOM ${room}`;
          setNotice('');
        },
        onRoster: next => {
          const newcomer = next.find(member => member.connected && !roster.some(previous => previous.id === member.id && previous.connected));
          if (newcomer && sim.state.phase === 'lobby') {
            const identity = playerIdentity(newcomer.slot);
            const announcement = $('#join-announcement');
            announcement.textContent = `${newcomer.name} is ${identity.colorName} · Player ${identity.number}`;
            announcement.style.setProperty('--player-color', identity.color);
            joinNoticeUntil = performance.now() + 4500;
          }
          for (const member of roster) if (!next.some(m => m.id === member.id && m.connected)) remoteInputs.remove(member.id);
          roster = next; syncPlayers();
        },
        onPayload: (from, data) => {
          if (!roster.some(m => m.id === from && m.connected)) return;
          if (data.kind === 'input') {
            remoteInputs.accept(from, data, performance.now());
          } else if (data.kind === 'command' && from === captainId()) {
            if (data.command === 'start' && sim.state.phase === 'lobby') startRound();
            else if (data.command === 'rematch' && sim.state.phase === 'results') startRound();
            else if (data.command === 'pause') sim.pause();
            else if (data.command === 'resume') sim.resume();
            else if (data.command === 'lobby') backToLobby();
            else if (data.command === 'addbot' && sim.state.phase === 'lobby' && sim.state.players.length < 8) { bots++; syncPlayers(); }
            else if (data.command === 'removebot' && sim.state.phase === 'lobby') { bots = Math.max(0, bots - 1); syncPlayers(); }
          } else if (data.kind === 'hello') sendStatuses();
        },
        onConnection: okay => { connectionHealthy = okay; if (!okay && !home) setNotice('Room service reconnecting. Direct controllers can keep playing.'); },
        onError: (text, code) => {
          $('#room-status').textContent = text;
          if (['invalid-token', 'room-not-found', 'room-expired'].includes(code) && reuse && sim.state.phase === 'lobby') {
            removeSaved('bounce-riot-host'); void startHosting(false);
          } else setNotice(text);
        },
        onClosed: () => { setNotice('The room closed. Open a new party to reconnect your phones.'); },
      });
      const saved = reuse ? readSaved<StoredHost>('bounce-riot-host') : null;
      connection.connect(saved ? { room: saved.room, token: saved.token } : {});
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Room service unavailable. Try practice while it reconnects.';
      $('#room-status').textContent = text; setNotice(text);
    }
  }
  function startPractice() {
    connection?.disconnect(); connection = undefined; room = ''; roster = []; practice = true; keyboard = true; bots = 3;
    sim.reset(); syncPlayers(); setHome(false);
    $('#room-card').hidden = true; $('#room-status').textContent = 'You are the coral player. WASD or arrows move; Space hops or charges a slam.';
    $('#lobby-eyebrow').textContent = 'A LITTLE WARM-UP'; $('#lobby-title').innerHTML = 'Meet your<br>practice rivals.';
    void audio.unlock(); void wake.acquire();
  }
  function startRound() {
    if (sim.state.players.filter(p => p.bot || p.connected !== false).length < 2 || !sim.state.players.some(p => !p.bot && p.connected !== false)) return;
    keys.clear(); remoteInputs.clear(); localCancel = true;
    sim.setOptions({ arena, duration: roundLength }); sim.start(); help = false; $('#help-panel').hidden = true;
    renderPhase(); renderHud();
    void audio.unlock(); void wake.acquire(); sendStatuses();
  }
  function backToLobby() { keys.clear(); sim.reset(); syncPlayers(); currentPhase = ''; renderPhase(); }
  function sendStatuses() {
    if (!connection) return;
    const s = sim.state;
    const players = s.players.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected !== false, bot: !!p.bot }));
    for (const member of roster) {
      if (!member.connected) continue;
      const p = s.players.find(p => p.id === member.id);
      connection.send(member.id, { kind: 'status', phase: s.phase, remaining: s.remaining, countdown: s.countdown, score: p?.score ?? 0, name: member.name, color: member.slot, charge: p?.charge ?? 0, cooldown: p?.cooldown ?? 0, captain: member.id === captainId(), players });
    }
  }
  function renderPhase() {
    const phase = home ? 'home' : sim.state.phase;
    if (phase === currentPhase) return;
    currentPhase = phase;
    $('#lobby-panel').hidden = phase !== 'lobby';
    $('#play-hud').hidden = !['countdown', 'playing', 'paused'].includes(phase);
    $('#match-bottom').hidden = !['countdown', 'playing', 'paused'].includes(phase);
    $('#pause-panel').hidden = phase !== 'paused';
    $('#result-panel').hidden = phase !== 'results';
    $('#round-callout').hidden = phase !== 'countdown';
    root.classList.toggle('lobby', phase === 'lobby');
    const matchActive = ['countdown', 'playing', 'paused', 'results'].includes(phase);
    root.classList.toggle('match-active', matchActive);
    scene.setMatchView(matchActive);
    if (phase === 'results') renderResults();
    if (phase === 'lobby') renderRoster();
    $('#match-room').textContent = practice ? 'PRACTICE ROUND' : `ROOM ${room}`;
    $('#match-controls').textContent = keyboard ? 'WASD / ARROWS TO MOVE · TAP SPACE TO HOP · HOLD + RELEASE TO SLAM' : 'MOVE WITH YOUR LEFT THUMB · TAP TO HOP · HOLD + RELEASE TO SLAM';
    sendStatuses();
    scene.resize();
  }
  function renderResults() {
    const players = [...sim.state.players].sort((a, b) => b.score - a.score || b.knockouts - a.knockouts || a.falls - b.falls);
    const winners = players.filter(p => sim.state.winnerIds.includes(p.id));
    $('#winner-name').textContent = winners.length > 1 ? 'A beautiful tie.' : `${winners[0]?.name ?? players[0]?.name ?? 'Nobody'} makes waves.`;
    $('#winner-subtitle').textContent = winners.length > 1 ? 'Even after the tiebreak. Share the glory.' : 'Most points wins. Ties: knockouts, then fewer falls.';
    $('#results-list').innerHTML = players.map((p, i) => `<li style="--player-color:${PLAYER_COLORS[p.color % 8]}"><span class="result-rank">${i + 1}</span><span class="result-dot"></span><div><strong>${escapeHtml(p.name)}</strong><small>${p.knockouts} KNOCKOUTS · ${p.rides} WAVES RIDDEN</small></div><b>${p.score}<small>PTS</small></b></li>`).join('');
  }
  function renderHud() {
    const s = sim.state;
    $('#match-time').textContent = String(Math.max(0, Math.ceil(s.remaining)));
    $('#match-time').classList.toggle('last-seconds', s.remaining <= 10);
    $('#round-label').textContent = `ROUND ${s.round}`;
    if (s.phase === 'countdown') $('#callout-text').textContent = String(Math.max(1, Math.ceil(s.countdown)));
    const signature = s.players.map(p => `${p.id}:${p.score}:${p.respawnIn > 0}`).join('|');
    if (signature !== lastScore) {
      lastScore = signature;
      $('#score-strip').classList.toggle('crowded', s.players.length > 4);
      $('#score-strip').innerHTML = s.players.map(p => `<div class="score-item ${p.respawnIn > 0 ? 'out' : ''}" style="--player-color:${PLAYER_COLORS[p.color % 8]}"><span>${escapeHtml(p.name)}</span><strong>${p.score}</strong></div>`).join('');
    }
    for (const event of s.events) {
      if (event.id <= lastEvent) continue;
      lastEvent = event.id;
      const player = s.players.find(p => p.id === event.playerId);
      if (roster.some(m => m.id === event.playerId && m.connected) && ['ko', 'ride', 'hit', 'slam', 'respawn'].includes(event.type)) connection?.send(event.playerId, { kind: 'feedback', event: event.type });
      if (event.type === 'ko') {
        feedback = event.otherId ? `${s.players.find(p => p.id === event.otherId)?.name ?? 'A rival'} sends ${player?.name ?? 'someone'} flying!` : `${player?.name ?? 'Someone'} made a splash.`;
        feedbackUntil = performance.now() + 2200;
      } else if (event.type === 'ride') { feedback = `${player?.name ?? 'Someone'} caught the wave!`; feedbackUntil = performance.now() + 1400; }
    }
    $('#event-toast').hidden = performance.now() > feedbackUntil || home || !['playing', 'countdown'].includes(s.phase);
    $('#event-toast').textContent = feedback;
  }
  function tick(now: number) {
    if (disposed) return;
    const dt = Math.min(0.08, Math.max(0, (now - lastTime) / 1000)); lastTime = now;
    frames++; frameClock += dt;
    if (frameClock >= 1) { fps = Math.round(frames / frameClock); frames = 0; frameClock = 0; $('#fps-counter').textContent = `${fps} FPS`; }
    if (home) {
      if (demo.state.phase === 'results') demo.start();
      demo.step(dt); scene.render(demo.state, dt);
    } else {
      accumulator = Math.min(0.1, accumulator + dt);
      while (accumulator >= 1 / 60) {
        const inputs: Record<string, Input> = {};
        for (const member of roster) inputs[member.id] = remoteInputs.read(member.id, now, member.connected);
        if (keyboard) inputs.keyboard = { x: (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0), z: (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0) - (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0), action: keys.has('Space'), cancel: localCancel };
        sim.step(1 / 60, inputs); localCancel = false; accumulator -= 1 / 60;
      }
      scene.render(sim.state, dt); audio.consume(sim.state.events); renderPhase(); renderHud();
      if (now - lastStatus > 250) { lastStatus = now; sendStatuses(); }
    }
    $('#join-announcement').hidden = home || sim.state.phase !== 'lobby' || now > joinNoticeUntil;
    raf = requestAnimationFrame(tick);
  }
  $('#host-button').addEventListener('click', () => void startHosting());
  $('#practice-button').addEventListener('click', startPractice);
  $('#start-button').addEventListener('click', startRound);
  $('#rematch-button').addEventListener('click', startRound);
  $('#lobby-button').addEventListener('click', backToLobby);
  $('#pause-lobby-button').addEventListener('click', backToLobby);
  $('#add-bot').addEventListener('click', () => { if (sim.state.players.length < 8) bots++; syncPlayers(); });
  $('#remove-bot').addEventListener('click', () => { bots = Math.max(0, bots - 1); syncPlayers(); });
  $('#keyboard-toggle').addEventListener('click', () => { keyboard = !keyboard; syncPlayers(); });
  $<HTMLSelectElement>('#arena-select').addEventListener('change', event => { arena = (event.target as HTMLSelectElement).value as ArenaId; sim.setOptions({ arena }); $('#room-status').textContent = ARENAS[arena].description; });
  $<HTMLSelectElement>('#duration-select').addEventListener('change', event => { roundLength = Number((event.target as HTMLSelectElement).value); sim.setOptions({ duration: roundLength }); });
  $('#pause-button').addEventListener('click', () => { keys.clear(); localCancel = true; sim.pause(); });
  $('#resume-button').addEventListener('click', () => sim.resume());
  $('#how-button').addEventListener('click', () => { help = true; $('#help-panel').hidden = false; });
  $('#help-close').addEventListener('click', () => { help = false; $('#help-panel').hidden = true; });
  $('#fullscreen-button').addEventListener('click', () => { void fullscreen(); void wake.acquire(); void audio.unlock(); });
  function soundLabel() { $('#sound-toggle').textContent = audio.enabled ? 'SOUND ON' : 'SOUND OFF'; $('#sound-toggle').setAttribute('aria-pressed', String(audio.enabled)); }
  $('#sound-toggle').addEventListener('click', () => { audio.setEnabled(!audio.enabled); save('bounce-riot-sound', audio.enabled); soundLabel(); void audio.unlock(); }); soundLabel();
  $('#quality-toggle').textContent = `GRAPHICS: ${quality.toUpperCase()}`;
  $('#quality-toggle').addEventListener('click', () => { quality = quality === 'auto' ? 'low' : quality === 'low' ? 'high' : 'auto'; scene.setQuality(quality); save('bounce-riot-quality', quality); $('#quality-toggle').textContent = `GRAPHICS: ${quality.toUpperCase()}`; });
  $('#about-toggle').addEventListener('click', () => $('#about-panel').hidden = false);
  $('#about-close').addEventListener('click', () => $('#about-panel').hidden = true);
  $('#close-room-button').addEventListener('click', () => { connection?.disconnect(true); connection = undefined; removeSaved('bounce-riot-host'); roster = []; room = ''; sim.reset(); setNotice(''); setHome(true); });
  const keydown = (event: KeyboardEvent) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName) || home || help) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space'].includes(event.code) && ['playing', 'countdown'].includes(sim.state.phase) && keyboard) {
      event.preventDefault(); event.stopPropagation(); keys.add(event.code);
    }
    if (event.code === 'KeyP' && !event.repeat) { if (sim.state.phase === 'paused') sim.resume(); else sim.pause(); }
  };
  const keyup = (event: KeyboardEvent) => { keys.delete(event.code); };
  const blur = () => { keys.clear(); localCancel = true; };
  const visibility = () => { if (document.hidden && !home) { blur(); sim.pause(); sendStatuses(); } };
  window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
  const resize = () => scene.resize(); window.addEventListener('resize', resize);
  // Development-only inspection surface, excluded from the production bundle by Vite.
  if (import.meta.env.DEV) (window as unknown as { __bounce?: unknown }).__bounce = { sim, scene, startRound, backToLobby, get room() { return room; }, get connectionHealthy() { return connectionHealthy; }, inputs: remoteInputs };
  root.inert = false;
  raf = requestAnimationFrame(tick);
  if (practiceImmediately) startPractice();
  return () => {
    disposed = true; cancelAnimationFrame(raf); connection?.disconnect(); wake.dispose(); scene.dispose(); audio.dispose(); stopNavigation();
    window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', resize);
    delete (window as unknown as { __bounce?: unknown }).__bounce;
    document.body.classList.remove('host-mode');
  };
}
