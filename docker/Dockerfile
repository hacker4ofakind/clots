FROM node:24-trixie-slim

# gh comes from GitHub's own repository: Debian's stays on the version it froze.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends git gh ripgrep \
      iputils-ping procps tree file \
 && rm -rf /var/lib/apt/lists/*

# The installer puts Claude Code in the installing user's home. A Clot's home is
# a volume that would hide it, so the binary moves to /usr/local/bin, and the
# image, not the Clot, decides the version.
WORKDIR /tmp
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && install -m 755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
 && rm -rf /root/.local /root/.claude /root/.claude.json
ENV DISABLE_AUTOUPDATER=1

RUN useradd -m -u 1001 clot \
 && mkdir -p /workspace \
 && chown clot:clot /workspace

USER clot
WORKDIR /workspace
CMD ["sleep", "infinity"]
