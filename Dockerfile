# Stage 1: Compile gathering_scans_rs native wheel
FROM python:3.12-slim AS rust-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential pkg-config && \
    curl https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable --profile minimal && \
    pip install --no-cache-dir maturin
ENV PATH="/root/.cargo/bin:${PATH}"
COPY rust_core /build/rust_core
RUN maturin build --release --manifest-path /build/rust_core/Cargo.toml --out /build/dist

# Stage 2: Production runtime
FROM python:3.12-slim

WORKDIR /app

COPY --from=rust-builder /build/dist/*.whl /tmp/wheels/
RUN pip install --no-cache-dir numpy scipy /tmp/wheels/*.whl && \
    rm -rf /tmp/wheels && \
    mkdir -p /app/data/reports /app/data/contours /app/data/thumbnails

COPY server.py start_gathering_scans.py ./
COPY pc_worker ./pc_worker
COPY web ./web

EXPOSE 8095

CMD ["python", "server.py"]
