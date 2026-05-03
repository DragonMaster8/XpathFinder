/* ============================================================================
 * XPath Studio — UI Controller
 * ----------------------------------------------------------------------------
 * Wires the DOM:
 *   - Renders pasted HTML into a sandboxed iframe (no script execution).
 *   - Injects highlight styles + hover/click listeners into the iframe document.
 *   - Blocks navigation and form submission triggered from inside the preview.
 *   - Calls XPathEngine.generate() for the picked element and renders cards.
 *   - Copy-to-clipboard, Selenium snippet export, theme toggle, filters, etc.
 * ========================================================================== */

(function () {
  'use strict';

  /* --------------------------------------------------------------------------
   * DOM references
   * -------------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const els = {
    // Source input
    htmlInput:           $('html-input'),
    urlInput:            $('url-input'),
    paneHtml:            $('pane-html'),
    paneUrl:             $('pane-url'),
    tabHtml:             $('tab-html'),
    tabUrl:              $('tab-url'),
    toggleStripScripts:  $('toggle-strip-scripts'),
    toggleInjectBase:    $('toggle-inject-base'),
    customProxy:         $('custom-proxy'),
    bookmarklet:         $('bookmarklet-link'),
    btnPasteClipboard:   $('btn-paste-clipboard'),
    btnOpenCapture:        $('btn-open-capture'),
    captureWaiting:        $('capture-waiting'),
    captureWaitingUrl:     $('capture-waiting-url'),
    btnCancelCapture:      $('btn-cancel-capture'),
    btnPasteDuringCapture: $('btn-paste-during-capture'),
    captureTroubleshoot:   $('capture-troubleshoot'),
    btnScrollTop:        $('btn-scroll-top'),
    attemptLog:          $('attempt-log'),
    htmlValidation:      $('html-validation'),

    // Top-bar
    btnRender:           $('btn-render'),
    btnRenderLabel:      $('btn-render-label'),
    btnRenderSpinner:    $('btn-render-spinner'),
    btnClear:            $('btn-clear'),
    btnSample:           $('btn-sample'),
    btnTheme:            $('btn-theme'),
    statusPill:          $('status-pill'),

    // Preview
    previewFrame:        $('preview-frame'),
    previewEmpty:        $('preview-empty'),
    previewPanel:        document.querySelector('.panel-preview'),
    togglePick:          $('toggle-pick'),
    btnClearSel:         $('btn-clear-selection'),
    btnExpandPreview:    $('btn-expand-preview'),
    btnFullscreen:       $('btn-fullscreen'),
    expandLabel:         $('expand-label'),

    // Results
    selectedInfo:        $('selected-info'),
    locatorList:         $('locator-list'),
    toggleIndex:         $('toggle-index'),
    toggleCss:           $('toggle-css'),
    toggleSnippet:       $('toggle-snippet'),
    filters:             document.querySelectorAll('.chip[data-filter]'),
    toast:               $('toast')
  };

  /* --------------------------------------------------------------------------
   * App state
   * -------------------------------------------------------------------------- */
  const state = {
    inputMode:       'html', // 'html' | 'url' | 'live'
    selectedElement: null,   // Element inside the iframe document
    activeFilter:    'all',  // 'all' | 'attribute' | 'text' | 'relative'
    snippetLang:     'java', // shared across cards
    locators:        [],     // Last computed Locator[]
    isFetching:      false,  // URL fetch in progress
    liveMode:        false,  // true when live iframe is active (not frozen)
    liveUrl:         ''      // URL currently loaded in the live iframe
  };

  /* --------------------------------------------------------------------------
   * URL fetching via public CORS proxies (browser security forces this when
   * the origin is file:// or any non-target host). Tried in order until one
   * returns a non-empty body. All are free public services and may be
   * rate-limited or temporarily unavailable. The user can also provide their
   * own proxy in the "Advanced" section, or skip proxies entirely with
   * "Open & Capture" / the bookmarklet.
   *
   * Each entry has its own encoding rule because proxies disagree on whether
   * the target URL should be URL-encoded or appended raw. Getting this wrong
   * is the #1 cause of HTTP 400 from these services.
   * -------------------------------------------------------------------------- */
  const PROXIES = [
    { name: 'allorigins',     build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
    { name: 'allorigins/get', build: (u) => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u),
      isJsonWrapper: true },
    { name: 'codetabs',       build: (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + u },
    { name: 'corsproxy.io',   build: (u) => 'https://corsproxy.io/?' + encodeURIComponent(u) },
    { name: 'cors.lol',       build: (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
    { name: 'every-origin',   build: (u) => 'https://every-origin.vercel.app/get?url=' + encodeURIComponent(u),
      isJsonWrapper: true },
    { name: 'corsproxy.org',  build: (u) => 'https://corsproxy.org/?' + encodeURIComponent(u) },
    { name: 'thingproxy',     build: (u) => 'https://thingproxy.freeboard.io/fetch/' + u }
  ];

  /**
   * Build a custom-proxy attempt, if the user provided one.
   * Two placeholder formats are supported:
   *   - {url}         → encoded URL is substituted
   *   - bare ending / → URL is appended verbatim (cors-anywhere style)
   */
  function buildCustomProxy(template, url) {
    if (!template) return null;
    const t = template.trim();
    if (!t) return null;
    let endpoint;
    if (t.includes('{url}')) {
      endpoint = t.replace('{url}', encodeURIComponent(url));
    } else if (t.endsWith('=') || t.endsWith('?') || t.endsWith('/')) {
      endpoint = t + encodeURIComponent(url);
    } else {
      endpoint = t + url;
    }
    return { name: 'custom', endpoint, isJsonWrapper: false };
  }

  /* --------------------------------------------------------------------------
   * HTML validation. We delegate to the browser's actual HTML parser via
   * DOMParser — that's what every real browser uses and it's forgiving by
   * design. Counting "<" vs ">" gives massive false positives on real pages
   * (JS comparisons, embedded CSS child combinators, JSX in string literals,
   * comments containing tag-like text, etc.) so we don't do it.
   * -------------------------------------------------------------------------- */
  function validateHTML(src) {
    if (!src || !src.trim()) {
      return { ok: false, message: 'Empty input — paste HTML to render.' };
    }

    let doc;
    try {
      doc = new DOMParser().parseFromString(src, 'text/html');
    } catch (err) {
      return { ok: false, message: 'HTML parser error: ' + (err.message || 'unknown') };
    }

    if (doc.querySelector('parsererror')) {
      return { ok: false, message: 'HTML parser error — please check the syntax.' };
    }

    // body.querySelectorAll('*').length is 0 only when the input is plain text
    // with no tags at all; in that case warn the user kindly.
    const bodyEls = doc.body ? doc.body.querySelectorAll('*').length : 0;
    if (bodyEls === 0 && !/<[a-z!][^>]*>/i.test(src)) {
      return { ok: false, message: 'No HTML tags detected — did you paste plain text?' };
    }

    const total = doc.querySelectorAll('*').length;
    return {
      ok: true,
      message: `Parsed OK — ${total.toLocaleString()} element(s) detected.`
    };
  }

  /* --------------------------------------------------------------------------
   * Tab switching: HTML paste vs URL fetch
   * -------------------------------------------------------------------------- */
  function setInputMode(mode) {
    state.inputMode = mode;

    const tabLive = $('tab-live');
    const paneLive = $('pane-live');

    els.tabHtml.classList.toggle('tab-active', mode === 'html');
    els.tabUrl.classList.toggle('tab-active',  mode === 'url');
    if (tabLive) tabLive.classList.toggle('tab-active', mode === 'live');

    els.tabHtml.setAttribute('aria-selected', String(mode === 'html'));
    els.tabUrl.setAttribute('aria-selected',  String(mode === 'url'));
    if (tabLive) tabLive.setAttribute('aria-selected', String(mode === 'live'));

    els.paneHtml.classList.toggle('hidden', mode !== 'html');
    els.paneUrl.classList.toggle('hidden',  mode !== 'url');
    if (paneLive) paneLive.classList.toggle('hidden', mode !== 'live');

    if (mode === 'html') {
      els.btnRenderLabel.textContent = 'Render';
      showValidation({ ok: true, message: '' });
    } else if (mode === 'url') {
      els.btnRenderLabel.textContent = 'Fetch & Render';
      showValidation({ ok: true, message: 'Enter a URL and press Fetch & Render.' });
    } else if (mode === 'live') {
      els.btnRenderLabel.textContent = 'Render';
      showValidation({ ok: true, message: 'Enter a URL in the Live Browse panel and click Go.' });
    }

    // When switching to URL mode, scroll to top
    if (mode === 'url') {
      const form = els.paneUrl && els.paneUrl.querySelector('.url-form');
      if (form) form.scrollTo({ top: 0, behavior: 'auto' });
    }

    // If switching away from live mode, exit live browsing
    if (mode !== 'live' && state.liveMode) {
      exitLiveMode();
    }
  }

  /* --------------------------------------------------------------------------
   * URL validation + fetching
   * -------------------------------------------------------------------------- */
  function validateUrl(raw) {
    if (!raw || !raw.trim()) {
      return { ok: false, message: 'Enter a URL to fetch.' };
    }
    let u;
    try { u = new URL(raw.trim()); } catch (e) {
      return { ok: false, message: 'Invalid URL — must include the scheme (https:// or http://).' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, message: 'Only http:// and https:// URLs are supported.' };
    }
    return { ok: true, url: u.toString(), message: '' };
  }

  /**
   * Try ALL proxies in PARALLEL. First one to return usable HTML wins.
   * This avoids the 60+ second serial chain when 5 proxies are dead.
   */
  async function fetchHtmlFromUrl(targetUrl) {
    setBusy(true);
    setStatus('working', 'Fetching…');
    clearAttemptLog();

    const TIMEOUT = 8000; // 8 s per proxy — tight but fair for a proxy fetch

    const lastGood = readLastWorkingProxy();
    const customTpl = els.customProxy ? els.customProxy.value : '';
    const attempts = [];

    const custom = buildCustomProxy(customTpl, targetUrl);
    if (custom) attempts.push(custom);

    for (const p of PROXIES) {
      attempts.push({
        name: p.name,
        endpoint: p.build(targetUrl),
        isJsonWrapper: !!p.isJsonWrapper,
        _baseName: p.name
      });
    }

    // Sort: put last-good proxy first for display ordering
    if (lastGood) {
      const idx = attempts.findIndex(a => a._baseName === lastGood || a.name === lastGood);
      if (idx > 0) {
        const [hit] = attempts.splice(idx, 1);
        hit.name = hit.name + ' (last good)';
        attempts.unshift(hit);
      }
    }

    showValidation({ ok: true, message: `Racing ${attempts.length} proxies in parallel…` });

    // Create a UI row + promise for every proxy, fire them ALL at once
    const racePromises = attempts.map((attempt) => {
      const row = pushAttemptRow(attempt.name, 'trying');
      const t0 = performance.now();

      return fetchWithTimeout(attempt.endpoint, TIMEOUT)
        .then(async (res) => {
          const elapsed = Math.round(performance.now() - t0);
          if (!res.ok) {
            updateAttemptRow(row, 'fail', `HTTP ${res.status}`, elapsed);
            throw new Error(`${attempt.name}: HTTP ${res.status}`);
          }
          let body = await res.text();

          if (attempt.isJsonWrapper) {
            try {
              const j = JSON.parse(body);
              body = j.contents || j.body || j.data || '';
            } catch (e) { /* keep as-is */ }
          }

          if (!body || body.length < 20) {
            updateAttemptRow(row, 'fail', 'empty response', elapsed);
            throw new Error(`${attempt.name}: empty response`);
          }

          const head = body.slice(0, 4000).toLowerCase();
          if (
            head.includes('cf-browser-verification') ||
            head.includes('attention required! | cloudflare') ||
            head.includes('captcha-bypass') ||
            head.includes('checking your browser before accessing')
          ) {
            updateAttemptRow(row, 'fail', 'Cloudflare/CAPTCHA', elapsed);
            throw new Error(`${attempt.name}: Cloudflare/CAPTCHA`);
          }

          updateAttemptRow(row, 'ok', `${body.length.toLocaleString()} chars`, elapsed);
          return { html: body, via: attempt.name, baseName: attempt._baseName, bytes: body.length };
        })
        .catch((err) => {
          const elapsed = Math.round(performance.now() - t0);
          const msg = err.name === 'AbortError'
            ? `timeout (${TIMEOUT / 1000}s)`
            : (err.message || 'network error');
          // Row may already be updated above; safe to re-update
          updateAttemptRow(row, 'fail', msg, elapsed);
          throw err;
        });
    });

    try {
      // Promise.any resolves with the FIRST fulfilled promise
      const result = await Promise.any(racePromises);
      setBusy(false);
      if (result.baseName) writeLastWorkingProxy(result.baseName);
      maybeWarnSpaShell(result.html);
      return result;
    } catch (agg) {
      // AggregateError: every single proxy failed
      setBusy(false);
      setStatus('error', 'Fetch failed');

      const reasons = (agg.errors || []).map(e => e.message || String(e));
      const wrapped = new Error(
        'All ' + attempts.length + ' proxies failed (tried in parallel). ' +
        'Public CORS proxies are unreliable — they rate-limit, 403, or get blocked.\n\n' +
        'Best alternatives:\n' +
        '  1. Open & Capture — uses your browser session, works on any site.\n' +
        '  2. Custom proxy — run your own cors-anywhere on Cloudflare Workers.\n' +
        '  3. Bookmarklet — click it on any page, then Paste from clipboard.\n\n' +
        'Proxy results:\n' +
        reasons.map(e => '  • ' + e).join('\n')
      );
      wrapped.attempts = reasons;
      throw wrapped;
    }
  }

  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
  }

  /* --------------------------------------------------------------------------
   * Sticky last-working-proxy cache. Saves a couple of seconds on subsequent
   * fetches by trying the proxy that worked most recently first.
   * -------------------------------------------------------------------------- */
  function readLastWorkingProxy() {
    try { return localStorage.getItem('xps-last-proxy') || null; } catch (e) { return null; }
  }
  function writeLastWorkingProxy(name) {
    try { localStorage.setItem('xps-last-proxy', name); } catch (e) {}
  }

  /* --------------------------------------------------------------------------
   * Live attempt log: gives the user a real-time view of the fallback chain.
   * Without this, a row of failures looks like a frozen UI.
   * -------------------------------------------------------------------------- */
  function clearAttemptLog() {
    if (els.attemptLog) {
      els.attemptLog.innerHTML = '';
      els.attemptLog.classList.remove('hidden');
    }
  }
  function pushAttemptRow(name, status) {
    if (!els.attemptLog) return null;
    const row = document.createElement('div');
    row.className = 'attempt-row attempt-' + status;
    row.innerHTML =
      '<span class="attempt-dot"></span>' +
      '<span class="attempt-name"></span>' +
      '<span class="attempt-msg"></span>' +
      '<span class="attempt-time"></span>';
    row.querySelector('.attempt-name').textContent = name;
    row.querySelector('.attempt-msg').textContent = '…';
    els.attemptLog.appendChild(row);
    return row;
  }
  function updateAttemptRow(row, status, msg, elapsed) {
    if (!row) return;
    row.classList.remove('attempt-trying', 'attempt-ok', 'attempt-fail');
    row.classList.add('attempt-' + status);
    row.querySelector('.attempt-msg').textContent = msg;
    row.querySelector('.attempt-time').textContent = elapsed != null ? elapsed + ' ms' : '';
  }

  /* --------------------------------------------------------------------------
   * SPA-shell warning. If the fetched HTML is essentially an empty React/Vue/
   * Angular shell, the user will see a blank preview and be confused. Warn
   * and point them at Open & Capture, which renders the hydrated DOM.
   * -------------------------------------------------------------------------- */
  function maybeWarnSpaShell(html) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const body = doc.body;
      if (!body) return;
      const elementCount = body.querySelectorAll('*').length;
      const visibleText = (body.textContent || '').replace(/\s+/g, ' ').trim();
      const looksLikeSpaShell =
        elementCount < 30 &&
        visibleText.length < 200 &&
        (
          body.querySelector('#root') ||
          body.querySelector('#app') ||
          body.querySelector('[ng-app], [ng-controller], [data-reactroot]') ||
          /window\.__INITIAL_STATE__|__NEXT_DATA__|__NUXT__/i.test(html)
        );

      if (looksLikeSpaShell) {
        toast('This looks like an unrendered SPA shell — try "Open & Capture" instead', 4500);
      }
    } catch (e) { /* ignore */ }
  }

  function setBusy(busy) {
    state.isFetching = busy;
    els.btnRender.disabled = busy;
    els.btnRender.classList.toggle('is-busy', busy);
  }

  /* --------------------------------------------------------------------------
   * HTML post-processing for fetched pages
   *   - inject <base href> so relative URLs to CSS/images resolve
   *   - optionally strip <script> and inline event handlers (defense in depth;
   *     the iframe sandbox already blocks JS execution)
   * -------------------------------------------------------------------------- */
  function injectBaseHref(html, sourceUrl) {
    const baseTag = `<base href="${escapeAttr(sourceUrl)}">`;
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    }
    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
    }
    return baseTag + html;
  }

  /* --------------------------------------------------------------------------
   * Bookmarklet — the only reliable way to read authenticated, cookie-bound,
   * SPA-rendered pages without an extension. It runs INSIDE the target page's
   * tab, so it has full access to that tab's cookies, hydrated DOM, etc.
   *
   * Two delivery modes (tried in order):
   *   1. postMessage to window.opener — auto-renders in XPath Studio. Used
   *      when the target tab was opened via "Open & Capture".
   *   2. Clipboard — used when the bookmarklet was clicked on a tab the user
   *      navigated to manually.
   * -------------------------------------------------------------------------- */
  function buildBookmarkletHref() {
    // Embed XPath Studio's URL so the bookmarklet always knows where to send HTML
    const studioUrl = location.href.split('?')[0].split('#')[0];
    const code = `(function(){
      try {
        var html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
        var studioUrl = '${studioUrl}';
        var sentVia = null;
        /* 1. Try postMessage to opener (works when Open & Capture opened this tab) */
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage({
              type: 'xps-html',
              url: location.href,
              title: document.title,
              html: html
            }, '*');
            sentVia = 'XPath Studio (auto)';
            setTimeout(function(){ try { window.close(); } catch(e){} }, 1100);
          }
        } catch(e) {}
        /* 2. No opener — open XPath Studio and send via postMessage */
        if (!sentVia) {
          try {
            var w = window.open(studioUrl, 'XPathStudio');
            if (w) {
              var payload = {
                type: 'xps-html',
                url: location.href,
                title: document.title,
                html: html
              };
              /* The target page may need time to load; retry postMessage a few times */
              var attempts = 0;
              var iv = setInterval(function(){
                try { w.postMessage(payload, '*'); } catch(e){}
                attempts++;
                if (attempts >= 8) clearInterval(iv);
              }, 600);
              sentVia = 'XPath Studio tab';
            }
          } catch(e) {}
        }
        /* 3. Last resort — copy to clipboard */
        if (!sentVia) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(html);
              sentVia = 'clipboard';
            }
          } catch(e) {}
        }
        if (!sentVia) {
          var ta = document.createElement('textarea');
          ta.value = html;
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          try { if(document.execCommand('copy')) sentVia = 'clipboard'; } catch(e){}
          document.body.removeChild(ta);
        }
        var d = document.createElement('div');
        d.textContent = sentVia
          ? ('XPath Studio: ' + html.length.toLocaleString() + ' chars \\u2192 ' + sentVia)
          : 'XPath Studio: capture failed — open XPath Studio and use Paste from clipboard';
        d.style.cssText = 'all:unset;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:'
          + (sentVia ? '#119a64' : '#d23a36')
          + ';color:#fff;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
          + 'padding:10px 18px;border-radius:999px;z-index:2147483647;box-shadow:0 8px 24px rgba(0,0,0,.4)';
        document.body.appendChild(d);
        setTimeout(function(){ d.remove(); }, 3000);
      } catch(e) { alert('XPath Studio bookmarklet error: ' + e.message); }
    })();`;
    return 'javascript:' + encodeURIComponent(code.replace(/\s+/g, ' '));
  }

  /* --------------------------------------------------------------------------
   * "Open & Capture" — opens the URL in a new tab using the user's existing
   * browser session (cookies, login, Cloudflare clearance, everything). The
   * bookmarklet running on that tab posts the rendered HTML back to us via
   * postMessage. We auto-render on receipt.
   *
   * Why this is necessary: same-origin policy means JavaScript here cannot
   * read cookies for example.com, cannot fetch authenticated content from
   * example.com, and cannot read the DOM of an iframe loading example.com.
   * The ONLY way to use the user's existing browser session is to run code
   * inside a tab that's already loaded that origin — which is exactly what
   * window.open + bookmarklet does.
   * -------------------------------------------------------------------------- */
  let captureTab = null;
  let captureWatchdog = null;

  function openAndCapture() {
    const v = validateUrl(els.urlInput.value);
    if (!v.ok) {
      showValidation({ ok: false, message: v.message });
      setStatus('error', 'Invalid URL');
      return;
    }
    // Close any prior captured tab to keep things tidy.
    cancelCapture();

    captureTab = window.open(v.url, '_blank');
    if (!captureTab) {
      showValidation({
        ok: false,
        message: 'Pop-up blocked — allow pop-ups for this page and try again.'
      });
      return;
    }

    setStatus('working', 'Waiting for capture…');
    showCaptureWaiting(v.url);

    // 5-minute watchdog. If the tab is closed without sending, clean up.
    captureWatchdog = setInterval(() => {
      if (!captureTab || captureTab.closed) {
        finishCapture(false);
      }
    }, 1500);
  }

  function cancelCapture() {
    if (captureWatchdog) {
      clearInterval(captureWatchdog);
      captureWatchdog = null;
    }
    captureTab = null;
    hideCaptureWaiting();
  }

  function finishCapture(success) {
    if (captureWatchdog) {
      clearInterval(captureWatchdog);
      captureWatchdog = null;
    }
    captureTab = null;
    hideCaptureWaiting();
    if (!success) {
      setStatus('idle', 'Idle');
      showValidation({ ok: true, message: 'Capture cancelled.' });
    }
  }

  let captureTroubleshootTimer = null;

  function showCaptureWaiting(url) {
    if (!els.captureWaiting) return;
    els.captureWaitingUrl.textContent = url;
    els.captureWaiting.classList.remove('hidden');
    if (els.captureTroubleshoot) els.captureTroubleshoot.removeAttribute('open');

    // Make sure the user actually sees the waiting card — it's near the top
    // of the URL pane but the pane may be scrolled down to Flow C.
    requestAnimationFrame(() => {
      els.captureWaiting.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    // Auto-expand troubleshooting after 25 s if capture hasn't completed.
    clearTimeout(captureTroubleshootTimer);
    captureTroubleshootTimer = setTimeout(() => {
      if (els.captureTroubleshoot) els.captureTroubleshoot.setAttribute('open', '');
    }, 25000);
  }

  function hideCaptureWaiting() {
    if (!els.captureWaiting) return;
    els.captureWaiting.classList.add('hidden');
    clearTimeout(captureTroubleshootTimer);
    captureTroubleshootTimer = null;
  }

  /**
   * Listen for HTML payloads sent by the bookmarklet via postMessage.
   * Validates shape strictly so we don't render attacker-controlled junk.
   */
  function attachPostMessageListener() {
    window.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'xps-html') return;
      if (typeof data.html !== 'string' || data.html.length < 20) return;

      // Clean up any active Live Browse or Open & Capture session
      finishCapture(true);
      if (state.liveMode || state.inputMode === 'live') {
        finishLiveBrowse();
      }

      // Auto-render in HTML mode so the user can inspect/edit
      setInputMode('html');
      els.htmlInput.value = data.html;
      renderHTML(data.html);
      toast('Captured ' + (data.url || 'page') + ' — ' + data.html.length.toLocaleString() + ' chars');
    });
  }

  /* --------------------------------------------------------------------------
   * Helper: paste from clipboard directly into the HTML textarea + render.
   * Useful right after running the bookmarklet on another tab.
   * -------------------------------------------------------------------------- */
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || text.length < 20) {
        toast('Clipboard is empty');
        return;
      }
      setInputMode('html');
      els.htmlInput.value = text;
      renderHTML(text);
      toast('Pasted from clipboard');
    } catch (err) {
      toast('Clipboard access denied — paste manually with Ctrl+V');
    }
  }

  function stripScripts(html) {
    return html
      // <script>…</script>
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // <script ... /> (rare but valid in XHTML)
      .replace(/<script\b[^>]*\/>/gi, '')
      // inline event handlers: onclick="…", onload='…', etc.
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  }

  /* --------------------------------------------------------------------------
   * Render HTML into the sandboxed iframe.
   * sandbox="allow-same-origin" (no allow-scripts) means:
   *   - The user's <script> tags do NOT execute.
   *   - But the parent (us) can still read iframe.contentDocument.
   * -------------------------------------------------------------------------- */
  function renderHTML(src) {
    const v = validateHTML(src);
    showValidation(v);
    if (!v.ok) {
      setStatus('error', 'Invalid');
      return;
    }
    setStatus('working', 'Rendering…');

    // Re-rendering invalidates any element references from the previous DOM.
    clearSelection();

    // Ensure sandboxed iframe is visible (may be hidden if coming from live mode)
    els.previewFrame.classList.remove('hidden');
    const liveFrame = $('live-frame');
    if (liveFrame) liveFrame.classList.add('hidden');

    // Use srcdoc so the iframe is same-origin (about:srcdoc).
    els.previewFrame.srcdoc = src;
    els.previewEmpty.classList.add('hidden');

    // The load event fires once the document inside is parsed.
    els.previewFrame.addEventListener('load', onIframeLoaded, { once: true });
  }

  /**
   * Top-level handler for the Render button. Branches on the active input mode.
   */
  async function handleRender() {
    if (state.inputMode === 'html') {
      renderHTML(els.htmlInput.value);
      return;
    }

    // Live mode: Render = start live browsing or fetch via proxy
    if (state.inputMode === 'live') {
      const liveUrlInput = $('live-url-input');
      if (liveUrlInput && liveUrlInput.value) {
        if (state.liveMode) freezeLivePage();
        else startLiveBrowse(liveUrlInput.value);
      }
      return;
    }

    // URL mode
    const v = validateUrl(els.urlInput.value);
    if (!v.ok) {
      showValidation({ ok: false, message: v.message });
      setStatus('error', 'Invalid URL');
      return;
    }
    try {
      const { html, via } = await fetchHtmlFromUrl(v.url);
      let processed = html;
      if (els.toggleStripScripts.checked) processed = stripScripts(processed);
      if (els.toggleInjectBase.checked)   processed = injectBaseHref(processed, v.url);
      // Show the fetched HTML in the textarea too, so it can be inspected/edited.
      els.htmlInput.value = processed;
      showValidation({ ok: true, message: `Fetched via ${via} — ${processed.length.toLocaleString()} chars.` });
      renderHTML(processed);
    } catch (err) {
      showValidation({ ok: false, message: err.message });
      setStatus('error', 'Fetch failed');
    }
  }

  function onIframeLoaded() {
    const doc = els.previewFrame.contentDocument;
    if (!doc) {
      setStatus('error', 'Render failed');
      return;
    }
    injectHighlightCSS(doc);
    blockNavigation(doc);
    attachSelectionListeners(doc);
    setStatus('ok', 'Ready');
  }

  /* --------------------------------------------------------------------------
   * Inject the visual highlight stylesheet into the iframe.
   * These classes are added/removed by our hover/click handlers.
   * -------------------------------------------------------------------------- */
  function injectHighlightCSS(doc) {
    const style = doc.createElement('style');
    style.setAttribute('data-xpath-studio', 'true');
    style.textContent = `
      .__xps-hover {
        outline: 2px dashed #2f6df6 !important;
        outline-offset: 1px !important;
        background-color: rgba(47, 109, 246, 0.06) !important;
        cursor: crosshair !important;
      }
      .__xps-selected {
        outline: 2px solid #12a06b !important;
        outline-offset: 1px !important;
        box-shadow: 0 0 0 4px rgba(18, 160, 107, 0.15) !important;
      }
      .__xps-flash {
        animation: __xps_flash 380ms ease-out !important;
      }
      @keyframes __xps_flash {
        0%   { background-color: rgba(53, 99, 247, 0.45) !important; }
        100% { background-color: transparent !important; }
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* --------------------------------------------------------------------------
   * Prevent navigation, form submission and other reload-causing events.
   * -------------------------------------------------------------------------- */
  function blockNavigation(doc) {
    // Force every link to open in nowhere — even if clicked outside pick mode.
    doc.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('data-xps-href', a.getAttribute('href'));
      a.setAttribute('href', 'javascript:void(0)');
      a.setAttribute('target', '_self');
    });

    // Block form submissions.
    doc.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // Belt-and-braces: cancel any future navigation attempts.
    doc.addEventListener('beforeunload', (e) => {
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* --------------------------------------------------------------------------
   * Hover + click selection inside the iframe.
   * Uses capture phase + stopPropagation so user JS / link defaults can't fire.
   * -------------------------------------------------------------------------- */
  let lastHover = null;

  function attachSelectionListeners(doc) {
    // Hover highlight (capture phase so user-page handlers can't pre-empt us)
    doc.addEventListener('mouseover', (e) => {
      if (!els.togglePick.checked) return;
      const t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (lastHover && lastHover !== t) {
        lastHover.classList.remove('__xps-hover');
      }
      // Always allow hover styling — even on the currently-selected element —
      // so the user sees their cursor is over a different (clickable) target.
      if (t !== state.selectedElement) {
        t.classList.add('__xps-hover');
      }
      lastHover = t;
    }, true);

    doc.addEventListener('mouseout', (e) => {
      if (e.target && e.target.classList) {
        e.target.classList.remove('__xps-hover');
      }
    }, true);

    // Click selection.
    // IMPORTANT: We do NOT intercept mousedown/mouseup. Doing so caused some
    // browsers to skip the follow-up click event after the first selection,
    // which is why re-clicking another element appeared to do nothing.
    doc.addEventListener('click', (e) => {
      if (!els.togglePick.checked) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      selectElement(e.target);
    }, true);

    // Block dblclick and aux clicks too (right-click menu still works).
    doc.addEventListener('dblclick', (e) => {
      if (els.togglePick.checked) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* --------------------------------------------------------------------------
   * Lock selection & generate locators
   * -------------------------------------------------------------------------- */
  function selectElement(target) {
    if (!target || target.nodeType !== 1) return;

    // Clear previous selection styling — even if it's the same element, the
    // remove/add cycle re-triggers the CSS animation as a click flash.
    if (state.selectedElement && state.selectedElement !== target) {
      state.selectedElement.classList.remove('__xps-selected');
    }
    target.classList.remove('__xps-hover');
    target.classList.remove('__xps-selected');
    // Force a reflow so the animation restarts on rapid re-clicks.
    void target.offsetWidth;
    target.classList.add('__xps-selected');
    target.classList.add('__xps-flash');
    setTimeout(() => target.classList.remove('__xps-flash'), 380);

    state.selectedElement = target;

    renderSelectedInfo(target);
    regenerateLocators();

    // After selection, surface the results panel (it's below the fold on
    // small screens). scrollIntoView with 'nearest' is a no-op when already
    // visible, so this is safe to call every click.
    if (els.selectedInfo) {
      els.selectedInfo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function clearSelection() {
    if (state.selectedElement) {
      state.selectedElement.classList.remove('__xps-selected');
      state.selectedElement.classList.remove('__xps-hover');
    }
    state.selectedElement = null;
    state.locators = [];
    els.selectedInfo.innerHTML =
      '<span class="muted">Click an element in the preview to see details and generated locators.</span>';
    els.locatorList.innerHTML =
      '<div class="empty-card empty-card-sm"><p class="muted">Locator suggestions will appear here.</p></div>';
  }

  /* --------------------------------------------------------------------------
   * Render the "Selected Element" summary
   * -------------------------------------------------------------------------- */
  function renderSelectedInfo(el) {
    const summary = XPathEngine.summarize(el);
    if (!summary) return;

    const parts = [];
    parts.push(`<span class="tag-name">&lt;${escapeHTML(summary.tag)}&gt;</span>`);

    Object.entries(summary.attributes).forEach(([k, v]) => {
      parts.push(
        ' <span class="attr-key">' + escapeHTML(k) + '</span>=' +
        '<span class="attr-val">"' + escapeHTML(v) + '"</span>'
      );
    });

    if (summary.text) {
      parts.push(`\n<span class="muted">text:</span> ${escapeHTML(summary.text)}`);
    }
    els.selectedInfo.innerHTML = parts.join('');
  }

  /* --------------------------------------------------------------------------
   * Generate + render locator cards
   * -------------------------------------------------------------------------- */
  function regenerateLocators() {
    if (!state.selectedElement) return;
    const doc = els.previewFrame.contentDocument;
    const includeIndex = els.toggleIndex.checked;

    state.locators = XPathEngine.generate(state.selectedElement, doc, { includeIndex });
    renderLocators();
  }

  function renderLocators() {
    if (!state.locators || state.locators.length === 0) {
      els.locatorList.innerHTML =
        '<div class="empty-card empty-card-sm"><p class="muted">No locator strategies could be derived for this element.</p></div>';
      return;
    }

    const filtered = state.locators.filter(l =>
      state.activeFilter === 'all' ? true : l.category === state.activeFilter
    );

    if (filtered.length === 0) {
      els.locatorList.innerHTML =
        '<div class="empty-card empty-card-sm"><p class="muted">No locators in this category. Try a different filter.</p></div>';
      return;
    }

    els.locatorList.innerHTML = filtered.map(renderCard).join('');
    wireCardHandlers();
    // New locators always start at the top — useful when re-selecting an
    // element while the list was scrolled half-way down from a previous one.
    els.locatorList.scrollTop = 0;
  }

  function renderCard(loc, idx) {
    const matchBadge = matchBadgeFor(loc);
    const stabilityBadge =
      `<span class="badge badge-${loc.stability}">${loc.stability} stability</span>`;

    const cssBlock = els.toggleCss.checked && loc.cssSelectorComputed
      ? `<div class="locator-explain"><strong>CSS:</strong> <code>${escapeHTML(loc.cssSelectorComputed)}</code></div>`
      : '';

    const snippetBlock = els.toggleSnippet.checked
      ? renderSnippetBlock(loc, idx)
      : '';

    return `
      <article class="locator-card" data-idx="${idx}" data-stab="${loc.stability}">
        <div class="locator-head">
          <span class="locator-title">${escapeHTML(loc.strategy)}</span>
          ${stabilityBadge}
          ${matchBadge}
          <span class="locator-meta">score ${loc.score}</span>
          <span class="spacer"></span>
        </div>

        <div class="locator-code">
          <code>${highlightXPath(loc.xpath)}</code>
          <button class="copy-btn" data-copy="${escapeAttr(loc.xpath)}" type="button" title="Copy XPath">
            <span class="copy-icon" aria-hidden="true">&#10697;</span> Copy
          </button>
        </div>

        <p class="locator-explain">${escapeHTML(loc.explanation)}</p>
        ${cssBlock}
        ${snippetBlock}
      </article>
    `;
  }

  function matchBadgeFor(loc) {
    if (!loc.matchesTarget) {
      return '<span class="badge badge-match-bad">does not resolve</span>';
    }
    if (loc.matchCount === 1) {
      return '<span class="badge badge-match-ok">1 match</span>';
    }
    if (loc.matchCount <= 5) {
      return `<span class="badge badge-match-warn">${loc.matchCount} matches</span>`;
    }
    return `<span class="badge badge-match-bad">${loc.matchCount} matches</span>`;
  }

  function renderSnippetBlock(loc, idx) {
    const lang = state.snippetLang;
    const snippet = XPathEngine.snippetFor(loc.xpath, lang);
    return `
      <div>
        <div class="snippet-tabs">
          ${['java', 'python', 'csharp'].map(l =>
            `<button class="snippet-tab ${l === lang ? 'active' : ''}" data-lang="${l}" data-card="${idx}" type="button">${l}</button>`
          ).join('')}
        </div>
        <pre class="snippet-block"><code>${escapeHTML(snippet)}</code></pre>
      </div>
    `;
  }

  function wireCardHandlers() {
    // Copy buttons
    els.locatorList.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => copyToClipboard(btn.getAttribute('data-copy')));
    });

    // Snippet language tabs
    els.locatorList.querySelectorAll('.snippet-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.snippetLang = tab.getAttribute('data-lang');
        renderLocators();
      });
    });
  }

  /* --------------------------------------------------------------------------
   * Filter chips
   * -------------------------------------------------------------------------- */
  function wireFilters() {
    els.filters.forEach(chip => {
      chip.addEventListener('click', () => {
        els.filters.forEach(c => c.classList.remove('chip-active'));
        chip.classList.add('chip-active');
        state.activeFilter = chip.getAttribute('data-filter');
        renderLocators();
      });
    });
  }

  /* --------------------------------------------------------------------------
   * Theme toggle (persisted)
   * The CSS reveals the right SVG (sun/moon) based on [data-theme]; we just
   * update the label text and persist the choice.
   * -------------------------------------------------------------------------- */
  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    const label = document.querySelector('#btn-theme .theme-label');
    if (label) label.textContent = theme === 'dark' ? 'Light' : 'Dark';
    try { localStorage.setItem('xps-theme', theme); } catch (e) {}
  }

  function toggleTheme() {
    const cur = document.body.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }

  /* --------------------------------------------------------------------------
   * Preview-expand toggle
   * Hides the HTML/URL input panel and grows the preview to full width so
   * the rendered page has room to breathe. Persists across sessions.
   * -------------------------------------------------------------------------- */
  function setPreviewExpanded(expanded) {
    document.body.classList.toggle('is-preview-max', expanded);
    if (els.btnExpandPreview) {
      els.btnExpandPreview.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    }
    if (els.expandLabel) {
      els.expandLabel.textContent = expanded ? 'Collapse' : 'Expand';
    }
    try { localStorage.setItem('xps-preview-max', expanded ? '1' : '0'); } catch (e) {}
  }
  function togglePreviewExpanded() {
    setPreviewExpanded(!document.body.classList.contains('is-preview-max'));
  }

  /* --------------------------------------------------------------------------
   * Browser-native fullscreen on the preview panel.
   * Esc / F11 leaves fullscreen. The page keeps working inside the preview.
   * -------------------------------------------------------------------------- */
  function toggleFullscreen() {
    const target = els.previewPanel || els.previewFrame;
    if (!target) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (target.requestFullscreen) {
      target.requestFullscreen().catch((err) => toast('Fullscreen denied: ' + err.message));
    } else {
      toast('Fullscreen not supported in this browser');
    }
  }

  /* --------------------------------------------------------------------------
   * Helpers
   * -------------------------------------------------------------------------- */
  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHTML(s).replace(/"/g, '&quot;');
  }

  /**
   * Lightweight XPath syntax highlighter for the locator card code blocks.
   * Order matters: escape first so we can match raw quotes and brackets.
   */
  function highlightXPath(xp) {
    const safe = escapeHTML(xp);
    return safe
      // String literals: 'single' or "double"
      .replace(/('[^']*'|"[^"]*")/g, '<span class="xp-str">$1</span>')
      // @attribute names
      .replace(/(@[\w-]+)/g, '<span class="xp-attr">$1</span>')
      // XPath functions and axes
      .replace(
        /\b(normalize-space|contains|concat|text|name|count|position|last|starts-with|ends-with|following|preceding|ancestor|descendant|parent|child|sibling|self|following-sibling|preceding-sibling)\b/g,
        '<span class="xp-fn">$1</span>'
      )
      // Positional indices like [1], [2]
      .replace(/(\[\d+\])/g, '<span class="xp-idx">$1</span>')
      // Path separators
      .replace(/(\/\/|\/)/g, '<span class="xp-slash">$1</span>');
  }

  function showValidation(v) {
    els.htmlValidation.textContent = v.message;
    els.htmlValidation.classList.toggle('is-error', !v.ok);
    els.htmlValidation.classList.toggle('is-ok', v.ok);
  }

  function setStatus(kind, label) {
    els.statusPill.className = 'status-pill status-' + kind;
    els.statusPill.textContent = label;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('XPath copied to clipboard'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('XPath copied'); }
    catch (e) { toast('Copy failed'); }
    document.body.removeChild(ta);
  }

  let toastTimer = null;
  function toast(msg, durationMs) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), durationMs || 1800);
  }

  /* --------------------------------------------------------------------------
   * Live Browse — opens the site in a NEW BROWSER TAB so the user can
   * interact with it using their real session (cookies, login, etc.).
   *
   * Why not an iframe? 95%+ of production websites set X-Frame-Options or
   * CSP frame-ancestors which blocks loading in iframes. The browser silently
   * shows a blank page and there's no reliable way to detect this from JS.
   * A new tab is the only approach that works universally.
   *
   * Flow:
   *   1. User enters URL → clicks Go
   *   2. We open the URL in a new browser tab
   *   3. User interacts (login, navigate, fill forms — full browser session)
   *   4. User clicks their bookmarklet → HTML auto-arrives via postMessage
   *   5. We render it in the sandboxed iframe with pick mode enabled
   *   OR
   *   4b. User clicks "Fetch via proxy" for static HTML
   * -------------------------------------------------------------------------- */
  let liveCaptureTab = null;
  let liveCaptureWatchdog = null;

  function startLiveBrowse(url) {
    const v = validateUrl(url);
    if (!v.ok) {
      showValidation({ ok: false, message: v.message });
      return;
    }

    const liveStatus = $('live-status');
    const addressBar = $('live-address-bar');
    const addressText = $('live-address');
    const previewTitle = $('preview-title');
    const btnFreeze = $('btn-freeze');

    state.liveUrl = v.url;
    state.liveMode = true;

    // Clean up any previous capture
    if (liveCaptureWatchdog) { clearInterval(liveCaptureWatchdog); liveCaptureWatchdog = null; }
    if (liveCaptureTab && !liveCaptureTab.closed) {
      try { liveCaptureTab.close(); } catch (e) {}
    }
    if (btnFreeze) btnFreeze.classList.add('hidden');

    // Open in a real browser tab
    liveCaptureTab = window.open(v.url, '_blank');
    if (!liveCaptureTab) {
      showValidation({ ok: false, message: 'Pop-up blocked — allow pop-ups for this page and click Go again.' });
      setStatus('error', 'Blocked');
      state.liveMode = false;
      return;
    }

    setStatus('working', 'Browsing…');
    showValidation({ ok: true, message: 'Site opened in new tab — interact with it, then capture.' });

    // Show address bar with "LIVE" indicator
    if (addressBar) addressBar.classList.remove('hidden');
    if (addressText) addressText.textContent = v.url;
    if (previewTitle) previewTitle.textContent = 'Live Browse';

    // Update status panel with instructions and fetch button
    if (liveStatus) {
      liveStatus.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:12px">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;' +
            'box-shadow:0 0 6px rgba(34,197,94,.6);animation:livePulse 1.5s ease-in-out infinite"></span>' +
            '<span class="field-hint" style="color:var(--success);font-weight:600">' +
              'Site opened in a new tab — interact with it now!' +
            '</span>' +
          '</div>' +

          '<div style="background:var(--bg-softer);border:1px solid var(--border);border-radius:8px;padding:12px 14px">' +
            '<p class="field-hint" style="margin:0 0 8px"><strong>When you\'re on the page you want:</strong></p>' +
            '<ol class="manual-steps" style="margin:0;gap:6px">' +
              '<li>Click your <strong>Copy HTML for XPath Studio</strong> bookmark in your bookmarks bar.</li>' +
              '<li>The page HTML will auto-render here with pick mode enabled.</li>' +
            '</ol>' +
          '</div>' +

          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
            '<button id="btn-live-proxy-fetch" class="btn btn-ghost btn-sm" type="button">' +
              'Or: Fetch via proxy (static HTML, no login)' +
            '</button>' +
            '<button id="btn-live-paste" class="btn btn-ghost btn-sm" type="button">' +
              '<span aria-hidden="true">&#128203;</span> Paste from clipboard' +
            '</button>' +
            '<button id="btn-live-cancel" class="btn btn-ghost btn-sm" type="button">' +
              'Cancel' +
            '</button>' +
          '</div>' +
        '</div>';

      // Wire buttons
      const btnProxy = $('btn-live-proxy-fetch');
      if (btnProxy) {
        btnProxy.addEventListener('click', async () => {
          try {
            const { html, via } = await fetchHtmlFromUrl(v.url);
            let processed = html;
            if (els.toggleStripScripts.checked) processed = stripScripts(processed);
            processed = injectBaseHref(processed, v.url);
            els.htmlInput.value = processed;
            showValidation({ ok: true, message: `Fetched via ${via} — ${processed.length.toLocaleString()} chars.` });
            finishLiveBrowse();
            renderHTML(processed);
          } catch (err) {
            showValidation({ ok: false, message: err.message });
            setStatus('error', 'Fetch failed');
          }
        });
      }
      const btnPaste = $('btn-live-paste');
      if (btnPaste) {
        btnPaste.addEventListener('click', async () => {
          finishLiveBrowse();
          await pasteFromClipboard();
        });
      }
      const btnCancel = $('btn-live-cancel');
      if (btnCancel) {
        btnCancel.addEventListener('click', () => finishLiveBrowse());
      }
    }

    // Watchdog: clean up if the tab is closed
    liveCaptureWatchdog = setInterval(() => {
      if (liveCaptureTab && liveCaptureTab.closed) {
        // Tab closed — leave status as-is (user may have clicked bookmarklet)
        clearInterval(liveCaptureWatchdog);
        liveCaptureWatchdog = null;
        liveCaptureTab = null;
      }
    }, 2000);
  }

  function finishLiveBrowse() {
    if (liveCaptureWatchdog) { clearInterval(liveCaptureWatchdog); liveCaptureWatchdog = null; }
    liveCaptureTab = null;
    state.liveMode = false;
    state.liveUrl = '';
    const addressBar = $('live-address-bar');
    const previewTitle = $('preview-title');
    const liveStatus = $('live-status');
    if (addressBar) addressBar.classList.add('hidden');
    if (previewTitle) previewTitle.textContent = 'Rendered Page';
    if (liveStatus) liveStatus.innerHTML = '<span class="field-hint">Enter a URL and click Go to start.</span>';
    setStatus('idle', 'Idle');
  }

  function freezeLivePage() {
    // In the new approach, freezing = fetch via proxy from the live browse tab
    if (state.liveUrl) {
      (async () => {
        try {
          const { html, via } = await fetchHtmlFromUrl(state.liveUrl);
          let processed = html;
          if (els.toggleStripScripts.checked) processed = stripScripts(processed);
          processed = injectBaseHref(processed, state.liveUrl);
          els.htmlInput.value = processed;
          showValidation({ ok: true, message: `Fetched via ${via} — ${processed.length.toLocaleString()} chars.` });
          finishLiveBrowse();
          renderHTML(processed);
        } catch (err) {
          showValidation({ ok: false, message: err.message });
          setStatus('error', 'Fetch failed');
        }
      })();
    }
  }

  function backToLive() {
    // Re-open the URL in a new tab
    if (state.liveUrl) {
      startLiveBrowse(state.liveUrl);
    }
  }

  function exitLiveMode() {
    finishLiveBrowse();
    els.previewFrame.classList.remove('hidden');
    const btnFreeze = $('btn-freeze');
    const btnBackToLive = $('btn-back-to-live');
    if (btnFreeze) btnFreeze.classList.add('hidden');
    if (btnBackToLive) btnBackToLive.classList.add('hidden');
    els.togglePick.checked = true;
  }

  /* --------------------------------------------------------------------------
   * Sample HTML loader — covers a wide variety of locator scenarios so the
   * engine can be tested end-to-end without leaving the app.
   * -------------------------------------------------------------------------- */
  const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Acme — Login</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7fb; }
    .header { background: #1f2937; color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header nav a { color: #cbd5e1; margin-left: 16px; text-decoration: none; }
    .container { max-width: 420px; margin: 64px auto; background: #fff; padding: 28px; border-radius: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.05); }
    h1 { font-size: 20px; margin-top: 0; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 13px; margin-bottom: 4px; color: #374151; }
    .field input { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
    .actions { display: flex; gap: 8px; margin-top: 20px; }
    .btn { padding: 10px 16px; border-radius: 6px; border: 0; font: inherit; cursor: pointer; }
    .btn-primary { background: #2f6df6; color: #fff; }
    .btn-secondary { background: #e5e7eb; color: #111827; }
    .links { font-size: 12px; margin-top: 12px; color: #6b7280; }
    .product-list { max-width: 720px; margin: 0 auto 60px; padding: 0 24px; }
    .product-list h2 { font-size: 16px; color: #374151; }
    .product { display: flex; gap: 12px; padding: 12px; border-bottom: 1px solid #eef0f5; }
    .price { color: #12a06b; font-weight: 600; }
  </style>
</head>
<body>
  <header class="header">
    <div>Acme Corp</div>
    <nav>
      <a href="/home">Home</a>
      <a href="/products" data-testid="nav-products">Products</a>
      <a href="/contact" aria-label="Contact us">Contact</a>
    </nav>
  </header>

  <main class="container" role="main">
    <h1>Sign in to your account</h1>

    <form id="login-form" action="/api/login" method="post">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" type="email" name="username" placeholder="you@company.com" autocomplete="email" />
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" name="password" placeholder="••••••••" />
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-primary" data-testid="login-submit">Sign in</button>
        <button type="button" class="btn btn-secondary" id="cancel-btn-css-1a2b3c">Cancel</button>
      </div>

      <p class="links">
        <a href="/forgot" title="Reset your password">Forgot password?</a>
      </p>
    </form>
  </main>

  <section class="product-list">
    <h2>Featured</h2>
    <div class="product" data-qa="product-card">
      <div>Laptop Pro 14"</div>
      <div class="spacer"></div>
      <div class="price">$1,299.00</div>
    </div>
    <div class="product" data-qa="product-card">
      <div>Wireless Mouse</div>
      <div class="spacer"></div>
      <div class="price">$29.00</div>
    </div>
    <div class="product" data-qa="product-card">
      <div>Mechanical Keyboard</div>
      <div class="spacer"></div>
      <div class="price">$129.00</div>
    </div>
  </section>
</body>
</html>`;

  /* --------------------------------------------------------------------------
   * Boot
   * -------------------------------------------------------------------------- */
  function init() {
    // Theme: prefer saved -> OS preference -> light.
    let theme = 'light';
    try { theme = localStorage.getItem('xps-theme') || theme; } catch (e) {}
    if (!localStorage.getItem('xps-theme') &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) {
      theme = 'dark';
    }
    applyTheme(theme);

    // Tabs
    els.tabHtml.addEventListener('click', () => setInputMode('html'));
    els.tabUrl.addEventListener('click',  () => setInputMode('url'));
    const tabLive = $('tab-live');
    if (tabLive) tabLive.addEventListener('click', () => setInputMode('live'));
    setInputMode('html');

    // Live Browse
    const btnLiveGo = $('btn-live-go');
    const liveUrlInput = $('live-url-input');
    if (btnLiveGo) {
      btnLiveGo.addEventListener('click', () => {
        if (liveUrlInput) startLiveBrowse(liveUrlInput.value);
      });
    }
    if (liveUrlInput) {
      liveUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          startLiveBrowse(liveUrlInput.value);
        }
      });
    }
    const btnFreeze = $('btn-freeze');
    if (btnFreeze) btnFreeze.addEventListener('click', freezeLivePage);
    const btnBackToLive = $('btn-back-to-live');
    if (btnBackToLive) btnBackToLive.addEventListener('click', backToLive);

    // Bookmarklet: set the live href so drag-to-bookmarks captures real JS.
    const bookmarkletHref = buildBookmarkletHref();
    if (els.bookmarklet) {
      els.bookmarklet.setAttribute('href', bookmarkletHref);
      els.bookmarklet.addEventListener('click', (e) => {
        e.preventDefault();
        toast('Drag this button to your bookmarks bar — or use "Copy bookmarklet code" below');
      });
    }

    // Populate the raw bookmarklet code textarea and wire the copy button
    const bookmarkletCodeBox = document.getElementById('bookmarklet-code-box');
    if (bookmarkletCodeBox) {
      bookmarkletCodeBox.value = bookmarkletHref;
      bookmarkletCodeBox.addEventListener('click', () => bookmarkletCodeBox.select());
    }

    const btnCopyBookmarklet = document.getElementById('btn-copy-bookmarklet');
    if (btnCopyBookmarklet) {
      btnCopyBookmarklet.addEventListener('click', () => {
        copyToClipboard(bookmarkletHref);
        toast('Bookmarklet code copied! Now create a bookmark and paste it as the URL');
      });
    }

    // Show the embedded XPath Studio URL
    const studioUrlDisplay = document.getElementById('studio-url-display');
    if (studioUrlDisplay) {
      studioUrlDisplay.textContent = location.href.split('?')[0].split('#')[0];
    }
    if (els.btnPasteClipboard) {
      els.btnPasteClipboard.addEventListener('click', pasteFromClipboard);
    }

    // Open & Capture flow (uses browser's existing session)
    if (els.btnOpenCapture) {
      els.btnOpenCapture.addEventListener('click', openAndCapture);
    }
    if (els.btnCancelCapture) {
      els.btnCancelCapture.addEventListener('click', () => finishCapture(false));
    }
    if (els.btnPasteDuringCapture) {
      els.btnPasteDuringCapture.addEventListener('click', async () => {
        // The bookmarklet falls back to clipboard whenever postMessage isn't
        // possible (e.g. COOP-protected sites). The user can use this button
        // to bring that clipboard into the renderer without leaving the wait.
        finishCapture(true); // hide the waiting card
        await pasteFromClipboard();
      });
    }
    attachPostMessageListener();

    // Scroll-to-top button inside the URL pane (the pane is taller than
    // viewport with all flows expanded — make it easy to jump back).
    const urlForm = els.paneUrl && els.paneUrl.querySelector('.url-form');
    if (urlForm && els.btnScrollTop) {
      urlForm.addEventListener('scroll', () => {
        els.btnScrollTop.classList.toggle('is-faded', urlForm.scrollTop < 240);
      });
      els.btnScrollTop.addEventListener('click', () => {
        urlForm.scrollTo({ top: 0, behavior: 'smooth' });
        els.btnScrollTop.classList.add('is-faded');
      });
    }

    // Persist custom proxy across sessions
    if (els.customProxy) {
      try {
        const saved = localStorage.getItem('xps-custom-proxy');
        if (saved) els.customProxy.value = saved;
      } catch (e) {}
      els.customProxy.addEventListener('input', () => {
        try { localStorage.setItem('xps-custom-proxy', els.customProxy.value); } catch (e) {}
      });
    }

    // Buttons
    els.btnRender.addEventListener('click', handleRender);
    els.btnClear.addEventListener('click', () => {
      els.htmlInput.value = '';
      els.urlInput.value  = '';
      els.previewFrame.srcdoc = '';
      els.previewEmpty.classList.remove('hidden');
      showValidation({ ok: true, message: 'Cleared.' });
      setStatus('idle', 'Idle');
      clearSelection();
      if (state.liveMode) exitLiveMode();
    });
    els.btnSample.addEventListener('click', () => {
      setInputMode('html');
      els.htmlInput.value = SAMPLE_HTML;
      renderHTML(SAMPLE_HTML);
    });
    els.btnTheme.addEventListener('click', toggleTheme);
    els.btnClearSel.addEventListener('click', clearSelection);
    if (els.btnExpandPreview) els.btnExpandPreview.addEventListener('click', togglePreviewExpanded);
    if (els.btnFullscreen)    els.btnFullscreen.addEventListener('click', toggleFullscreen);

    // Restore expanded-preview preference
    let savedExpanded = '0';
    try { savedExpanded = localStorage.getItem('xps-preview-max') || '0'; } catch (e) {}
    if (savedExpanded === '1') setPreviewExpanded(true);

    // Global keyboard shortcuts (browser-friendly: Ctrl+Shift modifier)
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === 'l') {
        e.preventDefault();
        toggleTheme();
      } else if (key === 'e') {
        e.preventDefault();
        togglePreviewExpanded();
      } else if (key === 'f') {
        e.preventDefault();
        toggleFullscreen();
      }
    });

    // Toggles re-generate locators when their state changes.
    [els.toggleIndex, els.toggleCss, els.toggleSnippet].forEach(t => {
      t.addEventListener('change', () => {
        if (els.toggleCss.checked) computeCssSelectors();
        regenerateLocators();
      });
    });

    wireFilters();

    // Convenience: Ctrl/Cmd+Enter triggers Render from either input.
    const triggerOnCtrlEnter = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleRender();
      }
    };
    els.htmlInput.addEventListener('keydown', triggerOnCtrlEnter);
    els.urlInput.addEventListener('keydown',  triggerOnCtrlEnter);

    // Global scroll-to-top button (floats at bottom-right when scrolled)
    const globalScrollBtn = document.getElementById('global-scroll-top');
    if (globalScrollBtn) {
      window.addEventListener('scroll', () => {
        globalScrollBtn.classList.toggle('is-faded', window.scrollY < 200);
      }, { passive: true });
      globalScrollBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    setStatus('idle', 'Idle');
  }

  /**
   * Compute CSS selectors lazily — only when the user enables the toggle.
   * Stored on the locator object so renderLocators() can show them without
   * re-running the engine.
   */
  function computeCssSelectors() {
    if (!state.selectedElement) return;
    const doc = els.previewFrame.contentDocument;
    state.locators.forEach(loc => {
      if (!loc.cssSelectorComputed) {
        loc.cssSelectorComputed = XPathEngine.cssSelectorFor(state.selectedElement, doc) || '(no unique CSS selector found)';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
