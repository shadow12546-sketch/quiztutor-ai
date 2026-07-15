# QuizTutor AI

A general-purpose AI tutor + quiz generator. FastAPI backend, streamed Gemini
responses over Server-Sent Events, vanilla JS/CSS frontend, packaged as a
single Docker container and deployed to AWS App Runner.

## Features

- **Structured tutor chat** — click "Start lesson" for a guided walkthrough
  of a topic, or ask questions freely; answers stream in and are grounded in
  teaching best practices (one idea at a time, examples, comprehension
  check-ins).
- **Quiz generator** — multiple choice, true/false, or short answer (graded
  by Gemini for understanding, not just exact wording). Quizzes are grounded
  in what was actually covered in the tutor chat when available.
- **Adaptive difficulty** — the next quiz on a subject auto-suggests an
  easier/harder level based on your last score there.
- **Flashcards** — auto-generated flip-card decks for active recall.
- **Study plans** — day-by-day learning plans for a subject and time budget.
- **Progress dashboard** — per-subject quiz history, averages, and best
  scores, stored locally in your browser.
- **Voice input** — speak questions to the tutor (browser Web Speech API).
- **Multi-language** — tutor, quizzes, flashcards, and plans can respond in
  several languages.
- **Light/dark theme**, **exportable chat transcripts**, **printable quiz
  results**, keyboard shortcuts (Enter to send, number keys to pick quiz
  options), and a per-IP rate limiter protecting your Gemini quota.

## Project structure

```
project/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── __init__.py
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── Dockerfile
├── .dockerignore
├── .gitignore
└── .env.example
```

---

## 1. Get a Gemini API key (free)

1. Go to https://aistudio.google.com/app/apikey
2. Sign in with a Google account and click **Create API key**.
3. Copy the key — the free tier has generous rate limits and needs no
   credit card, which is why this project uses `gemini-2.5-flash`.

---

## 2. Run locally

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

pip install -r requirements.txt
```

Create `backend/.env` (copy from `.env.example` at the project root):

```
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash
ALLOWED_ORIGINS=*
RATE_LIMIT_PER_MINUTE=30
```

Run the server:

```bash
uvicorn main:app --reload --port 8000
```

Open **http://localhost:8000** — the backend serves the frontend directly,
so there's nothing else to start.

---

## 3. Run with Docker

From the project root (where the `Dockerfile` lives):

```bash
docker build -t quiztutor-ai .

docker run -p 8080:8080 \
  -e GEMINI_API_KEY=your_gemini_api_key_here \
  -e GEMINI_MODEL=gemini-2.5-flash \
  quiztutor-ai
```

Open **http://localhost:8080**. The key is passed as a runtime environment
variable — it is never baked into the image or written into any file that
gets committed.

---

## 4. Deploy to AWS App Runner

App Runner can build straight from an ECR image. The steps below use the
AWS CLI; swap in the console if you prefer clicking through it.

### 4.1 Push the image to Amazon ECR

```bash
# One-time setup — pick your region and note your account ID
aws configure
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create a repository
aws ecr create-repository --repository-name quiztutor-ai --region $AWS_REGION

# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build, tag, and push
docker build -t quiztutor-ai .
docker tag quiztutor-ai:latest $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/quiztutor-ai:latest
docker push $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/quiztutor-ai:latest
```

### 4.2 Create the App Runner service

Console path: **AWS App Runner → Create service → Container registry →
Amazon ECR** → select the `quiztutor-ai:latest` image.

- **Deployment trigger**: Manual (or Automatic if you want new pushes to
  redeploy automatically)
- **Port**: `8080`
- **Environment variables** (Configure service → Environment variables):
  - `GEMINI_API_KEY` = your key — mark it as a **secret** if offered, or
    reference it from **AWS Secrets Manager** for production use
  - `GEMINI_MODEL` = `gemini-2.5-flash`
  - `ALLOWED_ORIGINS` = your App Runner URL once you have it (e.g.
    `https://xxxx.us-east-1.awsapprunner.com`) — tightens CORS from the
    local-dev default of `*`
  - `RATE_LIMIT_PER_MINUTE` = `30` (or your preferred cap)
- **CPU/Memory**: 1 vCPU / 2 GB is plenty for this workload

Or via CLI, using an `apprunner.json` config referencing the image and env vars:

```bash
aws apprunner create-service \
  --service-name quiztutor-ai \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "'"$ACCOUNT_ID"'.dkr.ecr.'"$AWS_REGION"'.amazonaws.com/quiztutor-ai:latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "8080",
        "RuntimeEnvironmentVariables": {
          "GEMINI_MODEL": "gemini-2.5-flash"
        },
        "RuntimeEnvironmentSecrets": {
          "GEMINI_API_KEY": "arn:aws:secretsmanager:'"$AWS_REGION"':'"$ACCOUNT_ID"':secret:gemini-api-key"
        }
      }
    },
    "AutoDeploymentsEnabled": false
  }'
```

(Storing the key in **Secrets Manager** and referencing its ARN, as above,
is the recommended production pattern — App Runner also accepts a plain
`RuntimeEnvironmentVariables` entry for the key if you want to keep it
simpler for a course project.)

App Runner provisions the service and gives you a public URL like:

```
https://xxxxxxxxxx.us-east-1.awsapprunner.com
```

That URL is your live, HTTPS-secured deployment.

### 4.3 Verify

```bash
curl https://<your-app-runner-url>/api/health
```

Should return `{"status":"ok","model":"gemini-2.5-flash","key_configured":true}`.

---

## 5. Security notes (for the write-up)

- The Gemini key is read only from `os.environ` in `backend/main.py` — it
  never appears in any frontend file or client-side network request.
- `backend/.env` and `*.env` are excluded via `.gitignore`, so the key is
  never committed to version control; `.env.example` documents the variable
  names without real values.
- The Docker image contains no secrets — they're injected at container
  runtime, matching the twelve-factor app convention.
- CORS is left open (`allow_origins=["*"]`) only because the frontend and
  API are served from the same origin in production; if you split them
  onto separate domains, restrict this to the actual frontend origin.
