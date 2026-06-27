FROM python:3.11-slim
WORKDIR /app
# 用范围版依赖,绕开 backend/requirements.txt 里装不上的死钉(fastapi==0.137.1)
RUN pip install --no-cache-dir "fastapi>=0.115,<1" "uvicorn[standard]>=0.30,<1" "pywebpush>=2,<3" "py-vapid>=1.9,<2"
COPY backend /app/backend
COPY web /app/web
COPY server.py /app/server.py
ENV RELAY_PUBLIC_PREFIX=/relay
EXPOSE 8080
CMD ["sh","-c","uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
