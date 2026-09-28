# Dockerfile for Phone Backup Server & Celery Workers
FROM python:3.11-slim

# Install system dependencies & FFmpeg for video transcoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libheif-dev \
    libmagic1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements-server.txt .
RUN pip install --no-cache-dir -r requirements-server.txt

# Copy application source code
COPY . .

# Create persistent data directories
RUN mkdir -p /app_data /backup_storage /host_g /host_c /host_d

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

CMD ["sh", "-c", "exec gunicorn server:app --workers ${GUNICORN_WORKERS:-4} --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000 --timeout 300 --keep-alive 15 --worker-tmp-dir /dev/shm --max-requests ${GUNICORN_MAX_REQUESTS:-10000} --max-requests-jitter ${GUNICORN_MAX_REQUESTS_JITTER:-1000}"]
