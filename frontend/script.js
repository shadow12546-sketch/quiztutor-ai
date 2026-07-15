// =======================================================================
// Local storage helpers — everything here runs in the user's own browser;
// nothing is sent anywhere except to our own backend.
// =======================================================================

const LS_PREFIX = "quiztutor:";

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable (e.g. private browsing) — fail silently
  }
}

function subjectKey(s) {
  return (s || "general knowledge").trim().toLowerCase();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// =======================================================================
// Theme toggle
// =======================================================================

const themeToggleBtn = document.getElementById("theme-toggle");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggleBtn.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
  lsSet("theme", theme);
}

themeToggleBtn.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  applyTheme(isDark ? "light" : "dark");
});

applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

// =======================================================================
// Subject, language, mode switching
// =======================================================================

const subjectInput = document.getElementById("subject-input");
const languageSelect = document.getElementById("language-select");
const recentSubjectsEl = document.getElementById("recent-subjects");
const tutorSubjectEcho = document.getElementById("tutor-subject-echo");
const quizSubjectEcho = document.getElementById("quiz-subject-echo");
const flashcardsSubjectEcho = document.getElementById("flashcards-subject-echo");
const planSubjectEcho = document.getElementById("plan-subject-echo");

const modeButtons = document.querySelectorAll(".mode-btn");
const panels = {
  tutor: document.getElementById("tutor-panel"),
  quiz: document.getElementById("quiz-panel"),
  flashcards: document.getElementById("flashcards-panel"),
  plan: document.getElementById("plan-panel"),
  progress: document.getElementById("progress-panel"),
};

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    modeButtons.forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    Object.values(panels).forEach((p) => p.classList.remove("is-active"));
    panels[btn.dataset.mode].classList.add("is-active");
    if (btn.dataset.mode === "progress") renderProgressDashboard();
  });
});

function currentSubject() {
  return subjectInput.value.trim() || "general knowledge";
}

function currentLanguage() {
  return languageSelect.value || "English";
}

function updateSubjectEchoes() {
  const s = currentSubject().toLowerCase();
  tutorSubjectEcho.textContent = s;
  quizSubjectEcho.textContent = s;
  flashcardsSubjectEcho.textContent = s;
  planSubjectEcho.textContent = s;
}

function pushRecentSubject(s) {
  const trimmed = s.trim();
  if (!trimmed) return;
  let recents = lsGet("recentSubjects", []);
  recents = recents.filter((r) => r.toLowerCase() !== trimmed.toLowerCase());
  recents.unshift(trimmed);
  recents = recents.slice(0, 6);
  lsSet("recentSubjects", recents);
  renderRecentSubjects();
}

