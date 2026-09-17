# Build on the act Ubuntu image selected by digest by the operator.
ARG RUNNER_IMAGE
FROM ${RUNNER_IMAGE}
ARG RUST_VERSION=1.89.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libssl-dev clang cmake protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/craftingtable/rustup
ENV CARGO_HOME=/opt/craftingtable/cargo
ENV PATH=/opt/craftingtable/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain ${RUST_VERSION} \
    && rustup component add rustfmt clippy --toolchain ${RUST_VERSION} \
    && rm /tmp/rustup-init.sh
