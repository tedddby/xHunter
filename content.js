/* xHunter — content script
 * Scrapes the visible job-description text from the current page on demand.
 * The popup messages this script with { type: 'EXTRACT_JD' } and receives { text }.
 */

(function () {
  // Avoid registering the listener twice if the script is injected more than once
  // (declared content script + programmatic executeScript fallback).
  if (window.__cvTailorContentLoaded) return;
  window.__cvTailorContentLoaded = true;

  // Selector tiers in priority order. The earliest tier that yields usable text
  // wins; we fall through to broader containers and finally <body>.
  const SELECTOR_TIERS = [
    '[class*="description"]',
    '[class*="job-detail"]',
    '[id*="job-description"]',
    'article',
    'main',
    'body'
  ];

  function normalize(text) {
    return (text || '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .trim();
  }

  function bestTextForSelector(selector) {
    let best = '';
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (e) {
      return '';
    }
    nodes.forEach((el) => {
      const t = normalize(el.innerText || el.textContent || '');
      if (t.length > best.length) best = t;
    });
    return best;
  }

  function extractJobDescription() {
    // First, if the user has selected text on the page, trust that selection.
    const selection = normalize(String(window.getSelection ? window.getSelection() : ''));
    if (selection.length >= 100) return selection;

    // Otherwise, walk the selector tiers and keep the longest usable result.
    let result = '';
    for (const selector of SELECTOR_TIERS) {
      const text = bestTextForSelector(selector);
      if (text.length > result.length) result = text;
      // Early exit once a non-body tier already gives us plenty of content.
      if (selector !== 'body' && result.length >= 400) break;
    }
    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'EXTRACT_JD') {
      try {
        sendResponse({ text: extractJobDescription() });
      } catch (e) {
        sendResponse({ text: '', error: String(e && e.message ? e.message : e) });
      }
    }
    // Synchronous response above; no need to keep the channel open.
    return false;
  });
})();
