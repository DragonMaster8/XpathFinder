/* ============================================================================
 * XPath Studio — Locator Generation Engine
 * ----------------------------------------------------------------------------
 * Pure (UI-agnostic) functions that, given a target HTMLElement and the owning
 * Document, return a ranked list of Selenium-friendly locator candidates.
 *
 * Design philosophy:
 *   - Prefer attributes that QA engineers intentionally add for testability
 *     (id, data-test*, name, aria-label, placeholder, title).
 *   - Treat dynamic / framework-generated identifiers as untrustworthy and
 *     downgrade or drop them entirely.
 *   - Every produced XPath is validated against the live document to report
 *     real-world uniqueness (the #1 reason locators break in CI).
 *   - Avoid absolute paths (/html/body/...) and excessive positional indices.
 *
 * Public API:
 *   XPathEngine.generate(element, doc, options)  -> Locator[]
 *   XPathEngine.evaluateXPath(xpath, doc)        -> Element[]
 *   XPathEngine.cssSelectorFor(element, doc)     -> string | null
 *   XPathEngine.snippetFor(xpath, language)      -> string
 * ========================================================================== */

(function (global) {
  'use strict';

  /* --------------------------------------------------------------------------
   * Constants & heuristics
   * -------------------------------------------------------------------------- */

  // Attributes that are intentionally added by engineers for testability.
  // Listed in priority order — checked left-to-right.
  const TEST_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-qa',
    'data-cy',
    'data-automation',
    'data-automation-id'
  ];

  // Maximum text length to embed in a text-based XPath.
  // Longer text is brittle (whitespace, translations, copy edits).
  const MAX_TEXT_LEN = 80;

  // Tags whose text content is meaningful for selection.
  const TEXT_TAGS = new Set([
    'a', 'button', 'label', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'td', 'th', 'option', 'strong', 'em', 'b', 'i', 'small', 'caption',
    'figcaption', 'legend', 'summary'
  ]);

  // Patterns that flag a value as machine-generated (CSS-modules, hashes, etc).
  const DYNAMIC_PATTERNS = [
    /^[a-z]+-[0-9a-f]{6,}$/i,                  // css-1ab23cd, jss-4f8e
    /^[a-z]+_[0-9a-f]{6,}$/i,                  // MuiButton_1abcdef
    /-(?=[a-f0-9]*\d)[0-9a-f]{6,}$/i,          // anything-…-1a2b3c (suffix w/ digit)
    /_(?=[a-f0-9]*\d)[0-9a-f]{6,}$/i,          // anything_…_1a2b3c (suffix w/ digit)
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid
    /^[0-9a-f]{16,}$/i,                        // long hex hash
    /^_[a-z0-9]{5,}$/i,                        // _abc123
    /^[a-z]+__[a-zA-Z0-9_-]{5,}$/,             // BEM-ish auto-suffix
    /^ember\d+$/i,
    /^react-[a-z0-9-]+$/i,
    /^ng-[a-z0-9-]{6,}$/i,
    /__[a-z0-9]{6,}$/i,
    /\d{6,}/                                   // 6+ consecutive digits anywhere
  ];

  // Fragment-style class names typical of utility frameworks (Tailwind, etc).
  // These exist on many elements and rarely identify anything uniquely.
  const UTILITY_CLASS_PATTERNS = [
    /^(m|p|mt|mb|ml|mr|pt|pb|pl|pr|mx|my|px|py)-/,    // spacing utilities
    /^(w|h)-/,                                          // width/height utilities
    /^(text|bg|border)-/,                               // color utilities
    /^(flex|grid|block|inline|hidden|absolute|relative|fixed|static)$/,
    /^(rounded|shadow|font|leading|tracking|opacity)/,
    /^(hover|focus|active|disabled):/
  ];

  /* --------------------------------------------------------------------------
   * Small helpers
   * -------------------------------------------------------------------------- */

  /**
   * Safely escape a string for embedding inside an XPath string literal.
   * Handles single quotes by switching to concat() — the canonical XPath 1.0
   * trick because there is no escape character.
   */
  function xpathLiteral(value) {
    if (value == null) return "''";
    const str = String(value);
    if (str.indexOf("'") === -1) return "'" + str + "'";
    if (str.indexOf('"') === -1) return '"' + str + '"';
    // Mixed quotes: build concat('a', "'", 'b', ...).
    const parts = str.split("'");
    const pieces = [];
    parts.forEach((p, i) => {
      if (p.length) pieces.push("'" + p + "'");
      if (i < parts.length - 1) pieces.push('"\'"');
    });
    return 'concat(' + pieces.join(', ') + ')';
  }

  /** Trim & collapse internal whitespace the way XPath normalize-space() does. */
  function normalizeSpace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  /** Heuristic: does this token look auto-generated? */
  function looksDynamic(value) {
    if (!value) return false;
    const v = String(value).trim();
    if (!v) return false;
    return DYNAMIC_PATTERNS.some(rx => rx.test(v));
  }

  /** Heuristic: is this class a low-signal utility class? */
  function isUtilityClass(cls) {
    return UTILITY_CLASS_PATTERNS.some(rx => rx.test(cls));
  }

  /**
   * Extract an element's "stable" classes — meaningful, semantic, non-dynamic.
   * Returns an array sorted by perceived stability (best first).
   */
  function stableClassesOf(element) {
    if (!element.classList || element.classList.length === 0) return [];
    const all = Array.from(element.classList);
    return all
      .filter(c => c && c.length > 1)
      .filter(c => !looksDynamic(c))
      .filter(c => !isUtilityClass(c))
      // Prefer slightly longer / hyphenated names — they tend to be semantic.
      .sort((a, b) => b.length - a.length);
  }

  /** Get the visible (direct) text of an element, excluding child element text. */
  function directText(element) {
    let t = '';
    for (const node of element.childNodes) {
      if (node.nodeType === 3) t += node.nodeValue; // TEXT_NODE
    }
    return normalizeSpace(t);
  }

  /** Get the full inner text, normalized. */
  function innerTextOf(element) {
    return normalizeSpace(element.textContent || '');
  }

  /* --------------------------------------------------------------------------
   * XPath evaluation (uniqueness validation)
   * -------------------------------------------------------------------------- */

  /**
   * Evaluate an XPath in the given document and return all matched elements.
   * Wrapped in try/catch — invalid XPath returns [].
   */
  function evaluateXPath(xpath, doc) {
    try {
      const result = doc.evaluate(
        xpath,
        doc,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      const out = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        out.push(result.snapshotItem(i));
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  /**
   * Determine if `xpath` resolves uniquely to `target` in `doc`.
   * Returns: { count, isUniqueToTarget, indexOfTarget }
   */
  function validate(xpath, target, doc) {
    const matches = evaluateXPath(xpath, doc);
    const idx = matches.indexOf(target);
    return {
      count: matches.length,
      isUniqueToTarget: matches.length === 1 && idx === 0,
      indexOfTarget: idx
    };
  }

  /* --------------------------------------------------------------------------
   * Locator strategies — each returns one or more candidate XPaths.
   * Each strategy is deliberately small and explainable.
   * -------------------------------------------------------------------------- */

  function tryById(el) {
    const id = el.getAttribute('id');
    if (!id) return null;
    if (looksDynamic(id)) {
      return {
        strategy: 'id (dynamic — avoid)',
        category: 'attribute',
        xpath: `//${el.tagName.toLowerCase()}[@id=${xpathLiteral(id)}]`,
        score: 25,
        explanation:
          'ID looks auto-generated (matches a known dynamic-id pattern). ' +
          'Selenium tests using this will likely break on re-render or rebuild.'
      };
    }
    return {
      strategy: 'ID',
      category: 'attribute',
      xpath: `//${el.tagName.toLowerCase()}[@id=${xpathLiteral(id)}]`,
      score: 100,
      explanation:
        'Uses the element\'s id attribute. IDs are unique per page in valid HTML ' +
        'and are the most stable Selenium locator when not auto-generated.'
    };
  }

  function tryByTestAttr(el) {
    for (const attr of TEST_ATTRS) {
      const val = el.getAttribute(attr);
      if (val && !looksDynamic(val)) {
        return {
          strategy: attr,
          category: 'attribute',
          xpath: `//${el.tagName.toLowerCase()}[@${attr}=${xpathLiteral(val)}]`,
          score: 95,
          explanation:
            `Uses the ${attr} hook explicitly added for test automation. ` +
            'These attributes are owned by engineering and are the recommended ' +
            'locator strategy in modern Selenium / Cypress / Playwright stacks.'
        };
      }
    }
    return null;
  }

  function tryByName(el) {
    const name = el.getAttribute('name');
    if (!name || looksDynamic(name)) return null;
    return {
      strategy: 'name',
      category: 'attribute',
      xpath: `//${el.tagName.toLowerCase()}[@name=${xpathLiteral(name)}]`,
      score: 80,
      explanation:
        'Uses the @name attribute — common on form controls and generally stable, ' +
        'because the backend depends on it.'
    };
  }

  function tryByAria(el) {
    const candidates = [
      ['aria-label', 75],
      ['aria-labelledby', 70],
      ['role', 55]
    ];
    for (const [attr, score] of candidates) {
      const val = el.getAttribute(attr);
      if (val && !looksDynamic(val)) {
        return {
          strategy: attr,
          category: 'attribute',
          xpath: `//${el.tagName.toLowerCase()}[@${attr}=${xpathLiteral(val)}]`,
          score: score,
          explanation:
            `Uses the ${attr} accessibility attribute. ` +
            'Accessibility attributes are user-facing contracts and rarely change ' +
            'silently — making them stable Selenium hooks.'
        };
      }
    }
    return null;
  }

  function tryByPlaceholderOrTitle(el) {
    for (const attr of ['placeholder', 'title', 'alt']) {
      const val = el.getAttribute(attr);
      if (val && !looksDynamic(val)) {
        return {
          strategy: attr,
          category: 'attribute',
          xpath: `//${el.tagName.toLowerCase()}[@${attr}=${xpathLiteral(val)}]`,
          score: 65,
          explanation:
            `Uses @${attr}. User-visible attribute — stable as long as the UI copy ` +
            'is stable. Watch out for i18n.'
        };
      }
    }
    return null;
  }

  function tryByForOnLabel(el) {
    // Inputs with an associated <label for="..."> can be located via the label.
    if (!['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) return null;
    const id = el.id;
    if (!id || looksDynamic(id)) return null;
    const doc = el.ownerDocument;
    const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (!lbl) return null;
    const text = directText(lbl) || innerTextOf(lbl);
    if (!text || text.length > MAX_TEXT_LEN) return null;
    return {
      strategy: 'associated label',
      category: 'text',
      xpath:
        `//label[normalize-space()=${xpathLiteral(text)}]/` +
        `following::${el.tagName.toLowerCase()}[1]`,
      score: 60,
      explanation:
        'Locates the visible <label> by text and walks to its associated input. ' +
        'Resilient to internal id/name churn, since labels are user-facing.'
    };
  }

  function tryByText(el) {
    const tag = el.tagName.toLowerCase();
    if (!TEXT_TAGS.has(tag)) return null;

    const text = directText(el);
    if (!text || text.length > MAX_TEXT_LEN) return null;

    return {
      strategy: 'text (normalize-space)',
      category: 'text',
      xpath: `//${tag}[normalize-space()=${xpathLiteral(text)}]`,
      score: 60,
      explanation:
        'Matches by exact visible text using normalize-space() to neutralize ' +
        'whitespace and nested text-node quirks. Preferred over contains(text()) ' +
        'because contains() matches partial / unintended elements.'
    };
  }

  function tryByClass(el) {
    const stable = stableClassesOf(el);
    if (stable.length === 0) return null;
    const cls = stable[0];
    const tag = el.tagName.toLowerCase();
    return {
      strategy: 'stable class',
      category: 'attribute',
      // Use the canonical "contains a token" XPath — robust to multi-class lists.
      xpath:
        `//${tag}[contains(concat(' ', normalize-space(@class), ' '), ` +
        `${xpathLiteral(' ' + cls + ' ')})]`,
      score: 50,
      explanation:
        `Uses the single semantic class "${cls}". The contains(concat(...)) form ` +
        'safely matches one whole token within a space-separated class list. ' +
        'Skipped utility classes (e.g. Tailwind) and dynamic CSS-module hashes.'
    };
  }

  /**
   * Walk up the tree to find the nearest ancestor with a strong identifier
   * and produce a relative XPath of the form //ancestor[hook]//tag[hook-or-text].
   */
  function tryByRelativeAncestor(el) {
    const tag = el.tagName.toLowerCase();
    let anc = el.parentElement;
    let depth = 0;

    while (anc && depth < 6) {
      depth++;

      const ancHook = strongHookFor(anc);
      if (ancHook) {
        const selfHook = strongHookFor(el) || classHookFor(el) || textHookFor(el);
        const selfPart = selfHook
          ? `${tag}[${selfHook}]`
          : tag;

        const xpath = `//${anc.tagName.toLowerCase()}[${ancHook}]//${selfPart}`;

        return {
          strategy: 'relative to stable ancestor',
          category: 'relative',
          xpath: xpath,
          score: selfHook ? 70 : 45,
          explanation:
            `Anchored on a stable ancestor <${anc.tagName.toLowerCase()}> ` +
            `(${ancHook}) and descends to the target. Useful when the element ` +
            'itself has no unique attribute.'
        };
      }
      anc = anc.parentElement;
    }
    return null;
  }

  /** Build an XPath predicate fragment for an element's strongest attribute. */
  function strongHookFor(el) {
    const id = el.getAttribute && el.getAttribute('id');
    if (id && !looksDynamic(id)) return `@id=${xpathLiteral(id)}`;

    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v && !looksDynamic(v)) return `@${attr}=${xpathLiteral(v)}`;
    }

    const name = el.getAttribute && el.getAttribute('name');
    if (name && !looksDynamic(name)) return `@name=${xpathLiteral(name)}`;

    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && !looksDynamic(aria)) return `@aria-label=${xpathLiteral(aria)}`;

    return null;
  }

  function classHookFor(el) {
    const stable = stableClassesOf(el);
    if (stable.length === 0) return null;
    return `contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(' ' + stable[0] + ' ')})`;
  }

  function textHookFor(el) {
    if (!TEXT_TAGS.has(el.tagName.toLowerCase())) return null;
    const text = directText(el);
    if (!text || text.length > MAX_TEXT_LEN) return null;
    return `normalize-space()=${xpathLiteral(text)}`;
  }

  /* --------------------------------------------------------------------------
   * Additional relative / contextual strategies — expand the locator menu so
   * the user can pick the form that fits their page best.
   * -------------------------------------------------------------------------- */

  /** //tag[contains(@class, ' a ') and contains(@class, ' b ')] — tighter than single class */
  function tryByMultipleClasses(el) {
    const stable = stableClassesOf(el);
    if (stable.length < 2) return null;
    const tag = el.tagName.toLowerCase();
    const top = stable.slice(0, 3);
    const conds = top.map(c =>
      `contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(' ' + c + ' ')})`
    ).join(' and ');
    return {
      strategy: 'multiple stable classes (AND)',
      category: 'attribute',
      xpath: `//${tag}[${conds}]`,
      score: 60,
      explanation:
        `Combines ${top.length} stable classes with AND (${top.join(', ')}). ` +
        'Tighter than a single-class match — useful when one class is too generic.'
    };
  }

  /** //tag[contains(normalize-space(), 'partial')] — fallback when text is dynamic */
  function tryByContainsText(el) {
    const tag = el.tagName.toLowerCase();
    if (!TEXT_TAGS.has(tag)) return null;
    const fullText = directText(el);
    if (!fullText || fullText.length < 4) return null;

    // Use the first few words / first 30 chars as the stable substring.
    const words = fullText.split(/\s+/);
    const partial = words.slice(0, Math.min(3, words.length)).join(' ').slice(0, 30);
    if (!partial || partial === fullText || partial.length < 4) return null;

    return {
      strategy: 'contains() text',
      category: 'text',
      xpath: `//${tag}[contains(normalize-space(), ${xpathLiteral(partial)})]`,
      score: 45,
      explanation:
        'Uses contains(normalize-space(), …) with a stable substring. ' +
        'Recommended when the visible text has dynamic suffixes (counts, ' +
        'icons, status indicators) appended to it.'
    };
  }

  /** //tag[starts-with(normalize-space(), 'prefix')] */
  function tryByStartsWithText(el) {
    const tag = el.tagName.toLowerCase();
    if (!TEXT_TAGS.has(tag)) return null;
    const text = directText(el);
    if (!text || text.length < 6) return null;
    const prefix = text.split(/\s+/).slice(0, 2).join(' ').slice(0, 24);
    if (!prefix || prefix === text || prefix.length < 4) return null;
    return {
      strategy: 'starts-with() text',
      category: 'text',
      xpath: `//${tag}[starts-with(normalize-space(), ${xpathLiteral(prefix)})]`,
      score: 42,
      explanation:
        'Matches by the first words of the visible text. Useful for buttons / ' +
        'links that have a stable prefix and a dynamic tail (e.g. "Submit (3)").'
    };
  }

  /**
   * //label[normalize-space()='X']/following-sibling::tag[1]
   * Common pattern for form fields paired with a labeled sibling.
   */
  function tryByPrecedingSiblingText(el) {
    const tag = el.tagName.toLowerCase();
    let prev = el.previousElementSibling;
    let hops = 1;
    while (prev && hops <= 3) {
      const ptag = prev.tagName.toLowerCase();
      if (TEXT_TAGS.has(ptag)) {
        const text = directText(prev);
        if (text && text.length <= MAX_TEXT_LEN) {
          return {
            strategy: 'preceding sibling by text',
            category: 'relative',
            xpath:
              `//${ptag}[normalize-space()=${xpathLiteral(text)}]` +
              `/following-sibling::${tag}[${hops}]`,
            score: 60,
            explanation:
              `Locates a labeled sibling <${ptag}> by its text "${text}" and ` +
              `walks ${hops} sibling${hops > 1 ? 's' : ''} forward. ` +
              'Common pattern for forms where the label is just before the field.'
          };
        }
      }
      prev = prev.previousElementSibling;
      hops++;
    }
    return null;
  }

  /**
   * //tag[normalize-space()='X']/preceding-sibling::tag[1]
   * Mirror of the above, for elements that come BEFORE a labeled sibling.
   */
  function tryByFollowingSiblingText(el) {
    const tag = el.tagName.toLowerCase();
    let next = el.nextElementSibling;
    let hops = 1;
    while (next && hops <= 3) {
      const ntag = next.tagName.toLowerCase();
      if (TEXT_TAGS.has(ntag)) {
        const text = directText(next);
        if (text && text.length <= MAX_TEXT_LEN) {
          return {
            strategy: 'following sibling by text',
            category: 'relative',
            xpath:
              `//${ntag}[normalize-space()=${xpathLiteral(text)}]` +
              `/preceding-sibling::${tag}[${hops}]`,
            score: 50,
            explanation:
              `Anchors on a labeled sibling that follows the target and walks ` +
              `back. Useful for items that come before their visible label.`
          };
        }
      }
      next = next.nextElementSibling;
      hops++;
    }
    return null;
  }

  /**
   * //parentTag[parentHook]/childTag — direct-child path from a stable parent.
   */
  function tryByDirectParentChild(el) {
    const parent = el.parentElement;
    if (!parent) return null;
    const ptag = parent.tagName.toLowerCase();
    const ctag = el.tagName.toLowerCase();
    const parentHook = strongHookFor(parent) || classHookFor(parent);
    if (!parentHook) return null;

    // Decide between direct child (single occurrence) vs. nth-of-type.
    const sameTagChildren = Array.from(parent.children).filter(
      c => c.tagName === el.tagName
    );
    const idx = sameTagChildren.indexOf(el) + 1;
    const childPart =
      sameTagChildren.length > 1 ? `${ctag}[${idx}]` : ctag;

    return {
      strategy: 'direct child of stable parent',
      category: 'relative',
      xpath: `//${ptag}[${parentHook}]/${childPart}`,
      score: 55,
      explanation:
        `Locates the target as a direct child of <${ptag}> (${parentHook}). ` +
        (sameTagChildren.length > 1
          ? `${idx} of ${sameTagChildren.length} sibling <${ctag}>s.`
          : 'Only <' + ctag + '> child.')
    };
  }

  /**
   * //ancestor[hook]//tag[N] — nth occurrence of a tag inside a stable ancestor.
   * Useful for repeating items (rows, cards, list items).
   */
  function tryByNthInAncestor(el) {
    const tag = el.tagName.toLowerCase();
    let anc = el.parentElement;
    let depth = 0;
    while (anc && depth < 5) {
      const hook = strongHookFor(anc);
      if (hook) {
        const sameTagInAnc = Array.from(anc.querySelectorAll(tag));
        const idx = sameTagInAnc.indexOf(el) + 1;
        if (idx > 0 && sameTagInAnc.length > 1) {
          return {
            strategy: 'nth-of-tag within ancestor',
            category: 'relative',
            xpath: `(//${anc.tagName.toLowerCase()}[${hook}]//${tag})[${idx}]`,
            score: 45,
            explanation:
              `${idx}${ordinalSuffix(idx)} <${tag}> inside <${anc.tagName.toLowerCase()}> ` +
              `(${hook}). Use for repeating rows / cards / list items where the ` +
              'specific item differs only by position.'
          };
        }
      }
      anc = anc.parentElement;
      depth++;
    }
    return null;
  }

  function ordinalSuffix(n) {
    const j = n % 10, k = n % 100;
    if (j === 1 && k !== 11) return 'st';
    if (j === 2 && k !== 12) return 'nd';
    if (j === 3 && k !== 13) return 'rd';
    return 'th';
  }

  /** //a[contains(@href, '/path')] */
  function tryByHrefContains(el) {
    if (el.tagName.toLowerCase() !== 'a') return null;
    const href = el.getAttribute('href');
    if (!href) return null;
    if (href === '#' || href.startsWith('javascript:') || href.length < 3) return null;
    // Normalize: drop scheme+host so the locator is host-independent.
    const cleaned = href
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/[?#].*$/, '')
      .trim();
    if (!cleaned || cleaned.length < 2) return null;
    return {
      strategy: 'href contains',
      category: 'attribute',
      xpath: `//a[contains(@href, ${xpathLiteral(cleaned)})]`,
      score: 65,
      explanation:
        `Matches the link by a stable path fragment of its href ("${cleaned}"). ` +
        'Survives query-string and hostname changes.'
    };
  }

  /** //img[contains(@src, 'filename.png')] */
  function tryBySrcContains(el) {
    if (el.tagName.toLowerCase() !== 'img') return null;
    const src = el.getAttribute('src');
    if (!src) return null;
    const last = src.split('/').pop().split('?')[0];
    if (!last || last.length < 3) return null;
    return {
      strategy: 'image filename',
      category: 'attribute',
      xpath: `//img[contains(@src, ${xpathLiteral(last)})]`,
      score: 60,
      explanation:
        `Locates the <img> by its filename ("${last}"). Stable across CDN ` +
        'hostname / query-string changes.'
    };
  }

  /** //input[@type='X'] inside a stable form context. */
  function tryByInputType(el) {
    if (el.tagName.toLowerCase() !== 'input') return null;
    const type = el.getAttribute('type');
    if (!type) return null;
    const form = el.closest('form');
    if (!form) {
      // No form context — at least scope by type alone (low score).
      return {
        strategy: 'input type only',
        category: 'attribute',
        xpath: `//input[@type=${xpathLiteral(type)}]`,
        score: 30,
        explanation: 'Matches every input of this type — likely non-unique. Useful only ' +
          'on simple pages with a single input of that type.'
      };
    }
    const formHook = strongHookFor(form) || classHookFor(form);
    if (!formHook) return null;
    return {
      strategy: 'input type inside form',
      category: 'relative',
      xpath: `//form[${formHook}]//input[@type=${xpathLiteral(type)}]`,
      score: 55,
      explanation:
        `Scopes to <input type="${type}"> within a stable <form> ancestor. ` +
        'Better than @type alone when the page has multiple forms.'
    };
  }

  /**
   * //*[contains(@<attr>, 'value')] — generic "attribute contains" for any
   * stable-looking attribute that wasn't already used by another strategy.
   */
  function tryByAttributeContains(el) {
    const tag = el.tagName.toLowerCase();
    // Look for stable, identifying-looking attributes we haven't tried yet.
    const candidates = ['for', 'value', 'href', 'src', 'rel', 'role'];
    for (const attr of candidates) {
      const v = el.getAttribute(attr);
      if (!v || looksDynamic(v) || v.length < 3) continue;
      // Use exact match if value is short and likely stable; contains otherwise.
      if (v.length <= 24) {
        return {
          strategy: `@${attr} (exact)`,
          category: 'attribute',
          xpath: `//${tag}[@${attr}=${xpathLiteral(v)}]`,
          score: 55,
          explanation: `Exact match on @${attr}. Reasonably stable for short, semantic values.`
        };
      }
      // Long value: contains() with a meaningful substring.
      const head = v.replace(/[?#].*$/, '').slice(0, 24).trim();
      if (head.length < 4) continue;
      return {
        strategy: `@${attr} contains`,
        category: 'attribute',
        xpath: `//${tag}[contains(@${attr}, ${xpathLiteral(head)})]`,
        score: 45,
        explanation: `Substring match on @${attr}. Use when the full value is dynamic.`
      };
    }
    return null;
  }

  /**
   * Last-resort relative path: short walk up the DOM with tag + nth-of-type.
   * Used only if everything else failed — flagged as low stability.
   */
  function tryByShortPath(el) {
    const segments = [];
    let cur = el;
    let depth = 0;

    while (cur && cur.nodeType === 1 && cur !== cur.ownerDocument.documentElement && depth < 4) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;
      const sameTagSiblings = Array.from(parent.children).filter(
        c => c.tagName === cur.tagName
      );
      const idx = sameTagSiblings.indexOf(cur) + 1;
      const seg = sameTagSiblings.length > 1 ? `${tag}[${idx}]` : tag;
      segments.unshift(seg);
      cur = parent;
      depth++;
    }
    if (segments.length === 0) return null;

    return {
      strategy: 'short relative path (fallback)',
      category: 'relative',
      xpath: '//' + segments.join('/'),
      score: 25,
      explanation:
        'Fallback path using tag + positional indices. Use sparingly — this is ' +
        'fragile to surrounding markup changes. Provided so you always have ' +
        'a working locator.'
    };
  }

  /* --------------------------------------------------------------------------
   * Optional: minimal CSS selector for the same element (secondary output).
   * -------------------------------------------------------------------------- */
  function cssSelectorFor(el, doc) {
    if (!el || el.nodeType !== 1) return null;

    // 1. ID
    const id = el.getAttribute('id');
    if (id && !looksDynamic(id)) {
      const sel = `${el.tagName.toLowerCase()}#${CSS.escape(id)}`;
      if (doc.querySelectorAll(sel).length === 1) return sel;
    }

    // 2. Test attribute
    for (const attr of TEST_ATTRS) {
      const v = el.getAttribute(attr);
      if (v && !looksDynamic(v)) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(v)}"]`;
        if (doc.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 3. name
    const name = el.getAttribute('name');
    if (name && !looksDynamic(name)) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (doc.querySelectorAll(sel).length === 1) return sel;
    }

    // 4. Stable class chain (parent > el)
    const stable = stableClassesOf(el);
    if (stable.length) {
      const sel = `${el.tagName.toLowerCase()}.${CSS.escape(stable[0])}`;
      if (doc.querySelectorAll(sel).length === 1) return sel;
    }

    return null;
  }

  /* --------------------------------------------------------------------------
   * Selenium snippet generator
   * -------------------------------------------------------------------------- */
  function snippetFor(xpath, language) {
    const safeXp = xpath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (language === 'python') {
      return (
        'from selenium.webdriver.common.by import By\n' +
        'from selenium.webdriver.support.ui import WebDriverWait\n' +
        'from selenium.webdriver.support import expected_conditions as EC\n\n' +
        'element = WebDriverWait(driver, 10).until(\n' +
        `    EC.presence_of_element_located((By.XPATH, "${safeXp}"))\n` +
        ')'
      );
    }
    if (language === 'csharp') {
      return (
        'using OpenQA.Selenium;\n' +
        'using OpenQA.Selenium.Support.UI;\n\n' +
        'var wait = new WebDriverWait(driver, TimeSpan.FromSeconds(10));\n' +
        `IWebElement element = wait.Until(d => d.FindElement(By.XPath("${safeXp}")));`
      );
    }
    // Default: Java
    return (
      'import org.openqa.selenium.By;\n' +
      'import org.openqa.selenium.WebElement;\n' +
      'import org.openqa.selenium.support.ui.WebDriverWait;\n' +
      'import org.openqa.selenium.support.ui.ExpectedConditions;\n' +
      'import java.time.Duration;\n\n' +
      'WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(10));\n' +
      'WebElement element = wait.until(\n' +
      `    ExpectedConditions.presenceOfElementLocated(By.xpath("${safeXp}"))\n` +
      ');'
    );
  }

  /* --------------------------------------------------------------------------
   * Public: generate ranked, validated locators
   * -------------------------------------------------------------------------- */

  /**
   * @param {Element} element  The element selected by the user
   * @param {Document} doc     Owner document (the iframe's document)
   * @param {object}  options
   *   - includeIndex (bool)   When non-unique, append [N] to point at this element
   * @returns {Array<Locator>} ranked best-first
   */
  function generate(element, doc, options) {
    options = options || {};
    if (!element || element.nodeType !== 1) return [];

    const strategies = [
      // Strong attribute-based (high stability)
      tryById,
      tryByTestAttr,
      tryByName,
      tryByAria,
      tryByPlaceholderOrTitle,
      tryByHrefContains,
      tryBySrcContains,
      tryByAttributeContains,

      // Text-based (multiple variants — exact, contains, starts-with)
      tryByForOnLabel,
      tryByText,
      tryByContainsText,
      tryByStartsWithText,

      // Class-based (single, then multi)
      tryByClass,
      tryByMultipleClasses,

      // Relative / contextual (the patterns the user asked for more of)
      tryByPrecedingSiblingText,
      tryByFollowingSiblingText,
      tryByDirectParentChild,
      tryByRelativeAncestor,
      tryByNthInAncestor,
      tryByInputType,

      // Last-resort
      tryByShortPath
    ];

    const seen = new Set();
    const out = [];

    for (const fn of strategies) {
      let candidate;
      try { candidate = fn(element); } catch (e) { candidate = null; }
      if (!candidate) continue;
      if (seen.has(candidate.xpath)) continue;
      seen.add(candidate.xpath);

      // Validate against the actual document.
      const v = validate(candidate.xpath, element, doc);
      candidate.matchCount = v.count;
      candidate.matchesTarget = v.indexOfTarget !== -1;

      // Adjust score & possibly add an index when not unique.
      if (v.count === 0 || v.indexOfTarget === -1) {
        // Locator does not actually resolve to the picked element — bury it.
        candidate.score -= 35;
      } else if (v.count === 1) {
        candidate.score += 5; // bonus for unique
      } else {
        // Non-unique. Either drop (unstable) or append index per option.
        if (options.includeIndex) {
          const indexed = `(${candidate.xpath})[${v.indexOfTarget + 1}]`;
          // Re-validate the indexed form.
          const v2 = validate(indexed, element, doc);
          if (v2.count === 1) {
            candidate.xpath = indexed;
            candidate.matchCount = 1;
            candidate.explanation +=
              ' Positional index appended because the base locator matched ' +
              `${v.count} elements.`;
            candidate.score -= 10;
          } else {
            candidate.score -= 20;
          }
        } else {
          candidate.score -= 25;
        }
      }

      candidate.stability = bandFor(candidate.score);
      candidate.cssSelector = null; // populated lazily by app.js if user opts in
      out.push(candidate);
    }

    // Sort high score first, dedupe by xpath, cap at 14 cards.
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 14);
  }

  function bandFor(score) {
    if (score >= 80) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
  }

  /* --------------------------------------------------------------------------
   * HTML element summary (used by the "Selected Element" panel)
   * -------------------------------------------------------------------------- */
  function summarize(el) {
    if (!el) return null;
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    return {
      tag: el.tagName.toLowerCase(),
      attributes: attrs,
      text: normalizeSpace(el.textContent || '').slice(0, 120)
    };
  }

  /* --------------------------------------------------------------------------
   * Export
   * -------------------------------------------------------------------------- */
  global.XPathEngine = {
    generate,
    evaluateXPath,
    cssSelectorFor,
    snippetFor,
    summarize,
    // Exposed for testing / reuse
    _internals: {
      xpathLiteral, looksDynamic, stableClassesOf, normalizeSpace
    }
  };
})(window);
