FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

# O Render injeta PORT automaticamente
EXPOSE 10000

CMD ["node", "index.js"]
