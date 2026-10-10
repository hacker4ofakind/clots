FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git gh ca-certificates curl ripgrep \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -u 1001 clot \
 && mkdir -p /workspace \
 && chown clot:clot /workspace

USER clot
WORKDIR /workspace
CMD ["sleep", "infinity"]
