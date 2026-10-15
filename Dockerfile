FROM python:3.12-slim

WORKDIR /app

COPY server.py start_gathering_scans.py ./
COPY pc_worker ./pc_worker
COPY web ./web

RUN pip install --no-cache-dir numpy && \
    mkdir -p /app/data/reports /app/data/contours /app/data/thumbnails

EXPOSE 8095

CMD ["python", "server.py"]
