# hp-scan

A scanning UI for network scanners — built for the HP OfficeJet Pro 7740, but it
works with any AirScan/eSCL device. No HP account, no driver install, no HP
software.

## What we learned from HP Easy Start

The starting point was to reverse-engineer `HP Easy Start.app`. The useful
finding is that **there is nothing to reverse-engineer**: the app contains zero
scanning code. It does three things — Bonjour discovery, HP-proprietary LEDM
setup (`/DevMgmt/DiscoveryTree.xml`, used for Wi-Fi association and renaming),
and driver downloads. For scanning it hands off entirely to Apple's
ImageCaptureCore:

```
_airScanScanner          T@"ICScannerDevice"
isESCLSupported          initWithNetService:ESCLSupported:
[OSPDeviceQueueCreator] - No HP ICDevice found, Proceed with AirScan
```

"AirScan" is HP's name for **eSCL**, the open Mopria/Apple scan protocol. The
app's own logic is: if the device speaks eSCL, use eSCL and ignore HP's stack.
So this project talks eSCL directly — plain HTTP and XML, fully documented, no
vendor code involved.

## Why there is a local helper

A hosted web page cannot talk to a printer, for three independent reasons:

1. **No mDNS API** — the browser cannot discover the device.
2. **Mixed content** — an HTTPS page cannot fetch `http://192.168.x.x`.
3. **No CORS** — printers send no `Access-Control-Allow-Origin`, so response
   bytes are unreadable. (You can display a page via `<img>`, but that taints
   the canvas, so it could never become a PDF.)

So the app is split in two:

- **`helper/`** — a small binary, installed once. Does mDNS discovery and acts
  as a transparent CORS proxy. Deliberately has almost no logic, so it should
  essentially never need updating.
- **`web/`** — the whole UI and all scan logic, hosted over HTTPS. Ships updates
  on a page reload.

This works because `http://127.0.0.1` is a *potentially trustworthy origin* per
the mixed-content spec, so an HTTPS page is allowed to call it. Chrome
additionally requires a Private Network Access preflight, which the helper
answers with `Access-Control-Allow-Private-Network: true` — miss that header and
the whole thing silently fails in Chrome.

The helper binds to loopback only and refuses any origin not on its allowlist,
so a random website cannot use it to reach the LAN.

## The eSCL protocol

```
mDNS _uscan._tcp   TXT: rs=eSCL, ty=<model>, is=platen,adf, duplex=T
GET    /eSCL/ScannerCapabilities        sources, resolutions, page size, formats
GET    /eSCL/ScannerStatus              Idle/Processing + ScannerAdfLoaded|Empty
POST   /eSCL/ScanJobs                   201 + Location: .../ScanJobs/<id>
GET    /eSCL/ScanJobs/<id>/NextDocument one page; repeat until 404
DELETE /eSCL/ScanJobs/<id>              cancel
```

That `NextDocument` loop is what makes batch scanning work: the feeder keeps
handing back pages until it runs dry, and a 404 means the job is done. Flatbed
jobs return a single page, so multi-page flatbed scanning is repeated jobs
appended into the same document.

All geometry is in units of 1/300 inch, independent of scan resolution.

## Layout

```
helper/   local bridge: mDNS discovery + CORS proxy (Bun, compiles to one file)
sim/      a simulated OfficeJet Pro 7740 — full eSCL, mDNS, modelled paper tray
web/      the UI (React + Vite + Tailwind), PDF assembled client-side
```

## Running it

Three terminals:

```sh
# 1. the simulated printer (skip if you have the real one on the network)
cd sim && bun install && bun run start

# 2. the local helper
cd helper && bun install && bun run start

# 3. the UI
cd web && bun install && bun run dev
```

Then open http://localhost:5173.

Driving the simulator's paper tray:

```sh
curl "localhost:8090/sim/load?sheets=10"   # put 10 sheets in the feeder
curl localhost:8090/sim/state              # inspect tray + job state
```

Useful simulator env vars: `SIM_PORT`, `SIM_SHEETS`, `SIM_PAGE_DELAY_MS`
(per-page delay, default 1200ms to mimic the real device), `SIM_MAX_EDGE`,
`SIM_MDNS=0`.

## Building the helper

```sh
cd helper && bun run build
```

Produces `dist/hp-scan-helper-{mac-arm64,mac-x64,win-x64.exe}`. Set
`ALLOWED_ORIGINS=https://your-app-domain` when running it against a hosted UI.

Note these are large (58MB mac, 109MB Windows) because Bun embeds its runtime.
Fine for a once-ever install, but if download size matters, the helper is small
and self-contained enough to port to Go for a ~5MB binary.

## Status

Verified end to end against the simulator: discovery, capability parsing, ADF
duplex batch scanning, live page arrival, reordering, rotation, and PDF export
with correct per-page geometry.

Not yet verified against real hardware. When the printer is available:

- Dump its real `GET /eSCL/ScannerCapabilities` and drop it into
  `sim/src/capabilities.ts`, so the fixture is byte-accurate.
- Confirm the feeder's end-of-job behaviour. Some HP firmware returns `503`
  with `Retry-After` between sheets rather than blocking on the request;
  `web/src/lib/scanJob.ts` already handles both, but which one the 7740 does is
  unconfirmed.
- Check whether it reports `ScannerAdfLoaded` reliably — the UI's
  "put documents in the feeder" hint depends on it.
