# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
EXPOSE 3004
USER node
CMD ["node", "server.js"]
