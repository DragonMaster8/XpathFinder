# XPath Studio

A 100% client-side **XPath generator for Selenium automation engineers**. Paste any HTML source, render it in a sandboxed iframe, click any element, and get a **ranked list of Selenium-friendly XPath locators** with live uniqueness validation.

> No backend. No external dependencies. No data leaves the browser.

---

## Quick start

1. Open `index.html` in any modern Chromium / Firefox / Edge browser.
   _(Double-click is enough — no build step.)_
2. Choose an input mode in the left panel:
   - **Paste HTML** — paste full HTML source, or click **Load Sample**.
   - **Fetch URL** — type any `http://` or `https://` URL.
3. Click **Render** (or **Fetch & Render** in URL mode).
4. Hover any element in the preview to highlight, then click to lock the selection.
5. Read the ranked locators in the bottom panel; click **Copy** on any card.

Keyboard shortcut: **Ctrl/⌘ + Enter** inside the input triggers Render.

---

## URL mode

> **Why isn't fetching just automatic with my browser cookies?**
>
> The browser's **same-origin policy** is a hard security boundary: JavaScript
> running on `xpath-studio.html` cannot read cookies for `gmail.com`, cannot
> make authenticated requests to `gmail.com`, and cannot read the DOM of an
> iframe loading `gmail.com`. If it could, every malicious site you visited
> could read your bank account. There is **no flag, header, or trick** to
> bypass this from a regular web page — only a browser extension could.
>
> The good news: **we don't need to bypass it**. The bookmarklet runs *inside*
> the target tab, where the cookies and rendered DOM already live, and ships
> the result back here over `postMessage`. That gives you the same outcome with
> just one click.

The URL pane offers three flows that share a single URL field:

### Flow A — Open & Capture *(recommended for authenticated sites & SPAs)*

1. Type the URL.
2. Click **Open in new tab & capture**.
3. The page opens in a **new tab using your existing browser session** —
   cookies, login state, Cloudflare clearance, all of it.
4. Click your **Copy HTML for XPath Studio** bookmark on that tab.
5. The bookmarklet detects it was opened by XPath Studio and posts the rendered
   HTML back via `postMessage`. The tab auto-closes; XPath Studio auto-renders.

This is the right flow for:

