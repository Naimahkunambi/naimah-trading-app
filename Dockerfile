FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /app/data
CMD ["node", "worker-server.mjs"]
