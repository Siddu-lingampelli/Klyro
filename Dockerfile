# Klyro Docker image (production, deps + build only).
#
# Build:  docker build -t klyro .
# Run:    docker run --rm klyro --help
#
# KLYRO_* env passthrough: the image passes through the host environment at
# `docker run` time — no secrets are baked in. Forward whatever the CLI needs:
#   docker run --rm \
#     -e KLYRO_API_KEY -e KLYRO_MODEL -e KLYRO_PROVIDER -e KLYRO_BASE_URL \
#     -e KLYRO_CONFIG_DIR -e KLYRO_LOG_LEVEL -e KLYRO_LOG_DIR \
#     -e KLYRO_TELEMETRY -e KLYRO_NO_UPDATE_CHECK \
#     -e ANTHROPIC_API_KEY -e OPENAI_API_KEY \
#     -e HTTP_PROXY -e HTTPS_PROXY -e NO_PROXY \
#     klyro --help
# Or `docker run --rm --env-file .env klyro ...`.
# Mount the working tree to give the agent something to work on:
#   docker run --rm -v "$PWD:/work" -w /work klyro ...
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Full install first: devDeps (typescript) are required for the build step.
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev
ENTRYPOINT ["node", "dist/index.js"]
