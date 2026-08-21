# Stage 1: Build the client
FROM node:24-slim as client

WORKDIR /app

COPY Client/package*.json ./

RUN npm install --no-audit --no-fund

COPY Client/ .

RUN npm run build

# Stage 2: Build the server
FROM node:24-slim as server

WORKDIR /app

# Install build dependencies for compiling native C++ Node packages (faiss-node, better-sqlite3)
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./

RUN npm install --no-audit --no-fund

COPY server/ .

RUN npm run build

# Prune devDependencies to keep the image lightweight
RUN npm prune --production

# Stage 3: Final production image
FROM node:24-slim

WORKDIR /app

# Copy production files and node modules (containing natively compiled packages)
COPY --from=server /app/package*.json ./
COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY --from=client /app/dist ./public

# Copy compiled FAISS index and SQLite metadata into final container
COPY indexing/indexes/aligned_english* ./indexes/aligned_english/

ENV NODE_ENV=production

CMD ["npm", "start"]