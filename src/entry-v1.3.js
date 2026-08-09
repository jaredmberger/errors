import base from './entry-v1.2.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      const response = await base.fetch(request, env, ctx);
      let markup = await response.text();

      markup = markup.replace('</style>', `${CHECK_NOW_CSS}</style>`);
      markup = markup.replace(
        '<div class="summary">',
        `${CHECK_NOW_UI}<div class="summary">`
      );
      markup = markup.replace('</body>', `${CHECK_NOW_SCRIPT}</body>`);

      return new Response(markup, {
        status: response.status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

const CHECK_NOW_CSS = `
.check-now-wrap{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:4px 0 24px}.check-now{appearance:none;border:1px solid rgba(191,164,106,.58);border-radius:12px;background:linear-gradient(180deg,rgba(191,164,106,.14),rgba(191,164,106,.055));color:#ead9aa;padding:12px 18px;font:700 .9rem/1 system-ui,-apple-system,sans-serif;letter-spacing:.02em;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.18);transition:transform .14s ease,border-color .14s ease,background .14s ease}.check-now:hover,.check-now:focus-visible{border-color:#bfa46a;background:rgba(191,164,106,.14);transform:translateY(-1px)}.check-now:disabled{cursor:wait;opacity:.65;transform:none}.check-now-state{color:#9fa9a4;font-size:.84rem;line-height:1.4}.check-now-state.good{color:#82d99e}.check-now-state.warn{color:#e1b767}.check-now-spinner{display:none;width:14px;height:14px;border:2px solid rgba(234,217,170,.3);border-top-color:#ead9aa;border-radius:50%;animation:check-spin .7s linear infinite}.check-now.is-running .check-now-spinner{display:inline-block}.check-now-inner{display:inline-flex;align-items:center;gap:8px}@keyframes check-spin{to{transform:rotate(360deg)}}@media(max-width:560px){.check-now-wrap{align-items:stretch;flex-direction:column}.check-now{width:100%;padding:14px 16px}.check-now-state{text-align:center}}
`;

const CHECK_NOW_UI = `
<div class="check-now-wrap">
  <button class="check-now" id="error-bus-check-now" type="button">
    <span class="check-now-inner"><span class="check-now-spinner" aria-hidden="true"></span><span id="error-bus-check-label">Check Now</span></span>
  </button>
  <span class="check-now-state" id="error-bus-check-state" role="status">Run a fresh bounded system check whenever you want.</span>
</div>
`;

const CHECK_NOW_SCRIPT = `
<script>
(function(){
  const button=document.getElementById('error-bus-check-now');
  const label=document.getElementById('error-bus-check-label');
  const state=document.getElementById('error-bus-check-state');
  if(!button||!label||!state)return;

  button.addEventListener('click',async function(){
    button.disabled=true;
    button.classList.add('is-running');
    label.textContent='Checking…';
    state.className='check-now-state';
    state.textContent='Checking current heartbeats, public-site infrastructure, and eligible recoveries…';

    try{
      const response=await fetch('/api/check-now',{method:'POST',cache:'no-store',headers:{'accept':'application/json'}});
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||('HTTP '+response.status));

      const status=data.status||{};
      const active=Number(status.activeIncidentCount||0);
      const publicOk=Boolean(data.publicSite&&data.publicSite.ok);
      state.className='check-now-state '+(active===0&&publicOk?'good':'warn');
      state.textContent=(active===0&&publicOk)
        ? 'Fresh check complete — no active incidents. Refreshing…'
        : 'Fresh check complete — '+active+' active incident'+(active===1?'':'s')+' remain. Refreshing…';
      label.textContent='Checked';
      window.setTimeout(function(){window.location.reload();},650);
    }catch(error){
      state.className='check-now-state warn';
      state.textContent='Check could not complete: '+(error&&error.message?error.message:String(error));
      label.textContent='Try Again';
      button.disabled=false;
      button.classList.remove('is-running');
    }
  });
})();
</script>
`;