- React/Angular/Vue SPAs after hydration
- Pages behind login (Gmail, Jira, internal admin tools)
- Cloudflare/CAPTCHA-protected pages (you've already passed)
- Anything that requires cookies / a real browser session

You only set up the bookmarklet once (Flow C). After that, capture is one click.

### Flow B — Fetch via proxy *(for public / static / SSR pages)*

Click **Render** at the top. The app tries proxies in order and uses the first
that succeeds:

1. **Direct fetch** — works for the rare site with permissive CORS
   (e.g. `raw.githubusercontent.com`, public APIs).
2. `https://api.codetabs.com/v1/proxy/?quest=…`
3. `https://api.allorigins.win/raw?url=…`
4. `https://api.cors.lol/?url=…`
5. `https://corsproxy.io/?…`
6. `https://thingproxy.freeboard.io/fetch/…`

Each attempt has a 12-second timeout and a Cloudflare-interstitial check, so a
slow or blocked proxy doesn't stall the fallback chain. The error message lists
every attempt with its specific failure reason.

**Custom proxy (Advanced)** — set your own proxy URL template using `{url}` as
a placeholder, or end with `=` / `?` / `/` to append. It's tried before the
public proxies and saved in `localStorage`. Set this if you run your own
cors-anywhere on Heroku/Render/Cloudflare Worker.

Two post-processing toggles, both on by default:

- **Strip `<script>` tags** — removes `<script>` blocks and inline event
  handlers (`onclick="…"`) before rendering. Defense in depth — the iframe
  sandbox already blocks JS execution.
- **Inject `<base href>`** — adds `<base href="…">` so relative URLs to CSS,
  images, and fonts resolve against the original origin.

### Flow C — Bookmarklet *(one-time setup)*

Drag the **Copy HTML for XPath Studio** button to your bookmarks bar. The
bookmarklet has two modes:

- **postMessage mode** — when run on a tab opened via *Open & Capture*, it
  sends the HTML back to XPath Studio automatically (no clipboard).
- **Clipboard mode** — when run on any other tab (e.g. one you navigated to
  manually), it copies the HTML to clipboard. You then click **Paste from
  clipboard & render** in XPath Studio.

The bookmarklet captures `document.documentElement.outerHTML` *after* the page
has rendered, so SPA content and authenticated state are included.

---

## File layout

| File              | Purpose                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `index.html`      | Three-panel UI: input (HTML / URL tabs) / preview / results.                                  |
| `styles.css`      | Light + dark themes, refined cards, syntax-token colors, animations.                          |
| `xpath-engine.js` | Pure UI-agnostic locator generation engine + validation + snippet export.                     |
| `app.js`          | UI controller: tab switching, URL fetch, iframe injection, selection events, rendering, copy. |

---

## XPath generation strategy

The engine evaluates each candidate strategy in priority order and **validates every produced XPath against the actual DOM** (using `document.evaluate`). The match count appears as a badge on every card.

| # | Strategy                       | Score | When it's used                                                |
|---|--------------------------------|------:|---------------------------------------------------------------|
| 1 | `@id`                          |  100  | Element has a non-dynamic `id`.                               |
| 2 | `@data-testid` / `@data-qa` / `@data-cy` / `@data-automation` | 95 | Engineer-added test hooks.                          |
| 3 | `@name`                        |   80  | Form controls.                                                |
| 4 | `@aria-label` / `@aria-labelledby` / `@role` | 55–75 | Accessibility hooks (user-facing contracts).      |
| 5 | `@placeholder` / `@title` / `@alt` | 65 | User-visible attributes — stable as long as copy is.         |
| 6 | Associated `<label for="…">`   |   60  | Inputs without good attributes but with a real label.         |
| 7 | `normalize-space()='text'`     |   60  | Buttons, links, headings with short stable text.              |
| 8 | Single stable class            |   50  | Filtered to **semantic** classes only (see below).            |
| 9 | Relative to nearest stable ancestor | 45–70 | Walks up to 6 levels for an anchor.                       |
| 10| Short tag-and-index path       |   25  | Last-resort fallback.                                         |

### Locators we deliberately **do not** suggest

- ❌ Absolute paths (`/html/body/div[3]/...`) — break on any DOM change.
- ❌ Auto-generated CSS-module class chains (`.css-1q2w3e4r`).
- ❌ Random framework IDs (UUIDs, `ember1234`, `react-aria-…`, `ng-…`, etc.).
- ❌ `contains(text(), …)` when an exact `normalize-space()` match exists — `contains` quietly matches partial / unintended elements.
- ❌ Long positional indices like `[7]` unless **Include positional index** is on.

### Stability scoring

Each candidate gets a base score (table above), then:

- `+5` if it resolves to **exactly 1** element
- `−25` if it matches multiple elements (when index option is off)
- `−10` if positional index was appended to disambiguate
- `−35` if the locator does not actually resolve to the picked element

Final score → badge: **High ≥ 80**, **Medium ≥ 50**, **Low** otherwise.

### Dynamic-value detection (heuristics)

A value is treated as machine-generated and discarded if it matches any of:

- `css-1ab23cd`, `jss-4f8e` (CSS-modules)
- UUIDs
- Long hex hashes (≥ 16 hex chars)
- 6+ consecutive digits anywhere
- `_abc123`, `ember12`, `react-aria-…`, `ng-……`
- BEM-with-auto-suffix: `block__element__abcdef`

### Utility-class filtering (Tailwind & friends)

Classes that are pure layout/utility tokens carry zero identification value, so they are skipped:

```
m- mt- mb- ml- mr- p- pt- pb- pl- pr- mx- my- px- py-
w- h- text- bg- border-
flex grid block inline hidden absolute relative fixed static
rounded… shadow… font… leading… tracking… opacity…
hover: focus: active: disabled:
```

### XPath safety details

- Single-quote strings are escaped using `concat('a', "'", 'b')` — the canonical XPath 1.0 trick (no escape character exists).
- Class predicates use `contains(concat(' ', normalize-space(@class), ' '), ' token ')` so a single token can be matched safely inside a multi-class list.
- All text matching uses `normalize-space()` to neutralize whitespace and nested text nodes.

---

## Selenium snippet export

Toggle **Show Selenium snippet** on any card. Tabs let you switch between:

```java
WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(10));
WebElement element = wait.until(
    ExpectedConditions.presenceOfElementLocated(By.xpath("…"))
);
```

```python
element = WebDriverWait(driver, 10).until(
    EC.presence_of_element_located((By.XPATH, "…"))
)
```

```csharp
var wait = new WebDriverWait(driver, TimeSpan.FromSeconds(10));
IWebElement element = wait.Until(d => d.FindElement(By.XPath("…")));
```

---

## Sandboxing & safety

The preview iframe is rendered with:

```html
<iframe sandbox="allow-same-origin"></iframe>
```

- **`allow-same-origin`** lets the parent app read `iframe.contentDocument` — required for selection.
- **No `allow-scripts`** — every `<script>` tag in your pasted HTML is silently ignored. The page renders for visual inspection only.
- All `<a href>` are rewritten to `javascript:void(0)` and `<form submit>` events are intercepted, so clicking inside the preview never reloads the iframe.
- Hover / click events are listened to in **capture phase** with `stopImmediatePropagation()` to prevent any leftover handlers from firing.

---

## Optional features

- **URL fetch mode** — pull HTML from any public page via a CORS proxy.
- **Include positional index when needed** — appends `[N]` to non-unique locators.
- **Also show CSS selector** — adds a secondary CSS selector under each XPath (only when uniqueness can be guaranteed).
- **Show Selenium snippet** — Java / Python / C# snippet under each card.
- **Filter chips** — show only Attribute / Text / Relative locators.
- **XPath syntax highlighting** in the locator code blocks.
- **Stability stripe** — colored left edge on each card (green/orange/red) for at-a-glance ranking.
- **Dark mode** — auto-detects OS preference, persisted in localStorage.

---

## Browser support

Tested on the latest **Chrome**, **Edge**, and **Firefox**. The app uses:

- `<iframe srcdoc>` and `sandbox`
- `document.evaluate` (XPath 1.0)
- `navigator.clipboard` (with `execCommand('copy')` fallback)
- `CSS.escape`

No IE / legacy support.
