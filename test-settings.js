const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const SRC = fs.readFileSync('ToonLens.user.js', 'utf8').replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

function makeWin(settings) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only' });
  const w = dom.window;
  if (settings) w.localStorage.setItem('toonlens:settings', JSON.stringify(settings));
  // indexedDB missing in jsdom: script wraps it in try/catch and falls back to the mem cache.
  vm.createContext(w);
  // the script only exports its test hook if __TL_TEST__ exists before it runs
  w.__TL_TEST__ = {};
  w.eval(SRC + '\n;globalThis.__TL_TEST_HOOK_DONE__ = true;');
  return w;
}

(async () => {
  let fails = 0;
  const check = (name, cond, extra) => {
    if (cond) console.log('PASS:', name);
    else { console.log('FAIL:', name, extra || ''); fails++; }
  };

  // Scenario 1: normal boot -> open settings -> backup keys shown -> close
  {
    const w = makeWin({ v: 2, provider: 'gemini', apiKey: 'AIzaAAA', keys: ['AIzaBBB'] });
    const T = w.__TL_TEST__;
    check('test hook exported', !!T && typeof T.boot === 'function' && typeof T.openSettings === 'function');
    await T.boot();
    T.openSettings();
    const sheet = w.document.querySelector('#toonlens-host .sheet');
    check('boot + openSettings renders sheet', !!sheet);
    const areas = [...w.document.querySelectorAll('#toonlens-host textarea')];
    const keysTa = areas.find(a => (a.placeholder || '').includes('sk-or'));
    check('backup-keys textarea exists', !!keysTa);
    check('backup key value populated', !!keysTa && keysTa.value.includes('AIzaBBB'), keysTa && JSON.stringify(keysTa.value));
    T.closeSettings();
    check('closeSettings removes sheet', !w.document.querySelector('#toonlens-host .sheet'));
    // Scenario 3: double open must not stack sheets
    T.openSettings(); T.openSettings();
    const n = w.document.querySelectorAll('#toonlens-host .sheet').length;
    check('double open keeps exactly one sheet', n === 1, 'got ' + n);
    T.closeSettings();
  }

  // Scenario 2: open settings BEFORE boot finished (ui.root missing)
  {
    const w = makeWin(null);
    const T = w.__TL_TEST__;
    T.openSettings();
    const sheet = w.document.querySelector('.sheet');
    check('pre-boot openSettings self-mounts and renders', !!sheet);
    check('sheet has title', !!sheet && sheet.textContent.includes('ToonLens settings'));
  }

  // Scenario 4: clicking the gear button in the pill actually calls openSettings
  {
    const w = makeWin({ v: 2, provider: 'openrouter', apiKey: '', keys: [] });
    const T = w.__TL_TEST__;
    await T.boot();
    T.S.pill = 'always';
    if (typeof T.syncPill === 'function') T.syncPill();
    const g = w.document.querySelector('#toonlens-host .pillg');
    check('gear button exists', !!g);
    if (g) { g.click(); check('gear click opens sheet', !!w.document.querySelector('#toonlens-host .sheet')); }
  }

  // Scenario 5: home page Settings button (#toonlens hash)
  {
    const w = makeWin(null);
    w.location.hash = '#toonlens';
    const T = w.__TL_TEST__;
    await T.boot();
    const btns = [...w.document.querySelectorAll('#toonlens-host button')];
    const sBtn = btns.find(b => b.textContent.trim() === 'Settings');
    check('home Settings button exists', !!sBtn);
    if (sBtn) { sBtn.click(); check('home Settings click opens sheet', !!w.document.querySelector('#toonlens-host .sheet')); }
  }

  // Scenario 6: HUD settings icon inside reader context (iconBtn sliders) — verify handler wiring via ui.hud presence is enough; skip full reader build.

  console.log(fails ? 'RESULT: ' + fails + ' FAILURES' : 'RESULT: ALL PASS');
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.log('HARNESS ERROR:', e.stack); process.exitCode = 1; });
