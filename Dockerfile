# QuizTutor AI — single container serving FastAPI backend + static frontend
FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# App Runner / most container platforms expect the app to listen on 8080
ENV PORT=8080
EXPOSE 8080

# GEMINI_API_KEY and GEMINI_MODEL are injected at runtime as env vars —
# never baked into the image.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT}"]
