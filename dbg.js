const fs=require('fs'), vm=require('vm'), {JSDOM}=require('jsdom');
const SRC = fs.readFileSync('ToonLens.user.js','utf8').replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/,'');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://example.com/',runScripts:'outside-only'});
const w=dom.window;
w.localStorage.setItem('toonlens:settings', JSON.stringify({v:2,provider:'gemini',apiKey:'AIzaAAA',keys:['AIzaBBB']}));
vm.createContext(w); w.__TL_TEST__={};
w.console.error=(...a)=>console.log('CONSOLE.ERROR:', ...a.map(String));
w.eval(SRC);
const T=w.__TL_TEST__;
T.boot().then(()=>{
  console.log('booted. ui.root=', !!T.ui.root, 'host in doc=', !!w.document.querySelector('#toonlens-host'));
  try { T.openSettings(); } catch(e){ console.log('THROWN:', e.stack.split('\n').slice(0,6).join('\n')); }
  console.log('ui.sheet set?', !!T.ui.sheet);
  const host=w.document.querySelector('#toonlens-host');
  if (host && host.shadowRoot) console.log('shadow sheets=', host.shadowRoot.querySelectorAll('.sheet').length, 'textareas=', host.shadowRoot.querySelectorAll('textarea').length);
});
