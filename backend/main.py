"""
QuizTutor AI — FastAPI backend
--------------------------------
Serves the frontend, and exposes several routes that talk to Google's
Gemini API:

  POST /api/tutor/stream        -> Server-Sent Events, progressive tutor answer
  POST /api/quiz/generate       -> JSON quiz (multiple_choice / true_false / short_answer)
  POST /api/quiz/grade          -> Grades a free-text short-answer quiz response
  POST /api/flashcards/generate -> JSON flashcard deck for a subject
  POST /api/plan/generate       -> JSON multi-day study plan

The Gemini API key never touches the browser. It lives only in the
backend process, read from an environment variable.
"""

import asyncio
import json
import os
import time
from collections import defaultdict, deque
from typing import List, Optional

from dotenv import load_dotenv

load_dotenv()  # loads backend/.env for local development; no-op in prod
                # where real env vars are injected by the container platform

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


# Comma-separated list of allowed origins for production, e.g.
# "https://xxxx.us-east-1.awsapprunner.com". Defaults to "*" for local dev,
# since frontend + API share an origin. Tighten this before/at deployment.
_allowed_origins_raw = os.environ.get("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS = (
    ["*"] if _allowed_origins_raw.strip() == "*"
    else [o.strip() for o in _allowed_origins_raw.split(",") if o.strip()]
)

# Simple per-IP rate limit for the /api/* routes, to protect the Gemini
# quota behind a public URL. In-memory only — resets on restart and isn't
# shared across multiple container instances, which is fine for a
# single-instance course project but not a production guarantee.
RATE_LIMIT_PER_MINUTE = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "30"))

if not GEMINI_API_KEY:
    # We don't crash on import (so the container can still boot and show a
    # clear error in the UI / logs), but every real request will fail fast.
    print("WARNING: GEMINI_API_KEY is not set. Set it as an environment "
          "variable before making requests.")

app = FastAPI(title="QuizTutor AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

_request_log: dict = defaultdict(deque)


@app.middleware("http")
async def rate_limiter(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        ip = request.client.host if request.client else "unknown"
        now = time.time()
        window = _request_log[ip]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= RATE_LIMIT_PER_MINUTE:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests — please slow down and try again shortly."},
            )
        window.append(now)
    return await call_next(request)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class TutorMessage(BaseModel):
    role: str  # "user" | "model"
    text: str


class TutorRequest(BaseModel):
    subject: str = Field(..., description="Topic the learner wants help with")
    history: List[TutorMessage] = Field(default_factory=list)
    question: str
    lesson_mode: bool = Field(
        default=False,
        description="True for the auto-generated kickoff message that starts "
                    "a structured lesson, rather than a learner-typed question.",
    )
    language: str = Field(default="English")


class QuizRequest(BaseModel):
    subject: str
    difficulty: str = "medium"        # easy | medium | hard
    num_questions: int = 5
    question_type: str = "multiple_choice"  # multiple_choice | true_false | short_answer
    history: List[TutorMessage] = Field(
        default_factory=list,
        description="Recent tutor chat turns, so the quiz can be grounded "
                    "in what was actually taught rather than the subject in "
                    "general.",
    )
    language: str = Field(default="English")


class GradeRequest(BaseModel):
    subject: str
    question: str
    reference_answer: str
    user_answer: str


class FlashcardRequest(BaseModel):
    subject: str
    count: int = 10
    history: List[TutorMessage] = Field(default_factory=list)
    language: str = Field(default="English")


class StudyPlanRequest(BaseModel):
    subject: str
    days: int = 7
    hours_per_day: float = 1.0
    language: str = Field(default="English")


# ---------------------------------------------------------------------------
# Shared Gemini helpers
# ---------------------------------------------------------------------------

def require_api_key():
    if not GEMINI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Server is missing GEMINI_API_KEY. Set it as an "
                   "environment variable and restart the server.",
        )


def recent_lesson_context(history: List[TutorMessage], max_turns: int = 6) -> str:
    """Summarizes recent tutor-side chat turns for grounding quizzes,
    flashcards, etc. in what was actually taught."""
    taught_turns = [m for m in history[-16:] if m.role != "user"]
    if not taught_turns:
        return ""
    excerpt = "\n\n".join(m.text[:800] for m in taught_turns[-max_turns:])
    return (
        "Here is what was actually covered in the tutoring session so far:\n"
        f"\"\"\"\n{excerpt}\n\"\"\"\n"
        "Base your output primarily on these specific points, not just the "
        "subject in general. "
    )