function renderRecentSubjects() {
  const recents = lsGet("recentSubjects", []);
  if (!recents.length) {
    recentSubjectsEl.innerHTML = "";
    return;
  }
  recentSubjectsEl.innerHTML = recents
    .map((s) => `<button type="button" class="recent-chip" data-subject="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
    .join("");
  recentSubjectsEl.querySelectorAll(".recent-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      subjectInput.value = chip.dataset.subject;
      updateSubjectEchoes();
      lsSet("lastSubject", subjectInput.value);
      restoreChatForCurrentSubject();
      updateDifficultySuggestion();
    });
  });
}

subjectInput.addEventListener("input", () => {
  updateSubjectEchoes();
  lsSet("lastSubject", subjectInput.value);
});

// Only swap in a different subject's saved chat/difficulty once the person
// finishes editing (blur / Enter), not on every keystroke.
subjectInput.addEventListener("change", () => {
  restoreChatForCurrentSubject();
  updateDifficultySuggestion();
});

languageSelect.addEventListener("change", () => {
  lsSet("language", languageSelect.value);
});

// =======================================================================
// Minimal markdown renderer for tutor replies (bold, italics, headings,
// bullet/numbered lists, paragraphs). Escapes HTML first so nothing from
// the model can inject markup.
// =======================================================================

function renderMarkdown(raw) {
  const escaped = escapeHtml(raw);
  const lines = escaped.split("\n");
  let html = "";
  let inList = null; // "ul" | "ol" | null

  const closeList = () => {
    if (inList) {
      html += inList === "ul" ? "</ul>" : "</ol>";
      inList = null;
    }
  };

  const inline = (text) =>
    text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (heading) {
      closeList();
      html += `<p class="md-heading">${inline(heading[2])}</p>`;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)/);
    if (bullet) {
      if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; }
      html += `<li>${inline(bullet[1])}</li>`;
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (numbered) {
      if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; }
      html += `<li>${inline(numbered[1])}</li>`;
      continue;
    }

    closeList();
    html += `<p>${inline(trimmed)}</p>`;
  }
  closeList();
  return html;
}

// =======================================================================
// Tutor mode — streaming chat over Server-Sent Events
// =======================================================================

const chatLog = document.getElementById("chat-log");
const tutorForm = document.getElementById("tutor-form");
const tutorInput = document.getElementById("tutor-input");
const tutorSend = document.getElementById("tutor-send");
const startLessonBtn = document.getElementById("start-lesson-btn");
const exportChatBtn = document.getElementById("export-chat-btn");
const voiceInputBtn = document.getElementById("voice-input-btn");

let chatHistory = [];

const CHAT_EMPTY_HTML =
  '<div class="chat-empty"><p>Type a subject in the sidebar and click <strong>Start lesson</strong>, or ask a question below to start the conversation.</p></div>';

function clearEmptyState(container) {
  const empty = container.querySelector(".chat-empty");
  if (empty) empty.remove();
}

function appendMessage(role, text, { withActions = false } = {}) {
  clearEmptyState(chatLog);
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "msg-user" : "msg-model"}`;
  if (role === "user") {
    div.textContent = text;
  } else {
    div.innerHTML = renderMarkdown(text);
    if (withActions) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.innerHTML = `
        <button type="button" class="msg-action-btn eli5-btn">💡 Explain simpler</button>
        <button type="button" class="msg-action-btn thumb-btn" data-vote="up">👍</button>
        <button type="button" class="msg-action-btn thumb-btn" data-vote="down">👎</button>
      `;
      div.appendChild(actions);
    }
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function wireMessageActions(div) {
  const eli5Btn = div.querySelector(".eli5-btn");
  if (eli5Btn) {
    eli5Btn.addEventListener("click", () => {
      sendTutorTurn({ question: "Can you explain that more simply, like I'm new to this?" });
    });
  }
  div.querySelectorAll(".thumb-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      div.querySelectorAll(".thumb-btn").forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
    });
  });
}

function restoreChatForCurrentSubject() {
  const key = subjectKey(currentSubject());
  const saved = lsGet("chat:" + key, []);
  chatHistory = [];
  chatLog.innerHTML = "";
  if (saved.length) {
    saved.forEach((m) => {
      const div = appendMessage(m.role === "user" ? "user" : "model", m.text, {
        withActions: m.role !== "user",
      });
      if (m.role !== "user") wireMessageActions(div);
      chatHistory.push(m);
    });
  } else {
    chatLog.innerHTML = CHAT_EMPTY_HTML;
  }
}

tutorInput.addEventListener("input", () => {
  tutorInput.style.height = "auto";
  tutorInput.style.height = Math.min(tutorInput.scrollHeight, 160) + "px";
});

// Enter to send, Shift+Enter for a new line.
tutorInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    tutorForm.requestSubmit();
  }
});

