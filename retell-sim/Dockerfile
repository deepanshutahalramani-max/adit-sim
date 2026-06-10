# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ .
RUN npm run build

# Stage 2: FastAPI backend + embedded React
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY real_phone.py .
COPY --from=frontend-builder /frontend/dist /app/frontend/dist

EXPOSE 8000
HEALTHCHECK CMD curl --fail http://localhost:${PORT:-8000}/api/health || exit 1
CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}
