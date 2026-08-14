# Benchmarks

A tab suspender's heaviest users are the people with thousands of tabs open, so
a design that is fine at 50 tabs can still be unusable at 10,000. These
benchmarks run the real extension source against a browser of that size and
report what each path costs.

They are **not** tests. Nothing here fails a build; the output is a table for a
human to read before choosing between two designs, and again after implementing
one.

## Running them

```bash
npm run bench                 # every scenario, about five seconds
npm run bench -- -t checkTabs # one scenario, by test name
```

Or directly, which is the same thing:

```bash
npx jest --config bench/jest.bench.config.js --runInBand
```

`npm test` never picks these up: the main Jest config only matches
`test/**/*.test.js`, and these files end in `.bench.js`.

## Reading the output

Each line is one scenario:

```
unsuspendAllTabs                                 608.6 ms   tabsQuery:1 tabsUpdate:10000
pause every window (command 08)                   29.0 ms   tabsQuery:2 sessionSet:1 badgeText:19 ...
```

**Read the call counts, not the milliseconds.** The counters are the number of
`chrome.*` calls the scenario made, and in a real browser each one is an IPC
round trip to the browser process — often the dominant cost, and something this
harness cannot simulate. Some of them also do far more than their timing here
suggests: every `tabsUpdate` in `unsuspendAllTabs` starts a real page load.

The milliseconds are our own JavaScript plus the mock's bookkeeping. Treat them
as a floor for the real cost, and only compare them against each other.

The question to ask of a new line is not "is this fast" but **"does this number
grow with the tab count?"** A scenario at 10,000 tabs that reports 20 badge
writes is painting one per window and will look the same at 100,000 tabs. One
that reports 10,000 is paying per tab, and needs a different design.

## What is covered

| File | Scenarios |
| --- | --- |
| `badge.bench.js` | Pause badge: refresh, shortcuts, tab activation, worker start-up. Every count here should stay flat as the tab count grows. |
| `core.bench.js` | The every-minute `checkTabs` scan, worker start-up, bulk suspend and unsuspend, and the size of the session-storage payloads. |

`helpers.js` holds the fixtures: `makeTabs()` builds 10,000 tabs across 20
windows with one active tab per window, and `measureCalls()` times a scenario
and diffs the API counters around it.

## Known limits of the harness

- **No IPC.** `chrome.*` calls resolve immediately, so a scenario that makes
  30,000 of them looks fast here and is not in a real browser.
- **No rendering.** Page loads, discards and navigations do nothing, so the
  memory and network cost of, say, unsuspending 10,000 tabs is invisible.
- **Events must be driven by hand.** The mock never fires `tabs.onUpdated` on
  its own. This matters most for suspension: with `useNativeDiscard` on, every
  tab waits for its placeholder to report favicon readiness and would burn the
  full `DISCARD_READY_TIMEOUT_MS` (10s) here. `core.bench.js` therefore turns
  that setting off — which means its bulk-suspend figure excludes a real and
  significant cost. If you need that number, drive the readiness events or
  measure in a real profile.
- **Node's `URL`, not jsdom's.** The config uses the `node` environment on
  purpose: jsdom's URL implementation is an order of magnitude slower, which
  once made suspended-tab parsing look like a problem it is not.

## Adding a scenario

Add a `test()` to whichever file fits, build the browser with
`loadBackgroundWithTabs()`, and wrap the call in `measureCalls()`:

```js
test('my path', async () => {
  const { chrome, bg } = await loadBackgroundWithTabs({ tabs: makeTabs() });

  await measureCalls('what I am measuring', chrome, () => bg.myFunction());
});
```

`background.js` exports its internals for tests through a guarded
`module.exports` block at the bottom of the file, so anything the test suite can
reach is available here as well. If a counter you need is missing, add it to
`apiCalls()` in `helpers.js`.

Keep the scenario honest: give it a browser it would plausibly meet, and make
sure the state the code checks is actually set. A tab that Chrome would have
marked active has to be marked active in the fixture too, or the code under
measurement will take a branch no real user ever takes.