async function sendTutorTurn({ question, lessonMode = false }) {
  if (lessonMode) {
    clearEmptyState(chatLog);
    const introDiv = document.createElement("div");
    introDiv.className = "msg msg-system";
    introDiv.textContent = `Starting a lesson on "${currentSubject()}"...`;
    chatLog.appendChild(introDiv);
  } else {
    appendMessage("user", question);
    chatHistory.push({ role: "user", text: question });
  }

  tutorSend.disabled = true;
  startLessonBtn.disabled = true;

  const modelDiv = appendMessage("model", "");
  modelDiv.classList.add("is-streaming");
  modelDiv.innerHTML = '<span class="msg-thinking">Thinking...</span>';

  let fullText = "";
  let firstTokenSeen = false;

  try {
    const resp = await fetch("/api/tutor/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: currentSubject(),
        history: lessonMode ? [] : chatHistory.slice(0, -1),
        question: lessonMode ? "" : question,
        lesson_mode: lessonMode,
        language: currentLanguage(),
      }),
    });

    if (resp.status === 429) {
      throw new Error("You're sending requests a bit fast — please wait a few seconds and try again.");
    }
    if (!resp.ok || !resp.body) {
      throw new Error(`Server responded with ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop(); // keep incomplete trailing chunk

      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") continue;

        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) {
            fullText += `\n[Error: ${parsed.error}]`;
          } else if (parsed.text) {
            fullText += parsed.text;
          }
          firstTokenSeen = true;
          modelDiv.innerHTML = renderMarkdown(fullText);
          chatLog.scrollTop = chatLog.scrollHeight;
        } catch {
          // ignore malformed chunk
        }
      }
    }
  } catch (err) {
    fullText = fullText || `Something went wrong reaching the tutor: ${err.message}`;
    modelDiv.innerHTML = renderMarkdown(fullText);
  } finally {
    modelDiv.classList.remove("is-streaming");
    if (!firstTokenSeen && !fullText) {
      modelDiv.innerHTML = renderMarkdown("Something went wrong — please try again.");
    }
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML = `
      <button type="button" class="msg-action-btn eli5-btn">💡 Explain simpler</button>
      <button type="button" class="msg-action-btn thumb-btn" data-vote="up">👍</button>
      <button type="button" class="msg-action-btn thumb-btn" data-vote="down">👎</button>
    `;
    modelDiv.appendChild(actions);
    wireMessageActions(modelDiv);

    chatHistory.push({ role: "model", text: fullText });
    lsSet("chat:" + subjectKey(currentSubject()), chatHistory);
    pushRecentSubject(currentSubject());
    tutorSend.disabled = false;
    startLessonBtn.disabled = false;
  }
}

tutorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = tutorInput.value.trim();
  if (!question) return;

  tutorInput.value = "";
  tutorInput.style.height = "auto";

  await sendTutorTurn({ question });
});

startLessonBtn.addEventListener("click", async () => {
  chatHistory = []; // fresh lesson on a (possibly new) subject
  chatLog.innerHTML = "";
  await sendTutorTurn({ lessonMode: true });
});

// ---------------------------------------------------------------------
// Export chat transcript
// ---------------------------------------------------------------------

exportChatBtn.addEventListener("click", () => {
  if (!chatHistory.length) return;
  const lines = [`# Lesson: ${currentSubject()}`, ""];
  chatHistory.forEach((m) => {
    lines.push(m.role === "user" ? `**You:** ${m.text}` : `**Tutor:** ${m.text}`);
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${subjectKey(currentSubject()).replace(/\s+/g, "-")}-lesson.md`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------
// Voice input (Web Speech API — Chrome/Edge support; fails silently
// elsewhere by disabling the mic button)
// ---------------------------------------------------------------------

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionImpl) {
  voiceInputBtn.disabled = true;
  voiceInputBtn.title = "Voice input isn't supported in this browser";
} else {
  const recognition = new SpeechRecognitionImpl();
  recognition.continuous = false;
  recognition.interimResults = false;

  let isRecording = false;

  voiceInputBtn.addEventListener("click", () => {
    if (isRecording) {
      recognition.stop();
      return;
    }
    try {
      recognition.lang =
        { English: "en-US", Spanish: "es-ES", French: "fr-FR", German: "de-DE",
          Hindi: "hi-IN", Portuguese: "pt-PT", Japanese: "ja-JP",
          "Mandarin Chinese": "zh-CN", Arabic: "ar-SA" }[currentLanguage()] || "en-US";
      recognition.start();
    } catch {
      // recognition already started — ignore
    }
  });

  recognition.addEventListener("start", () => {
    isRecording = true;
    voiceInputBtn.classList.add("is-recording");
  });

  recognition.addEventListener("end", () => {
    isRecording = false;
    voiceInputBtn.classList.remove("is-recording");
  });

  recognition.addEventListener("result", (e) => {
    const transcript = e.results[0][0].transcript;
    tutorInput.value = (tutorInput.value ? tutorInput.value + " " : "") + transcript;
    tutorInput.dispatchEvent(new Event("input"));
    tutorInput.focus();
  });

  recognition.addEventListener("error", () => {
    isRecording = false;
    voiceInputBtn.classList.remove("is-recording");
  });
}

// =======================================================================
// Quiz mode
// =======================================================================

const quizForm = document.getElementById("quiz-form");
const quizBody = document.getElementById("quiz-body");
const quizGenerateBtn = document.getElementById("quiz-generate-btn");
const quizDifficultySelect = document.getElementById("quiz-difficulty");
const difficultyHint = document.getElementById("difficulty-hint");

let quizState = null; // { questions, answers: [], current, difficulty, type }

function renderQuizSkeleton() {
  return `
    <div class="skeleton-rail"></div>
    <div class="q-card skeleton-card">
      <div class="skeleton-line skeleton-line-sm"></div>
      <div class="skeleton-line skeleton-line-lg"></div>
      <div class="skeleton-option"></div>
      <div class="skeleton-option"></div>
      <div class="skeleton-option"></div>
      <div class="skeleton-option"></div>
    </div>
  `;
}

quizForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  quizGenerateBtn.disabled = true;
  quizGenerateBtn.textContent = "Generating...";

  quizBody.innerHTML = renderQuizSkeleton();

  const payload = {
    subject: currentSubject(),
    difficulty: quizDifficultySelect.value,
    num_questions: parseInt(document.getElementById("quiz-length").value, 10),
    question_type: document.getElementById("quiz-type").value,
    history: chatHistory, // grounds the quiz in what the tutor actually taught
    language: currentLanguage(),
  };

  try {
    const resp = await fetch("/api/quiz/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.status === 429) {
      throw new Error("Too many requests right now — please wait a moment and try again.");
    }
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.detail || `Server responded with ${resp.status}`);
    }

    const data = await resp.json();
    quizState = {
      title: data.quiz_title || "Quiz",
      questions: data.questions || [],
      answers: new Array((data.questions || []).length).fill(null),
      current: 0,
      difficulty: payload.difficulty,
      type: payload.question_type,
    };
    pushRecentSubject(currentSubject());
    renderQuiz();
  } catch (err) {
    quizBody.innerHTML = `<div class="error-banner">Could not generate the quiz: ${escapeHtml(err.message)}</div>`;
  } finally {
    quizGenerateBtn.disabled = false;
    quizGenerateBtn.textContent = "Generate quiz";
  }
});

function renderRail() {
  const total = quizState.questions.length;
  let html = '<div class="chalk-rail">';
  for (let i = 0; i < total; i++) {
    let cls = "chalk-tick";
    if (quizState.answers[i] !== null) cls += " is-done";
    else if (i === quizState.current) cls += " is-current";
    html += `<div class="${cls}"></div>`;
  }
  html += `<span class="chalk-label">${quizState.answers.filter((a) => a !== null).length}/${total}</span></div>`;
  return html;
}

function renderQuiz() {
  const { questions, current } = quizState;

  if (current >= questions.length) {
    renderScore();
    return;
  }

  const q = questions[current];

  if (quizState.type === "short_answer") {
    quizBody.innerHTML = `
      ${renderRail()}
      <div class="q-card">
        <span class="q-index">Question ${current + 1} of ${questions.length}</span>
        <p class="q-text">${escapeHtml(q.question)}</p>
        <div class="q-short-answer">
          <textarea id="short-answer-input" placeholder="Type your answer..."></textarea>
          <button type="button" id="short-answer-submit" class="btn-send" style="align-self:flex-start;">Submit answer</button>
          <div id="grade-result"></div>
        </div>
      </div>
    `;
    const submitBtn = document.getElementById("short-answer-submit");
    const input = document.getElementById("short-answer-input");
    input.focus();
    submitBtn.addEventListener("click", () => handleShortAnswer(submitBtn, input, q));
    return;
  }

  const isMC = Array.isArray(q.options) && q.options.length > 0;
  const options = isMC ? q.options : ["True", "False"];

  let optionsHtml = "";
  options.forEach((opt, i) => {
    optionsHtml += `<button type="button" class="q-option" data-option="${escapeHtml(opt)}" data-key="${i + 1}"><span class="q-option-key">${i + 1}</span>${escapeHtml(opt)}</button>`;
  });

  quizBody.innerHTML = `
    ${renderRail()}
    <div class="q-card">
      <span class="q-index">Question ${current + 1} of ${questions.length}</span>
      <p class="q-text">${escapeHtml(q.question)}</p>
      <div class="q-options">${optionsHtml}</div>
      <div class="q-explain" id="q-explain" style="display:none;"></div>
    </div>
  `;

  quizBody.querySelectorAll(".q-option").forEach((btn) => {
    btn.addEventListener("click", () => handleAnswer(btn, q));
  });
}

// Number-key shortcuts (1-4) to pick a multiple-choice option while a quiz
// question is showing.
document.addEventListener("keydown", (e) => {
  if (!panels.quiz.classList.contains("is-active") || !quizState) return;
  if (!/^[1-4]$/.test(e.key)) return;
  const btn = quizBody.querySelector(`.q-option[data-key="${e.key}"]`);
  if (btn && !btn.disabled) btn.click();
});

function handleAnswer(btn, question) {
  const chosen = btn.dataset.option;
  const correct = question.answer;
  const isCorrect = chosen.trim().toLowerCase() === String(correct).trim().toLowerCase();

  quizState.answers[quizState.current] = { chosen, correct, isCorrect };

  quizBody.querySelectorAll(".q-option").forEach((b) => {
    b.disabled = true;
    if (b.dataset.option.trim().toLowerCase() === String(correct).trim().toLowerCase()) {
      b.classList.add("is-correct");
    } else if (b === btn) {
      b.classList.add("is-wrong");
    }
  });

  const explainEl = document.getElementById("q-explain");
  if (question.explanation) {
    explainEl.textContent = question.explanation;
    explainEl.style.display = "block";
  }

  quizBody.querySelector(".chalk-rail").outerHTML = renderRail();

  setTimeout(() => {
    quizState.current += 1;
    renderQuiz();
  }, 1600);
}

async function handleShortAnswer(submitBtn, input, question) {
  const userAnswer = input.value.trim();
  if (!userAnswer) return;

  submitBtn.disabled = true;
  input.disabled = true;
  submitBtn.textContent = "Grading...";

  const resultEl = document.getElementById("grade-result");

  try {
    const resp = await fetch("/api/quiz/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: currentSubject(),
        question: question.question,
        reference_answer: question.answer,
        user_answer: userAnswer,
      }),
    });

    if (!resp.ok) throw new Error(`Server responded with ${resp.status}`);
    const grade = await resp.json();

    quizState.answers[quizState.current] = {
      chosen: userAnswer,
      correct: question.answer,
      isCorrect: !!grade.is_correct,
      score: grade.score,
    };

    resultEl.innerHTML = `
      <div class="grade-feedback ${grade.is_correct ? "is-correct" : "is-wrong"}">
        ${escapeHtml(grade.feedback || "")}
        <span class="grade-score">Score: ${grade.score ?? "—"}/100 · Ideal answer: ${escapeHtml(String(question.answer))}</span>
      </div>
    `;
  } catch (err) {
    quizState.answers[quizState.current] = { chosen: userAnswer, correct: question.answer, isCorrect: false };
    resultEl.innerHTML = `<div class="error-banner">Could not grade this answer: ${escapeHtml(err.message)}</div>`;
  } finally {
    submitBtn.textContent = "Submitted";
    setTimeout(() => {
      quizState.current += 1;
      renderQuiz();
    }, 2200);
  }
}

function scoreTier(pct) {
  if (pct === 100) return { label: "Perfect score!", cls: "tier-perfect", note: "You've fully got this topic." };
  if (pct >= 80) return { label: "Excellent work", cls: "tier-great", note: "Just a couple of gaps to polish." };
  if (pct >= 60) return { label: "Good effort", cls: "tier-good", note: "Solid grasp — a bit more review will help." };
  if (pct >= 40) return { label: "Keep practicing", cls: "tier-ok", note: "You're getting there — revisit the tricky parts." };
  return { label: "Let's go over this again", cls: "tier-retry", note: "Worth another pass with the tutor before retrying." };
}

function renderScore() {
  const total = quizState.questions.length;
  const correct = quizState.answers.filter((a) => a && a.isCorrect).length;
  const pct = Math.round((correct / total) * 100);
  const tier = scoreTier(pct);
  const circumference = 2 * Math.PI * 52;
  const offset = circumference * (1 - pct / 100);

  const reviewHtml = quizState.questions
    .map((q, i) => {
      const a = quizState.answers[i];
      const rowCls = a && a.isCorrect ? "is-correct" : "is-wrong";
      return `
        <div class="review-row ${rowCls}">
          <span class="review-icon">${a && a.isCorrect ? "✓" : "✕"}</span>
          <div class="review-text">
            <p class="review-q">${escapeHtml(q.question)}</p>
            ${!(a && a.isCorrect) ? `<p class="review-a">Your answer: ${escapeHtml(a ? a.chosen : "—")} · Correct: ${escapeHtml(String(q.answer))}</p>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  quizBody.innerHTML = `
    <div class="quiz-score ${tier.cls}">
      <div class="score-ring-wrap">
        <svg class="score-ring" viewBox="0 0 120 120">
          <circle class="score-ring-bg" cx="60" cy="60" r="52" />
          <circle class="score-ring-fg" cx="60" cy="60" r="52"
            style="stroke-dasharray:${circumference};stroke-dashoffset:${offset};" />
        </svg>
        <div class="score-ring-label">
          <span class="score-pct">${pct}%</span>
          <span class="score-frac">${correct}/${total}</span>
        </div>
      </div>
      <p class="score-tier-label">${tier.label}</p>
      <p class="score-tier-note">${tier.note}</p>
      <p class="score-quiz-title">"${escapeHtml(quizState.title)}"</p>
      <div class="score-actions">
        <button type="button" class="btn-send" id="retake-quiz-btn">Retake quiz</button>
        <button type="button" class="btn-ghost" id="print-results-btn">🖨 Save / print results</button>
      </div>
    </div>
    <div class="score-review">${reviewHtml}</div>
  `;

  document.getElementById("retake-quiz-btn").addEventListener("click", () => {
    quizForm.requestSubmit();
  });
  document.getElementById("print-results-btn").addEventListener("click", () => {
    window.print();
  });

  saveScoreRecord(pct, correct, total, quizState.difficulty);
  updateDifficultySuggestion();
}

// ---------------------------------------------------------------------
// Adaptive difficulty — suggests a difficulty level per subject based on
// how the last quiz on that topic went.
// ---------------------------------------------------------------------

const DIFFICULTY_ORDER = ["easy", "medium", "hard"];

function saveScoreRecord(pct, correct, total, difficulty) {
  const key = subjectKey(currentSubject());
  const scores = lsGet("scores", []);
  scores.push({ subjectKey: key, difficulty, pct, correct, total, ts: Date.now() });
  lsSet("scores", scores.slice(-300)); // cap stored history
}

function updateDifficultySuggestion() {
  const key = subjectKey(currentSubject());
  const scores = lsGet("scores", []);
  const relevant = scores.filter((s) => s.subjectKey === key);

  if (!relevant.length) {
    difficultyHint.textContent = "";
    return;
  }

  const last = relevant[relevant.length - 1];
  let idx = DIFFICULTY_ORDER.indexOf(last.difficulty);
  if (idx === -1) idx = 1;

  let suggestedIdx = idx;
  if (last.pct >= 80) suggestedIdx = Math.min(idx + 1, DIFFICULTY_ORDER.length - 1);
  else if (last.pct < 40) suggestedIdx = Math.max(idx - 1, 0);

  const suggested = DIFFICULTY_ORDER[suggestedIdx];
  quizDifficultySelect.value = suggested;

  difficultyHint.textContent =
    suggested !== last.difficulty
      ? `Adjusted to ${suggested} based on your last score on this topic (${last.pct}%).`
      : `Matched to your last score on this topic (${last.pct}%).`;
}

// =======================================================================
// Flashcards mode
// =======================================================================

const flashcardsForm = document.getElementById("flashcards-form");
const flashcardsBody = document.getElementById("flashcards-body");
const flashcardsGenerateBtn = document.getElementById("flashcards-generate-btn");

let flashcardState = null; // { title, cards, index }

flashcardsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  flashcardsGenerateBtn.disabled = true;
  flashcardsGenerateBtn.textContent = "Generating...";
  flashcardsBody.innerHTML = renderQuizSkeleton();

  try {
    const resp = await fetch("/api/flashcards/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: currentSubject(),
        count: parseInt(document.getElementById("flashcards-count").value, 10),
        history: chatHistory,
        language: currentLanguage(),
      }),
    });

    if (resp.status === 429) throw new Error("Too many requests — please wait a moment.");
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.detail || `Server responded with ${resp.status}`);
    }

    const data = await resp.json();
    flashcardState = {
      title: data.deck_title || "Flashcards",
      cards: data.flashcards || [],
      index: 0,
    };
    pushRecentSubject(currentSubject());
    renderFlashcard();
  } catch (err) {
    flashcardsBody.innerHTML = `<div class="error-banner">Could not generate flashcards: ${escapeHtml(err.message)}</div>`;
  } finally {
    flashcardsGenerateBtn.disabled = false;
    flashcardsGenerateBtn.textContent = "Generate flashcards";
  }
});

function renderFlashcard() {
  const { cards, index, title } = flashcardState;
  if (!cards.length) {
    flashcardsBody.innerHTML = `<div class="error-banner">No flashcards were generated — try again.</div>`;
    return;
  }
  const card = cards[index];

  flashcardsBody.innerHTML = `
    <p class="flashcard-deck-title">${escapeHtml(title)}</p>
    <div class="flashcard-wrap">
      <div class="flashcard" id="flashcard-el">
        <div class="flashcard-face flashcard-face-front">${escapeHtml(card.term)}</div>
        <div class="flashcard-face flashcard-face-back">${escapeHtml(card.definition)}</div>
      </div>
    </div>
    <p class="flashcard-hint">Click the card to flip it</p>
    <div class="flashcard-nav">
      <button type="button" id="flashcard-prev" ${index === 0 ? "disabled" : ""}>← Prev</button>
      <span class="flashcard-counter">${index + 1} / ${cards.length}</span>
      <button type="button" id="flashcard-next" ${index === cards.length - 1 ? "disabled" : ""}>Next →</button>
    </div>
  `;

  const cardEl = document.getElementById("flashcard-el");
  cardEl.addEventListener("click", () => cardEl.classList.toggle("is-flipped"));

  document.getElementById("flashcard-prev").addEventListener("click", () => {
    flashcardState.index = Math.max(0, flashcardState.index - 1);
    renderFlashcard();
  });
  document.getElementById("flashcard-next").addEventListener("click", () => {
    flashcardState.index = Math.min(cards.length - 1, flashcardState.index + 1);
    renderFlashcard();
  });
}

// =======================================================================
// Study plan mode
// =======================================================================

const planForm = document.getElementById("plan-form");
const planBody = document.getElementById("plan-body");
const planGenerateBtn = document.getElementById("plan-generate-btn");

planForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  planGenerateBtn.disabled = true;
  planGenerateBtn.textContent = "Generating...";
  planBody.innerHTML = renderQuizSkeleton();

  try {
    const resp = await fetch("/api/plan/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: currentSubject(),
        days: parseInt(document.getElementById("plan-days").value, 10),
        hours_per_day: parseFloat(document.getElementById("plan-hours").value),
        language: currentLanguage(),
      }),
    });

    if (resp.status === 429) throw new Error("Too many requests — please wait a moment.");
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.detail || `Server responded with ${resp.status}`);
    }

    const data = await resp.json();
    pushRecentSubject(currentSubject());
    renderPlan(data);
  } catch (err) {
    planBody.innerHTML = `<div class="error-banner">Could not generate a study plan: ${escapeHtml(err.message)}</div>`;
  } finally {
    planGenerateBtn.disabled = false;
    planGenerateBtn.textContent = "Generate plan";
  }
});

function renderPlan(data) {
  const days = data.days || [];
  if (!days.length) {
    planBody.innerHTML = `<div class="error-banner">No plan was generated — try again.</div>`;
    return;
  }
  const daysHtml = days
    .map(
      (d) => `
      <div class="plan-day">
        <div class="plan-day-num">D${d.day}</div>
        <div>
          <p class="plan-day-focus">${escapeHtml(d.focus || "")}</p>
          <ul class="plan-day-tasks">
            ${(d.tasks || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("")}
          </ul>
        </div>
      </div>
    `
    )
    .join("");

  planBody.innerHTML = `
    <p class="plan-title">${escapeHtml(data.plan_title || "Study plan")}</p>
    ${daysHtml}
  `;
}

// =======================================================================
// Progress dashboard
// =======================================================================

const progressBody = document.getElementById("progress-body");

function renderProgressDashboard() {
  const scores = lsGet("scores", []);
  if (!scores.length) {
    progressBody.innerHTML = `<div class="progress-empty"><p>No quizzes taken yet — generate one from the Quiz Me tab and your results will show up here.</p></div>`;
    return;
  }

  const totalQuizzes = scores.length;
  const avgPct = Math.round(scores.reduce((sum, s) => sum + s.pct, 0) / totalQuizzes);
  const subjects = [...new Set(scores.map((s) => s.subjectKey))];

  const bySubject = subjects.map((key) => {
    const rows = scores.filter((s) => s.subjectKey === key);
    const best = Math.max(...rows.map((r) => r.pct));
    const avg = Math.round(rows.reduce((sum, r) => sum + r.pct, 0) / rows.length);
    const last = rows[rows.length - 1];
    return { key, count: rows.length, best, avg, lastPct: last.pct, lastDate: new Date(last.ts) };
  });

  bySubject.sort((a, b) => b.lastDate - a.lastDate);

  const rowsHtml = bySubject
    .map(
      (s) => `
      <div class="progress-row">
        <div class="progress-row-top">
          <span class="progress-subject">${escapeHtml(s.key)}</span>
          <span class="progress-meta">${s.count} quiz${s.count > 1 ? "zes" : ""} · best ${s.best}% · avg ${s.avg}%</span>
        </div>
        <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${s.lastPct}%"></div></div>
      </div>
    `
    )
    .join("");

  progressBody.innerHTML = `
    <div class="progress-summary">
      <div class="progress-stat"><div class="progress-stat-value">${totalQuizzes}</div><div class="progress-stat-label">Quizzes taken</div></div>
      <div class="progress-stat"><div class="progress-stat-value">${subjects.length}</div><div class="progress-stat-label">Subjects studied</div></div>
      <div class="progress-stat"><div class="progress-stat-value">${avgPct}%</div><div class="progress-stat-label">Average score</div></div>
    </div>
    ${rowsHtml}
  `;
}

// =======================================================================
// Clear saved history
// =======================================================================

const clearHistoryBtn = document.getElementById("clear-history-btn");

clearHistoryBtn.addEventListener("click", () => {
  if (!confirm("Clear saved chat history, quiz scores, and preferences from this browser?")) return;
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(LS_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
  chatHistory = [];
  chatLog.innerHTML = CHAT_EMPTY_HTML;
  difficultyHint.textContent = "";
  quizBody.innerHTML = '<div class="chat-empty"><p>Set your options above and generate a quiz to begin.</p></div>';
  recentSubjectsEl.innerHTML = "";
  renderProgressDashboard();
});

// =======================================================================
// Initial load
// =======================================================================

(function init() {
  const savedSubject = lsGet("lastSubject", "");
  if (savedSubject) subjectInput.value = savedSubject;

  const savedLanguage = lsGet("language", "");
  if (savedLanguage) languageSelect.value = savedLanguage;

  updateSubjectEchoes();
  restoreChatForCurrentSubject();
  updateDifficultySuggestion();
  renderRecentSubjects();
})();
