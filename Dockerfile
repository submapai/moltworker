FROM docker.io/cloudflare/sandbox:0.7.0

# Install Node.js 22 (required by OpenClaw) and rsync (for R2 backup sync)
# The base image has Node 20, we need to replace it with Node 22
# Using direct binary download for reliability
ENV NODE_VERSION=22.13.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates rsync \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Install OpenClaw (formerly clawdbot/moltbot)
# Pin to specific version for reproducible builds
RUN npm install -g openclaw@2026.2.14 \
    && openclaw --version

# Create OpenClaw runtime directories
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/clawd \
    && mkdir -p /root/clawd/skills

# Copy Bloo.io channel plugin (registered at runtime via start-openclaw.sh config patch)
# Source of truth now lives under the nested channels submodule.
COPY submodules/channels/blooio/ /root/.openclaw/plugins/blooio/
RUN cd /root/.openclaw/plugins/blooio && npm install --omit=dev 2>/dev/null || true

# Copy Linq channel plugin (registered at runtime via start-openclaw.sh config patch)
COPY submodules/channels/linq/ /root/.openclaw/plugins/linq/
RUN cd /root/.openclaw/plugins/linq && npm install --omit=dev 2>/dev/null || true

# Copy Email channel plugin (registered at runtime via start-openclaw.sh config patch)
COPY submodules/channels/email/ /root/.openclaw/plugins/email/
RUN cd /root/.openclaw/plugins/email && npm install --omit=dev 2>/dev/null || true

# Copy startup script
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
RUN chmod +x /usr/local/bin/start-openclaw.sh

# Copy custom skills
COPY skills/ /root/clawd/skills/

# Set working directory
WORKDIR /root/clawd

# Expose the gateway port
EXPOSE 18789
