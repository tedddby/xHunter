/* xHunter — popup logic
 * Handles storage, CV input/parsing, the analyze/tailor flows, the match report
 * UI, clipboard, and jsPDF generation. DeepSeek calls themselves run in the
 * background service worker (see background.js).
 */

(() => {
  'use strict';

  const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 52; // r = 52 in the SVG viewBox

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    gearBtn: $('gearBtn'),
    settingsPanel: $('settingsPanel'),
    apiKeyInput: $('apiKeyInput'),
    saveKeyBtn: $('saveKeyBtn'),
    keySaved: $('keySaved'),

    tabPaste: $('tabPaste'),
    tabUpload: $('tabUpload'),
    pastePanel: $('pastePanel'),
    uploadPanel: $('uploadPanel'),
    cvTextarea: $('cvTextarea'),

    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    filePreview: $('filePreview'),
    fileName: $('fileName'),
    fileChars: $('fileChars'),
    filePreviewText: $('filePreviewText'),

    saveCvBtn: $('saveCvBtn'),
    cvSaved: $('cvSaved'),

    analyzeBtn: $('analyzeBtn'),
    errorBox: $('errorBox'),

    reportCard: $('reportCard'),
    gaugeArc: $('gaugeArc'),
    scoreNumber: $('scoreNumber'),
    reportSummary: $('reportSummary'),
    strengthsList: $('strengthsList'),
    gapsList: $('gapsList'),
    keywordsBlock: $('keywordsBlock'),
    keywordsList: $('keywordsList'),

    actionFooter: $('actionFooter'),
    tailorBtn: $('tailorBtn'),
    downloadBtn: $('downloadBtn'),
    resetBtn: $('resetBtn')
  };

  // ---------- State ----------
  const state = {
    mode: 'paste', // 'paste' | 'upload'
    uploadedText: '',
    jobDescription: '',
    tailoredCv: ''
  };

  // ---------- Storage helpers ----------
  const storageGet = (keys) =>
    new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (obj) =>
    new Promise((resolve) => chrome.storage.local.set(obj, resolve));

  // ---------- Utilities ----------
  function currentCvText() {
    return state.mode === 'upload' && state.uploadedText
      ? state.uploadedText
      : el.cvTextarea.value;
  }

  function showError(message) {
    el.errorBox.textContent = message;
    el.errorBox.classList.remove('hidden');
    // Re-trigger the shake animation.
    el.errorBox.style.animation = 'none';
    void el.errorBox.offsetWidth;
    el.errorBox.style.animation = '';
  }

  function clearError() {
    el.errorBox.classList.add('hidden');
    el.errorBox.textContent = '';
  }

  function describeError(code) {
    if (code === 'NO_KEY') return 'Please enter your DeepSeek API key';
    if (code === 'PARSE') return "Analysis failed — couldn't parse response. Try again.";
    if (code === 'PARSE_CV') return "Tailoring failed — couldn't parse response. Try again.";
    return code || 'Something went wrong. Please try again.';
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  // ---------- Settings (API key) ----------
  el.gearBtn.addEventListener('click', () => {
    const hidden = el.settingsPanel.classList.toggle('hidden');
    el.gearBtn.classList.toggle('active', !hidden);
    if (!hidden) el.apiKeyInput.focus();
  });

  el.saveKeyBtn.addEventListener('click', async () => {
    // Strip any non-ASCII characters (invisible copy-paste artifacts) that
    // would make the Authorization header invalid in the background fetch.
    const key = el.apiKeyInput.value.replace(/[^\x21-\x7E]/g, '');
    el.apiKeyInput.value = key; // reflect the cleaned key back to the user
    await storageSet({ deepseek_api_key: key });
    el.keySaved.classList.remove('hidden');
    if (key) clearError();
    setTimeout(() => el.keySaved.classList.add('hidden'), 2200);
  });

  // ---------- Tabs ----------
  function setMode(mode) {
    state.mode = mode;
    const isPaste = mode === 'paste';
    el.tabPaste.classList.toggle('active', isPaste);
    el.tabUpload.classList.toggle('active', !isPaste);
    el.tabPaste.setAttribute('aria-selected', String(isPaste));
    el.tabUpload.setAttribute('aria-selected', String(!isPaste));
    el.pastePanel.classList.toggle('hidden', !isPaste);
    el.uploadPanel.classList.toggle('hidden', isPaste);
  }
  el.tabPaste.addEventListener('click', () => setMode('paste'));
  el.tabUpload.addEventListener('click', () => setMode('upload'));

  // ---------- File upload / parsing ----------
  el.dropzone.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFile(file);
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.dropzone.classList.remove('dragover');
    })
  );
  el.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.dropzone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  async function handleFile(file) {
    clearError();
    const name = file.name.toLowerCase();
    try {
      let text = '';
      if (name.endsWith('.docx')) {
        text = await parseDocx(file);
      } else if (name.endsWith('.pdf')) {
        text = await parsePdf(file);
      } else {
        showError('Unsupported file type. Please upload a PDF or DOCX.');
        return;
      }
      text = text.trim();
      if (!text) {
        showError('Could not extract any text from that file.');
        return;
      }
      state.uploadedText = text;
      renderFilePreview(file.name, text);
    } catch (e) {
      showError(`Failed to read file: ${e && e.message ? e.message : e}`);
    }
  }

  async function parseDocx(file) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    return result.value || '';
  }

  async function parsePdf(file) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      chrome.runtime.getURL('libs/pdf.worker.min.js');
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(' ') + '\n';
    }
    return out;
  }

  function renderFilePreview(name, text) {
    el.fileName.textContent = name;
    el.fileChars.textContent = `${text.length.toLocaleString()} chars`;
    el.filePreviewText.textContent =
      text.slice(0, 200) + (text.length > 200 ? '…' : '');
    el.filePreview.classList.remove('hidden');
  }

  // ---------- Save CV ----------
  el.saveCvBtn.addEventListener('click', async () => {
    const cv = currentCvText().trim();
    if (!cv) {
      showError('Nothing to save — paste or upload your CV first.');
      return;
    }
    clearError();
    await storageSet({ cv_text: cv });
    el.cvSaved.classList.remove('hidden');
    // replay the success animation
    el.cvSaved.style.animation = 'none';
    void el.cvSaved.offsetWidth;
    el.cvSaved.style.animation = '';
    setTimeout(() => el.cvSaved.classList.add('hidden'), 2400);
  });

  // ---------- Job-description extraction ----------
  function getActiveTab() {
    return new Promise((resolve) =>
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
        resolve(tabs && tabs[0])
      )
    );
  }

  function sendMessageToTab(tabId, msg) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp);
      });
    });
  }

  async function extractJobDescription() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) throw new Error('No active tab found.');

    // Try the already-injected content script first.
    try {
      const resp = await sendMessageToTab(tab.id, { type: 'EXTRACT_JD' });
      if (resp && typeof resp.text === 'string') return resp.text;
    } catch (_) {
      /* not injected yet — fall through to programmatic injection */
    }

    // Fallback: inject content.js into the active tab, then retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      const resp = await sendMessageToTab(tab.id, { type: 'EXTRACT_JD' });
      return resp && typeof resp.text === 'string' ? resp.text : '';
    } catch (e) {
      throw new Error("Can't read this page. Open a normal job-posting tab and try again.");
    }
  }

  // ---------- Analyze flow ----------
  function setAnalyzeLoading(loading) {
    el.analyzeBtn.classList.toggle('loading', loading);
    el.analyzeBtn.disabled = loading;
  }

  el.analyzeBtn.addEventListener('click', runAnalyze);

  async function runAnalyze() {
    clearError();

    const { deepseek_api_key, cv_text } = await storageGet([
      'deepseek_api_key',
      'cv_text'
    ]);

    if (!deepseek_api_key || !deepseek_api_key.trim()) {
      showError('Please enter your DeepSeek API key');
      el.settingsPanel.classList.remove('hidden');
      el.gearBtn.classList.add('active');
      return;
    }
    if (!cv_text || !cv_text.trim()) {
      showError('Please save your CV first');
      return;
    }

    setAnalyzeLoading(true);
    try {
      const jd = (await extractJobDescription()).trim();
      if (jd.length < 100) {
        showError("Couldn't extract job description — try selecting the job text manually");
        setAnalyzeLoading(false);
        return;
      }
      state.jobDescription = jd;

      // Fire the request. The result (or error) is delivered by the
      // chrome.storage.onChanged listener below — the single source of truth,
      // which also covers the popup being reopened mid-request. We await only
      // to surface transport failures (e.g. the service worker not starting).
      await chrome.runtime.sendMessage({ type: 'ANALYZE', cv: cv_text, jd });
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
      setAnalyzeLoading(false);
    }
  }

  // ---------- Render match report ----------
  function scoreColor(score) {
    if (score >= 80) return getComputedStyle(document.documentElement)
      .getPropertyValue('--success').trim();
    if (score >= 60) return getComputedStyle(document.documentElement)
      .getPropertyValue('--warning').trim();
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--danger').trim();
  }

  function renderReport(analysis) {
    clearError();
    const score = Math.max(0, Math.min(100, Number(analysis.match_score) || 0));

    // Reset arc to empty so it visibly draws in.
    el.gaugeArc.style.transition = 'none';
    el.gaugeArc.style.strokeDashoffset = String(GAUGE_CIRCUMFERENCE);
    el.gaugeArc.style.stroke = scoreColor(score);

    el.reportSummary.textContent = analysis.summary || '';

    renderChips(el.strengthsList, analysis.matches, 'match');
    renderChips(el.gapsList, analysis.mismatches, 'mismatch');
    renderKeywords(analysis.keywords_to_add);

    el.reportCard.classList.remove('hidden');

    // Animate the arc + count-up on the next frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.gaugeArc.style.transition = '';
        const offset = GAUGE_CIRCUMFERENCE * (1 - score / 100);
        el.gaugeArc.style.strokeDashoffset = String(offset);
        animateCount(el.scoreNumber, score, 800);
      });
    });

    // A fresh analysis invalidates any previously tailored CV.
    state.tailoredCv = '';
    el.downloadBtn.classList.add('hidden');

    // Reveal the sticky footer + Tailor button (re-trigger its spring animation).
    el.actionFooter.classList.remove('hidden');
    el.tailorBtn.classList.remove('hidden', 'loading');
    el.tailorBtn.style.animation = 'none';
    void el.tailorBtn.offsetWidth;
    el.tailorBtn.style.animation = '';

    el.reportCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderChips(container, items, kind) {
    container.innerHTML = '';
    (items || []).forEach((text, i) => {
      const chip = document.createElement('div');
      chip.className = `chip ${kind}`;
      chip.textContent = text;
      chip.style.animationDelay = `${i * 50}ms`;
      container.appendChild(chip);
    });
    if (!items || items.length === 0) {
      const none = document.createElement('div');
      none.className = `chip ${kind}`;
      none.style.opacity = '0.6';
      none.textContent = kind === 'match' ? 'None identified' : 'None identified';
      container.appendChild(none);
    }
  }

  function renderKeywords(keywords) {
    el.keywordsList.innerHTML = '';
    if (!keywords || keywords.length === 0) {
      el.keywordsBlock.classList.add('hidden');
      return;
    }
    keywords.forEach((kw, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'keyword-chip';
      chip.textContent = kw;
      chip.style.animationDelay = `${i * 50}ms`;
      chip.addEventListener('click', () => copyKeyword(chip, kw));
      el.keywordsList.appendChild(chip);
    });
    el.keywordsBlock.classList.remove('hidden');
  }

  async function copyKeyword(chip, text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      /* clipboard may be unavailable; still flash for feedback */
    }
    chip.classList.add('copied');
    setTimeout(() => chip.classList.remove('copied'), 700);
  }

  function animateCount(node, target, duration) {
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      // ease-out
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(tick);
      else node.textContent = String(target);
    }
    requestAnimationFrame(tick);
  }

  // ---------- Tailor flow ----------
  function setTailorLoading(loading) {
    el.tailorBtn.classList.toggle('loading', loading);
    el.tailorBtn.disabled = loading;
  }

  el.tailorBtn.addEventListener('click', runTailor);

  async function runTailor() {
    clearError();
    const { cv_text } = await storageGet(['cv_text']);
    if (!cv_text || !cv_text.trim()) {
      showError('Please save your CV first');
      return;
    }
    if (!state.jobDescription) {
      showError('Run "Analyze Match" first so we know the job.');
      return;
    }

    setTailorLoading(true);
    try {
      // Result delivered via the storage.onChanged listener (see below).
      await chrome.runtime.sendMessage({
        type: 'TAILOR',
        cv: cv_text,
        jd: state.jobDescription
      });
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
      setTailorLoading(false);
    }
  }

  // ---------- PDF generation ----------
  el.downloadBtn.addEventListener('click', () => {
    const resume = state.tailoredCv;
    if (!resume || typeof resume !== 'object' || !Array.isArray(resume.sections)) {
      showError('No tailored CV yet — tailor your CV first.');
      return;
    }
    try {
      generateResumePdf(resume);
    } catch (e) {
      showError(`PDF generation failed: ${e && e.message ? e.message : e}`);
    }
  });

  // Renders a structured resume to a clean, ATS-friendly PDF that mirrors the
  // classic Jake Gutierrez LaTeX template: centered name, ruled section
  // headers, bold role + right-aligned dates, italic org/location, • bullets.
  function generateResumePdf(resume) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait' });
    const FONT = 'times';
    const pageW = doc.internal.pageSize.getWidth(); // 215.9
    const pageH = doc.internal.pageSize.getHeight(); // 279.4
    const M = 12.7; // 0.5in margins, like the template
    const contentW = pageW - M * 2;
    const BOTTOM = pageH - M;
    const INDENT = 5; // bullet hanging indent
    let y = M;

    doc.setTextColor(20, 20, 20);

    const ensure = (h) => {
      if (y + h > BOTTOM) {
        doc.addPage();
        y = M;
      }
    };

    // ---- Header: name + contact ----
    const name = (resume.name || 'Your Name').trim();
    doc.setFont(FONT, 'bold');
    doc.setFontSize(22);
    doc.text(name, pageW / 2, y + 7, { align: 'center' });
    y += 11;

    const contact = (resume.contact || []).filter(Boolean);
    if (contact.length) {
      doc.setFont(FONT, 'normal');
      doc.setFontSize(9.5);
      const wrapped = doc.splitTextToSize(contact.join('   |   '), contentW);
      wrapped.forEach((line) => {
        doc.text(line, pageW / 2, y, { align: 'center' });
        y += 4.4;
      });
    }
    y += 2.5;

    // ---- Sections ----
    for (const section of resume.sections || []) {
      const title = (section.title || '').trim().toUpperCase();
      const entries = section.entries || [];
      if (!title && entries.length === 0) continue;

      ensure(11);
      doc.setFont(FONT, 'bold');
      doc.setFontSize(12);
      doc.text(title, M, y + 3);
      y += 4.6;
      doc.setLineWidth(0.3);
      doc.setDrawColor(20, 20, 20);
      doc.line(M, y, pageW - M, y);
      y += 3.4;

      for (const entry of entries) renderEntry(entry);
      y += 1.5; // gap after section
    }

    function renderEntry(entry) {
      const hasBullets = entry.bullets && entry.bullets.length > 0;
      const hasHeading = entry.title || entry.title_right || entry.tech;
      const inlineSkill =
        entry.text && entry.title && !hasBullets && !entry.subtitle && !entry.subtitle_right;

      // Inline "Label: value" row (Technical Skills).
      if (inlineSkill) {
        writeLabelValue(entry.title, entry.text);
        return;
      }
      // Plain paragraph (Summary).
      if (entry.text && !hasHeading && !hasBullets) {
        writeParagraph(entry.text, 10);
        y += 1.2;
        return;
      }

      // Standard heading block (Experience / Projects / Education).
      if (hasHeading) writeHeadingRow(entry);
      if (entry.subtitle || entry.subtitle_right) writeSubRow(entry);
      if (hasBullets) writeBullets(entry.bullets);
      if (entry.text) writeParagraph(entry.text, 10);
      y += 1.8; // gap between entries
    }

    // Line 1: bold title (+ italic " | tech") left, normal dates right.
    function writeHeadingRow(entry) {
      ensure(5);
      doc.setFontSize(10.5);
      let x = M;
      if (entry.title) {
        doc.setFont(FONT, 'bold');
        doc.text(entry.title, x, y);
        x += doc.getTextWidth(entry.title);
      }
      if (entry.tech) {
        doc.setFont(FONT, 'italic');
        const t = (entry.title ? '  |  ' : '') + entry.tech;
        doc.text(t, x, y);
      }
      if (entry.title_right) {
        doc.setFont(FONT, 'normal');
        doc.text(entry.title_right, pageW - M, y, { align: 'right' });
      }
      y += 4.4;
    }

    // Line 2: italic subtitle left, italic location/dates right.
    function writeSubRow(entry) {
      ensure(5);
      doc.setFont(FONT, 'italic');
      doc.setFontSize(10);
      if (entry.subtitle) doc.text(entry.subtitle, M, y);
      if (entry.subtitle_right) {
        doc.text(entry.subtitle_right, pageW - M, y, { align: 'right' });
      }
      y += 4.3;
    }

    function writeBullets(bullets) {
      doc.setFont(FONT, 'normal');
      doc.setFontSize(10);
      const wrapW = contentW - INDENT;
      for (const b of bullets) {
        const lines = doc.splitTextToSize(b, wrapW);
        lines.forEach((ln, i) => {
          ensure(4.4);
          if (i === 0) doc.text('•', M + 1, y);
          doc.text(ln, M + INDENT, y);
          y += 4.4;
        });
      }
    }

    function writeLabelValue(label, value) {
      doc.setFontSize(10);
      doc.setFont(FONT, 'bold');
      const lead = label + ': ';
      const leadW = doc.getTextWidth(lead);
      doc.setFont(FONT, 'normal');
      const valueLines = doc.splitTextToSize(value, contentW - leadW);
      ensure(4.4);
      doc.setFont(FONT, 'bold');
      doc.text(lead, M, y);
      doc.setFont(FONT, 'normal');
      doc.text(valueLines[0] || '', M + leadW, y);
      y += 4.4;
      for (let i = 1; i < valueLines.length; i++) {
        ensure(4.4);
        doc.text(valueLines[i], M, y);
        y += 4.4;
      }
    }

    function writeParagraph(text, size) {
      doc.setFont(FONT, 'normal');
      doc.setFontSize(size);
      const lines = doc.splitTextToSize(text, contentW);
      lines.forEach((ln) => {
        ensure(4.4);
        doc.text(ln, M, y);
        y += 4.4;
      });
    }

    doc.save(`CV_Tailored_${timestamp()}.pdf`);
  }

  function showDownload() {
    // Progressed past tailoring: swap the Tailor button for Download.
    el.actionFooter.classList.remove('hidden');
    el.tailorBtn.classList.add('hidden');
    el.downloadBtn.classList.remove('hidden');
  }

  // ---------- Reset / new job ----------
  // Clears the match, tailored CV, and job data so the user can analyze a
  // different posting. Keeps the saved CV text and API key.
  async function resetJob() {
    await new Promise((resolve) =>
      chrome.storage.local.remove(
        ['last_analysis', 'last_tailored_cv', 'last_job_description'],
        resolve
      )
    );
    await storageSet({ job_status: 'idle', last_error: '' });

    state.jobDescription = '';
    state.tailoredCv = '';

    el.reportCard.classList.add('hidden');
    el.tailorBtn.classList.add('hidden');
    el.downloadBtn.classList.add('hidden');
    el.actionFooter.classList.add('hidden');
    setAnalyzeLoading(false);
    setTailorLoading(false);
    clearError();

    const app = document.querySelector('.app');
    if (app) app.scrollTop = 0;
  }
  el.resetBtn.addEventListener('click', resetJob);

  // ---------- Single source of truth: react to background result writes ----------
  // The background worker writes terminal results to chrome.storage.local and
  // flips job_status back to 'idle'. Keying off that transition renders each
  // result exactly once, whether this popup initiated the call or was reopened
  // while it was still running.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.last_job_description && changes.last_job_description.newValue) {
      state.jobDescription = changes.last_job_description.newValue;
    }

    const status = changes.job_status;
    if (!status || status.newValue !== 'idle') return;

    const was = status.oldValue; // 'analyzing' | 'tailoring'
    const error = changes.last_error ? changes.last_error.newValue : '';

    if (was === 'analyzing') {
      setAnalyzeLoading(false);
      if (error) showError(describeError(error));
      else if (changes.last_analysis && changes.last_analysis.newValue) {
        renderReport(changes.last_analysis.newValue);
      }
    } else if (was === 'tailoring') {
      setTailorLoading(false);
      if (error) showError(describeError(error));
      else if (changes.last_tailored_cv && changes.last_tailored_cv.newValue) {
        state.tailoredCv = changes.last_tailored_cv.newValue;
        showDownload();
        el.downloadBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  });

  // ---------- Init: restore saved state ----------
  async function init() {
    const data = await storageGet([
      'cv_text',
      'deepseek_api_key',
      'last_analysis',
      'last_tailored_cv',
      'last_job_description',
      'job_status',
      'last_error'
    ]);

    if (data.cv_text) el.cvTextarea.value = data.cv_text;
    if (data.deepseek_api_key) el.apiKeyInput.value = data.deepseek_api_key;
    if (data.last_job_description) state.jobDescription = data.last_job_description;

    // A call may have finished while the popup was closed — re-render cache.
    if (data.last_analysis) renderReport(data.last_analysis);
    if (data.last_tailored_cv) {
      state.tailoredCv = data.last_tailored_cv;
      showDownload();
    }

    // A call may still be in flight — show the right loading state and let the
    // storage.onChanged listener render the result when it lands.
    if (data.job_status === 'analyzing') setAnalyzeLoading(true);
    if (data.job_status === 'tailoring') {
      el.tailorBtn.classList.remove('hidden');
      setTailorLoading(true);
    }
  }

  init();
})();
