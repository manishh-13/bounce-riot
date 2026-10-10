# Bounce Riot room service

Signaling and relay fallback for phone controllers. The same hub (`hub.mjs`) runs locally (`local.mjs`, in-memory store) and on AWS (`lambda.mjs`, DynamoDB store). The protocol is defined in `docs/BUILD-CONTRACT.md`. Additions: `created`, `joined` and `roster` carry `version` (increases with each room write, so clients can ignore older rosters), and the error codes are listed below.

## Run locally

```
npm run signal          # ws://localhost:4382, GET /health -> {"ok":true,...}
```

Environment: `BR_SIGNAL_PORT` (4382), `BR_SIGNAL_HOST` (0.0.0.0), `BR_ALLOWED_ORIGINS` (default `https://manishh-13.github.io,local-dev`; `local-dev` admits http(s) pages on localhost or a private LAN IP; a missing Origin is allowed locally only).

## Security model

- The server issues every identity: room code (6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, `crypto.randomInt`), player id, and 256-bit tokens. Only SHA-256 token hashes are stored. Client-sent `from`/`role`/`slot`/`id` are ignored.
- Authority comes from the room record: a connection may act only if the room still points at it, so a connection replaced by a resume (`replaced`), kicked, or closed out cannot send even if its binding survived a race.
- Room writes are conditional on a version number (optimistic locking with jittered retry). This covers the 8-seat cap, slot assignment, resume and close. Forwarding (`signal`, `relay`) only reads.
- Rooms expire 2 h after creation. The hub checks `expiresAt` on every access; DynamoDB TTL is just cleanup.
- A join with an invalid or foreign token is rejected (`invalid-token`) and never takes a seat. A phone that drops keeps its seat; in a full room a newcomer may take a seat whose phone has been offline for 2 min or more.
- Limits: 16 KB per message; names are NFKC-normalized, stripped of control/format characters and `<>`, max 16 chars; signal data is schema-checked and rebuilt.
- The Origin allowlist only stops other websites from using the service from a browser. It is not authentication, because non-browser clients can send any Origin.
- Logs contain only event names and error class names. They never contain tokens, room codes, names, IPs or payloads.

## Rate limits

| Limit | Where | Strength |
|---|---|---|
| 150 msg/s burst 300 per connection, then 40/s burst 80 for player signal/relay, 10 create/join/resume per connection then 1 per 6 s | in memory, per Lambda container | Best effort: a connection whose messages land on N warm containers gets up to N times this |
| Per IP (hashed): 60 connects/min, 20 creates/10 min, 120 join+resume/10 min | DynamoDB counters | Shared across containers; costs 1 write per counted event; easy to dodge by changing IP |
| Stage throttle 400 rps burst 200 (all clients combined), `$connect` 20 rps burst 40 | API Gateway | Best-effort throttling target, not a guaranteed request ceiling. One noisy client can exhaust capacity for others |
| Reserved concurrency 20 | Lambda | Hard ceiling on parallel invocations |
| DynamoDB on-demand max 1000 RRU/s, 200 WRU/s | DynamoDB | Throughput throttling setting, not a billing cap |

Load: 8 phones at 20 Hz plus host status (about 4 Hz to each phone) is about 200 msg/s per room when every phone falls back to the relay, so the default stage throttle covers about 2 fully relayed rooms at once. WebRTC data channels (primary) take this traffic off the service.

## Costs and caveats

None of these settings is a spending cap. A fully relayed room with eight phones at 20 Hz and four host status messages per phone per second produces roughly 192 incoming application messages per second, plus a similar number of outgoing deliveries. Over one hour that is about 691,200 Lambda invocations and about 1.38 million strongly consistent DynamoDB item reads, before retries, room changes and feedback. API Gateway charges for messages in both directions and for connection time. Lambda duration and DynamoDB item sizes also affect cost. Direct WebRTC carries gameplay off the room service and greatly reduces that traffic.

Check current regional AWS pricing before opening the service to a large audience. These traffic calculations are capacity estimates, not a measured bill or a price guarantee. Set an AWS Budget alert and monitor this deployment. Budget alerts notify; they do not stop spending. Origin restrictions and room tokens do not prevent deliberate public-endpoint abuse.

Other caveats: in-memory limits reset on cold start; API Gateway closes connections idle for 10 min (clients ping) and caps a connection at 2 h; message order across Lambda invocations is not guaranteed (inputs carry `seq`); frames up to API Gateway's 32 KB frame limit are still invoked and billed before the 16 KB check rejects them.

## Error codes

`bad-request`, `too-large`, `unknown-action`, `rate-limited`, `already-in-room`, `not-in-room`, `room-not-found`, `room-expired`, `room-closed`, `room-full`, `invalid-token`, `forbidden`, `unknown-peer`, `peer-offline`, `busy`, `internal`. Terminal for that socket: `replaced`, `kicked` (the server then closes it).

## Tests

`npm test` (vitest, `server/**/*.test.mjs`): hub rules (create/join/cap/concurrent joins/tokens/resume races/stale connections/expiry/leave/close/kick/forwarding/rate/errors/log and token leakage), the DynamoDB store against a fake that enforces its condition expressions, the Lambda adapter, the local ws server end to end (including `smoke.mjs`), and the template.
