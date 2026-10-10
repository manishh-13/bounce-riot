# Privacy and network behaviour

Bounce Riot does not include advertising, analytics, user accounts, chat, camera access or microphone access.

## Temporary room information
The room service processes a room code, short nicknames, assigned player slots, temporary connection identifiers and reconnect-token hashes. Active room information expires after two hours. Database TTL deletion is asynchronous, so expired records can remain physically stored until the database removes them; the service rejects them once they are expired.

Messages carrying controller input, WebRTC connection setup or game status are forwarded to the other participant. Payloads and reconnect tokens must not be written to application logs. Infrastructure can process IP addresses and operational request metadata as part of normal connection handling and abuse prevention.

Direct WebRTC connections necessarily expose network connection information to the TV and connected controller. The default STUN service assists connection discovery. It does not receive game graphics or serve as the gameplay relay. If a direct connection is unavailable, the room service forwards the input over TLS-protected WebSockets.

## Browser storage
The browser stores sound/graphics preferences and a random reconnect credential so a phone can recover its seat. Choosing Leave room clears the saved player credential. Host room closing clears the host credential. These values are not publicly committed or included in URLs.

A service worker may cache the static game files for faster loading and offline practice after a successful load. It does not cache the room-service configuration, WebSocket messages or game sessions. Normal browser site-data controls can clear stored preferences and cached files.

## Hosting
The static game is served by GitHub Pages, which has its own hosting and request-processing policies. The default room service uses AWS. Hosts of forks control their own deployment. Do not put confidential information into player nicknames.

## Limits
A webpage cannot block incoming calls, system notifications, screen-lock policy or home gestures. Fullscreen and wake lock are best-effort browser capabilities and can be revoked by the user or operating system.