async def call_gemini_generate(payload: dict) -> dict:
    """POST to Gemini's generateContent endpoint with retry-on-503, and
    return the parsed JSON envelope."""
    url = f"{GEMINI_BASE_URL}/{GEMINI_MODEL}:generateContent"
    max_attempts = 3
    resp = None
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(1, max_attempts + 1):
            resp = await client.post(
                url,
                params={"key": GEMINI_API_KEY},
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code == 503 and attempt < max_attempts:
                await asyncio.sleep(1.5 * attempt)
                continue
            break

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Gemini API error: {resp.text}")
    return resp.json()


def extract_json_text(data: dict) -> dict:
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except (KeyError, IndexError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not parse JSON from model response: {exc}",
        )


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def build_tutor_prompt(req: TutorRequest) -> dict:
    """Builds the Gemini `contents` payload for a tutoring turn."""
    system_instruction = {
        "parts": [{
            "text": (
                "You are an experienced, encouraging human teacher running a "
                f"one-on-one lesson. The learner is studying: {req.subject}. "
                f"Respond in {req.language}. "
                "Teach the way a good teacher does, not the way a search "
                "engine or a chatbot does:\n"
                "- Start from where the learner is. If this is the first "
                "message of the lesson, open with a short, friendly "
                "introduction to the topic before diving into detail.\n"
                "- Break the topic into digestible pieces rather than "
                "dumping everything at once. Cover one idea per response, "
                "then build on it in the next.\n"
                "- Use concrete examples and analogies suited to a beginner "
                "unless the learner's questions show they're more advanced.\n"
                "- Format your answers with markdown: short paragraphs, "
                "**bold** for key terms, and bullet or numbered lists when "
                "listing steps or examples.\n"
                "- End most responses with one short question that checks "
                "understanding or invites the learner to go deeper, the way "
                "a teacher would pause to ask 'does that make sense?' or "
                "'want to try an example?'. Skip this if the learner asked a "
                "quick factual question that doesn't call for it.\n"
                "- If asked something outside the subject, gently redirect "
                "back to the lesson.\n"
                "- Keep responses focused; avoid unnecessary length."
            )
        }]
    }

    contents = []
    for msg in req.history[-12:]:  # cap history to keep requests small
        role = "user" if msg.role == "user" else "model"
        contents.append({"role": role, "parts": [{"text": msg.text}]})

    question = req.question
    if req.lesson_mode:
        question = (
            f"Start teaching me about {req.subject} from the basics, as if "
            "this were the first few minutes of a real lesson. Give a brief, "
            "welcoming introduction to the topic, outline the 2-3 key ideas "
            "we'll cover, then begin explaining the first one."
        )

    contents.append({"role": "user", "parts": [{"text": question}]})

    return {
        "system_instruction": system_instruction,
        "contents": contents,
        "generationConfig": {"temperature": 0.6},
    }


def build_quiz_prompt(req: QuizRequest) -> dict:
    """Builds the Gemini `contents` payload for quiz generation.

    We ask the model to return *only* JSON so the backend can parse it
    reliably and hand the frontend clean structured data. If chat history
    from a tutoring session is provided, the quiz is grounded in the
    specific ideas that were actually discussed rather than the subject
    in the abstract.
    """
    schema_hint = (
        '{"quiz_title": string, "questions": [ '
        '{"question": string, "options": [string, ...] (omit for true_false '
        'and short_answer), "answer": string, "explanation": string} ] }'
    )

    num_questions = max(1, min(req.num_questions, 20))
    lesson_context = recent_lesson_context(req.history)

    type_instructions = {
        "multiple_choice": (
            "For each question, include exactly 4 options and set 'answer' "
            "to the exact matching option text."
        ),
        "true_false": (
            "Options may be omitted; 'answer' must be exactly 'True' or 'False'."
        ),
        "short_answer": (
            "Omit 'options'. 'answer' should be a concise ideal answer "
            "(1 sentence) that a grader can compare a learner's free-text "
            "response against."
        ),
    }
    type_instruction = type_instructions.get(req.question_type, type_instructions["multiple_choice"])

    instruction = (
        f"Create a {req.difficulty} difficulty quiz on the subject: "
        f"{req.subject}. {lesson_context}"
        f"Question type: {req.question_type}. {type_instruction} "
        f"Respond in {req.language} (including question text and options). "
        f"Generate exactly {num_questions} questions. "
        "Return ONLY valid JSON, no markdown fences, no commentary, "
        f"matching this shape exactly: {schema_hint}. "
        "Keep explanations to 1-2 sentences."
    )

    return {
        "contents": [{"role": "user", "parts": [{"text": instruction}]}],
        "generationConfig": {
            "temperature": 0.7,
            "responseMimeType": "application/json",
        },
    }


def build_grade_prompt(req: GradeRequest) -> dict:
    schema_hint = '{"is_correct": boolean, "score": number (0-100), "feedback": string}'
    instruction = (
        f"Subject: {req.subject}. Question: \"{req.question}\". "
        f"Reference/ideal answer: \"{req.reference_answer}\". "
        f"Learner's answer: \"{req.user_answer}\". "
        "Grade the learner's answer for correctness and understanding, not "
        "just exact wording — give credit for answers that show correct "
        "reasoning even if phrased differently or incomplete but on the "
        "right track (partial credit allowed via the score field). "
        f"Return ONLY valid JSON matching this shape exactly: {schema_hint}. "
        "Keep feedback to 1-2 short, encouraging but honest sentences, "
        "written directly to the learner ('You correctly identified...')."
    )
    return {
        "contents": [{"role": "user", "parts": [{"text": instruction}]}],
        "generationConfig": {
            "temperature": 0.3,
            "responseMimeType": "application/json",
        },
    }


def build_flashcard_prompt(req: FlashcardRequest) -> dict:
    schema_hint = '{"deck_title": string, "flashcards": [{"term": string, "definition": string}]}'
    count = max(4, min(req.count, 20))
    lesson_context = recent_lesson_context(req.history)

    instruction = (
        f"Create {count} flashcards for studying: {req.subject}. "
        f"{lesson_context}"
        f"Respond in {req.language}. "
        "Each flashcard's 'term' should be a short key concept, vocabulary "
        "word, or question (a few words). Each 'definition' should be a "
        "concise, clear explanation (1-2 sentences) suitable for active "
        "recall practice. Cover a range of the important ideas, not just "
        "one narrow slice. "
        f"Return ONLY valid JSON, no commentary, matching this shape "
        f"exactly: {schema_hint}"
    )
    return {
        "contents": [{"role": "user", "parts": [{"text": instruction}]}],
        "generationConfig": {
            "temperature": 0.6,
            "responseMimeType": "application/json",
        },
    }


def build_plan_prompt(req: StudyPlanRequest) -> dict:
    schema_hint = (
        '{"plan_title": string, "days": [ '
        '{"day": number, "focus": string, "tasks": [string, ...]} ] }'
    )
    days = max(1, min(req.days, 30))
    hours = max(0.25, min(req.hours_per_day, 12))

    instruction = (
        f"Create a {days}-day study plan for learning: {req.subject}. "
        f"Respond in {req.language}. Assume roughly {hours} focused hours "
        "available per day. Each day should build logically on the "
        "previous one — start with fundamentals and progress toward more "
        "advanced or applied material. For each day, give a short 'focus' "
        "label and 2-4 concrete 'tasks' (e.g. 'Read about X', 'Practice 5 "
        "problems on Y', 'Take a short self-quiz on Z'). "
        f"Return ONLY valid JSON, no commentary, matching this shape "
        f"exactly: {schema_hint}"
    )
    return {
        "contents": [{"role": "user", "parts": [{"text": instruction}]}],
        "generationConfig": {
            "temperature": 0.6,
            "responseMimeType": "application/json",
        },
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"status": "ok", "model": GEMINI_MODEL, "key_configured": bool(GEMINI_API_KEY)}


@app.post("/api/tutor/stream")
async def tutor_stream(req: TutorRequest):
    require_api_key()
    payload = build_tutor_prompt(req)
    url = f"{GEMINI_BASE_URL}/{GEMINI_MODEL}:streamGenerateContent"

    async def event_generator():
        max_attempts = 3
        async with httpx.AsyncClient(timeout=60) as client:
            try:
                for attempt in range(1, max_attempts + 1):
                    started_streaming = False
                    try:
                        async with client.stream(
                            "POST",
                            url,
                            params={"alt": "sse", "key": GEMINI_API_KEY},
                            json=payload,
                            headers={"Content-Type": "application/json"},
                        ) as resp:
                            if resp.status_code == 503 and attempt < max_attempts:
                                # Gemini is briefly overloaded — back off and retry
                                await asyncio.sleep(1.5 * attempt)
                                continue

                            if resp.status_code != 200:
                                body = await resp.aread()
                                yield f"data: {json.dumps({'error': body.decode(errors='ignore')})}\n\n"
                                return

                            async for line in resp.aiter_lines():
                                if not line or not line.startswith("data:"):
                                    continue
                                raw = line[len("data:"):].strip()
                                if raw == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(raw)
                                    text = (
                                        chunk.get("candidates", [{}])[0]
                                        .get("content", {})
                                        .get("parts", [{}])[0]
                                        .get("text", "")
                                    )
                                except (json.JSONDecodeError, IndexError, KeyError):
                                    continue
                                if text:
                                    started_streaming = True
                                    yield f"data: {json.dumps({'text': text})}\n\n"
                        break  # stream completed successfully
                    except httpx.HTTPError:
                        if started_streaming or attempt == max_attempts:
                            raise
                        await asyncio.sleep(1.5 * attempt)
            except httpx.HTTPError as exc:
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/quiz/generate")
async def quiz_generate(req: QuizRequest):
    require_api_key()
    data = await call_gemini_generate(build_quiz_prompt(req))
    return extract_json_text(data)


@app.post("/api/quiz/grade")
async def quiz_grade(req: GradeRequest):
    require_api_key()
    data = await call_gemini_generate(build_grade_prompt(req))
    return extract_json_text(data)


@app.post("/api/flashcards/generate")
async def flashcards_generate(req: FlashcardRequest):
    require_api_key()
    data = await call_gemini_generate(build_flashcard_prompt(req))
    return extract_json_text(data)


@app.post("/api/plan/generate")
async def plan_generate(req: StudyPlanRequest):
    require_api_key()
    data = await call_gemini_generate(build_plan_prompt(req))
    return extract_json_text(data)


# ---------------------------------------------------------------------------
# Static frontend (served last so /api/* routes above take priority)
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
