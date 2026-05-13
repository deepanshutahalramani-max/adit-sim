# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json .
RUN npm install
COPY frontend/ .
RUN npm run build

# Stage 2: Python backend + embedded frontend
FROM python:3.11-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
# Place built frontend where FastAPI's static mount expects it
COPY --from=frontend-builder /frontend/dist /frontend/dist
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
