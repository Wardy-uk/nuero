FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY remote ./remote
USER node
EXPOSE 3100
CMD ["node", "remote/index.js"]
