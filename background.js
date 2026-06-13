/* xHunter — background service worker
 * Owns all DeepSeek API calls so they survive the popup closing.
 * Results are cached in chrome.storage.local and re-rendered when the popup reopens.
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';

const STAGE1_SYSTEM = `You are an expert career coach and CV analyst. Analyze how well a candidate's CV matches a job description.

Return ONLY a JSON object in this exact format, nothing else:
{
  "match_score": 72,
  "summary": "Strong backend match but missing key DevOps and cloud experience the role requires.",
  "matches": [
    "5+ years Node.js experience",
    "REST API design",
    "MySQL database management"
  ],
  "mismatches": [
    "No AWS/cloud certifications mentioned",
    "Missing Kubernetes experience",
    "No mention of CI/CD pipelines"
  ],
  "keywords_to_add": ["Kubernetes", "AWS Lambda", "CI/CD", "Terraform"]
}`;

const STAGE2_SYSTEM = `You are an expert CV writer and career coach. Tailor the candidate's CV to the job posting and return it as STRUCTURED JSON ONLY — no markdown, no commentary, no preamble.

Rules:
- Keep all facts, dates, companies, titles, and achievements 100% accurate — never invent or exaggerate.
- Reorder and reword bullet points to match the job's language and priorities; mirror keywords from the job description naturally.
- Strengthen weak bullets; each bullet starts with a strong action verb and is one concise line (no trailing period).
- Preserve the candidate's real section set and roles. Do NOT add roles, projects, or education that are not in the CV. Always include a tailored SUMMARY section.
- Use the candidate's real contact details from the CV.

Return ONLY this JSON shape (omit fields that don't apply; omit a whole section if the CV has no such content):
{
  "name": "Full Name",
  "contact": ["City, Country", "+1 555 555 5555", "email@example.com", "linkedin.com/in/handle", "github.com/handle"],
  "sections": [
    {
      "title": "SUMMARY",
      "entries": [ { "text": "2-3 sentence professional summary tailored to the role." } ]
    },
    {
      "title": "EXPERIENCE",
      "entries": [
        {
          "title": "Job Title",
          "title_right": "Mon YYYY -- Mon YYYY",
          "subtitle": "Company Name",
          "subtitle_right": "City, Country",
          "bullets": ["Achievement bullet 1", "Achievement bullet 2"]
        }
      ]
    },
    {
      "title": "PROJECTS",
      "entries": [
        {
          "title": "Project Name",
          "tech": "Python, Flask, React",
          "title_right": "Mon YYYY -- Mon YYYY",
          "bullets": ["What you built and the impact"]
        }
      ]
    },
    {
      "title": "EDUCATION",
      "entries": [
        {
          "title": "University Name",
          "title_right": "City, Country",
          "subtitle": "Degree, Field of Study",
          "subtitle_right": "Mon YYYY -- Mon YYYY"
        }
      ]
    },
    {
      "title": "TECHNICAL SKILLS",
      "entries": [
        { "title": "Languages", "text": "Java, Python, SQL, JavaScript" },
        { "title": "Frameworks", "text": "React, Node.js, Flask" }
      ]
    }
  ]
}`;

const STAGE3_SYSTEM = `You are an expert career coach and cover-letter writer. Write a tailored, professional cover letter for the candidate based on their CV and the job description. Return it as STRUCTURED JSON ONLY — no markdown, no commentary, no preamble.

Rules:
- Ground every claim in the candidate's real CV — never invent experience, employers, skills, or metrics.
- Address the specific role and company; mirror the job's key requirements and language naturally.
- Provide 3 to 4 body paragraphs: open by naming the role and why you're a strong fit; use the middle paragraph(s) to back each claim with concrete evidence from the CV; make the LAST paragraph a brief, confident thank-you and call to action. Professional but warm — no clichés, no filler, no repeating the CV verbatim. Keep it to one page.
- Split the candidate's real name into first_name and last_name (natural order — first name first).
- contact: an ordered list of the candidate's own contact details from the CV for the header line (e.g. city, email, phone, linkedin, github). Include only what the CV actually contains.
- company: the hiring company's name from the job description if stated, otherwise "".
- company_address: any company location/address lines given in the job description (e.g. ["City, State"]); otherwise []. Do NOT invent an address.
- greeting: address a named contact if the job description gives one, otherwise "Dear Hiring Manager,".
- NEVER fabricate facts you don't have — use "" or [] for anything missing.

Return ONLY this JSON shape (use "" / [] for anything you don't have — never fabricate):
{
  "first_name": "Jane",
  "last_name": "Smith",
  "contact": ["City, Country", "jane@example.com", "+1 555 555 5555", "linkedin.com/in/jane", "github.com/jane"],
  "company": "Acme Corp",
  "company_address": ["City, State"],
  "greeting": "Dear Hiring Manager,",
  "paragraphs": [
    "Opening paragraph naming the role and a compelling reason you're a strong fit.",
    "Body paragraph backing your claims with concrete evidence from your experience.",
    "Brief closing paragraph thanking them for their consideration and inviting a conversation."
  ],
  "signoff": "Sincerely,"
}`;

function buildUserMessage(jobDescription, cvText, instruction) {
  return `JOB DESCRIPTION:\n${jobDescription}\n\nMY CV:\n${cvText}\n\n${instruction}`;
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function callDeepSeek(apiKey, body) {
  let res;
  try {
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error(`Network error: ${e && e.message ? e.message : e}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch (e) {
      try {
        detail = await res.text();
      } catch (_) {
        detail = '';
      }
    }
    throw new Error(`DeepSeek API error ${res.status}: ${detail || res.statusText}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('DeepSeek returned an unexpected response shape.');
  }
  return content;
}

// Strip ```json fences / stray prose, then JSON.parse. Throws 'PARSE' on failure.
function parseJSONLoose(raw) {
  let text = String(raw).trim();

  // Remove ```json ... ``` or ``` ... ``` fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    // Last resort: grab the outermost { ... } block.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new Error('PARSE');
  }
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(asString).filter((v) => v.length > 0);
}

function normalizeAnalysis(obj) {
  let score = Number(obj && obj.match_score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    match_score: score,
    summary: asString(obj && obj.summary),
    matches: asStringArray(obj && obj.matches),
    mismatches: asStringArray(obj && obj.mismatches),
    keywords_to_add: asStringArray(obj && obj.keywords_to_add)
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = {
    title: asString(entry.title),
    title_right: asString(entry.title_right),
    subtitle: asString(entry.subtitle),
    subtitle_right: asString(entry.subtitle_right),
    tech: asString(entry.tech),
    text: asString(entry.text),
    bullets: asStringArray(entry.bullets)
  };
  const empty =
    !out.title &&
    !out.title_right &&
    !out.subtitle &&
    !out.subtitle_right &&
    !out.tech &&
    !out.text &&
    out.bullets.length === 0;
  return empty ? null : out;
}

function normalizeResume(obj) {
  const sections = Array.isArray(obj && obj.sections) ? obj.sections : [];
  const normSections = sections
    .map((s) => {
      const entries = Array.isArray(s && s.entries)
        ? s.entries.map(normalizeEntry).filter(Boolean)
        : [];
      const title = asString(s && s.title);
      if (!title && entries.length === 0) return null;
      return { title, entries };
    })
    .filter(Boolean);

  return {
    name: asString(obj && obj.name),
    contact: asStringArray(obj && obj.contact),
    sections: normSections
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeCoverLetter(obj) {
  const o = asObject(obj);
  return {
    first_name: asString(o.first_name),
    last_name: asString(o.last_name),
    name: asString(o.name), // fallback when first/last aren't split out
    contact: asStringArray(o.contact),
    company: asString(o.company),
    company_address: asStringArray(o.company_address),
    greeting: asString(o.greeting),
    paragraphs: asStringArray(o.paragraphs),
    signoff: asString(o.signoff) || 'Sincerely,'
  };
}

// HTTP header values must be ISO-8859-1; DeepSeek keys are plain ASCII. Strip
// any other characters (zero-width spaces, curly quotes, BOM, stray unicode
// from copy-paste) that would otherwise crash fetch() when building the header.
function sanitizeApiKey(key) {
  return String(key || '').replace(/[^\x21-\x7E]/g, '');
}

async function getApiKey() {
  const { deepseek_api_key } = await storageGet(['deepseek_api_key']);
  return sanitizeApiKey(deepseek_api_key);
}

// The popup observes results via chrome.storage.onChanged (single source of
// truth), so every terminal path here writes job_status:'idle' plus the result
// or error. The returned payload is a convenience for the awaiting caller.
async function handleAnalyze({ cv, jd }) {
  // Mark in-flight first so the analyzing→idle transition always fires for the
  // popup's storage listener, even on the early NO_KEY exit.
  await storageSet({ job_status: 'analyzing', last_error: '', last_job_description: jd });

  const apiKey = await getApiKey();
  if (!apiKey) {
    await storageSet({ job_status: 'idle', last_error: 'NO_KEY' });
    return { ok: false, error: 'NO_KEY' };
  }

  try {
    const content = await callDeepSeek(apiKey, {
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE1_SYSTEM },
        {
          role: 'user',
          content: buildUserMessage(jd, cv, 'Analyze how well my CV matches this job.')
        }
      ]
    });

    let analysis;
    try {
      analysis = normalizeAnalysis(parseJSONLoose(content));
    } catch (e) {
      await storageSet({ job_status: 'idle', last_error: 'PARSE' });
      return { ok: false, error: 'PARSE' };
    }

    await storageSet({ job_status: 'idle', last_analysis: analysis, last_error: '' });
    return { ok: true, analysis };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    await storageSet({ job_status: 'idle', last_error: error });
    return { ok: false, error };
  }
}

async function handleTailor({ cv, jd }) {
  await storageSet({ job_status: 'tailoring', last_error: '' });

  const apiKey = await getApiKey();
  if (!apiKey) {
    await storageSet({ job_status: 'idle', last_error: 'NO_KEY' });
    return { ok: false, error: 'NO_KEY' };
  }

  try {
    const content = await callDeepSeek(apiKey, {
      model: MODEL,
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE2_SYSTEM },
        {
          role: 'user',
          content: buildUserMessage(jd, cv, 'Please tailor my CV for this job.')
        }
      ]
    });

    let resume;
    try {
      resume = normalizeResume(parseJSONLoose(content));
      if (!resume.sections.length) throw new Error('empty');
    } catch (e) {
      await storageSet({ job_status: 'idle', last_error: 'PARSE_CV' });
      return { ok: false, error: 'PARSE_CV' };
    }

    await storageSet({ job_status: 'idle', last_tailored_cv: resume, last_error: '' });
    return { ok: true, tailored: resume };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    await storageSet({ job_status: 'idle', last_error: error });
    return { ok: false, error };
  }
}

async function handleCoverLetter({ cv, jd }) {
  await storageSet({ job_status: 'cover_lettering', last_error: '' });

  const apiKey = await getApiKey();
  if (!apiKey) {
    await storageSet({ job_status: 'idle', last_error: 'NO_KEY' });
    return { ok: false, error: 'NO_KEY' };
  }

  try {
    const content = await callDeepSeek(apiKey, {
      model: MODEL,
      // A touch warmer than analysis/tailoring for a natural letter voice,
      // still low enough to keep it grounded in the CV.
      temperature: 0.5,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE3_SYSTEM },
        {
          role: 'user',
          content: buildUserMessage(jd, cv, 'Please write a tailored cover letter for this job.')
        }
      ]
    });

    let letter;
    try {
      letter = normalizeCoverLetter(parseJSONLoose(content));
      if (!letter.paragraphs.length) throw new Error('empty');
    } catch (e) {
      await storageSet({ job_status: 'idle', last_error: 'PARSE_LETTER' });
      return { ok: false, error: 'PARSE_LETTER' };
    }

    await storageSet({ job_status: 'idle', last_cover_letter: letter, last_error: '' });
    return { ok: true, cover_letter: letter };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    await storageSet({ job_status: 'idle', last_error: error });
    return { ok: false, error };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'ANALYZE') {
    handleAnalyze(message).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'TAILOR') {
    handleTailor(message).then(sendResponse);
    return true; // async response
  }

  if (message.type === 'COVER_LETTER') {
    handleCoverLetter(message).then(sendResponse);
    return true; // async response
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // Ensure a clean status flag on install/update.
  chrome.storage.local.set({ job_status: 'idle' });
});
