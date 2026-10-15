FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir numpy && \
    mkdir -p /app/data/reports /app/data/contours /app/data/thumbnails

COPY server.py start_gathering_scans.py ./
COPY pc_worker ./pc_worker
COPY web ./web

EXPOSE 8095

CMD ["python", "server.py"]
