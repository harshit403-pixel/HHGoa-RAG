FROM node:24-alpine as client

WORKDIR /app

COPY client/package*.json ./

RUN npm install

COPY client/ .

RUN npm run build

FROM node:24-alpine as server

WORKDIR /app

COPY server/package*.json ./

RUN npm install

COPY server/ .

RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY --from=server /app/dist ./

COPY --from=client /app/dist ./public

# Copy index files from the indexing workspace folder into the final container
COPY indexing/indexes/aligned_english* ./indexes/aligned_english/

EXPOSE 3000

CMD ["npm", "start"]